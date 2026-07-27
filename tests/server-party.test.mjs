import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";
import {
  createPartyEvents,
  createPartyRepository,
  createPartyRoutes,
  createPartyService,
  partyMigration
} from "../server/party/index.mjs";

const createFixture = () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
    ) STRICT;
  `);
  const users = [
    { disabled: false, displayName: "Ada Owner", id: randomUUID(), role: "owner", username: "ada" },
    { disabled: false, displayName: "Bex Member", id: randomUUID(), role: "member", username: "bex" },
    { disabled: false, displayName: "Cy Member", id: randomUUID(), role: "member", username: "cy" },
    { disabled: true, displayName: "Disabled", id: randomUUID(), role: "member", username: "disabled" }
  ];
  const insert = database.prepare(
    "INSERT INTO users (id, username, display_name, disabled) VALUES (?, ?, ?, ?)"
  );
  for (const user of users) insert.run(user.id, user.username, user.displayName, user.disabled ? 1 : 0);
  applyDomainMigrations(database, [partyMigration]);
  const repository = createPartyRepository({ database });
  let tick = 0;
  const published = [];
  const audit = [];
  const service = createPartyService({
    audit: { recordBestEffort: (event) => { audit.push(event); return true; } },
    events: { publish: (conversationId) => published.push(conversationId) },
    listUsers: () => users,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    repository
  });
  const context = (index) => ({
    kind: "account",
    principalId: users[index].id,
    user: { ...users[index], disabled: users[index].disabled }
  });
  return { audit, context, database, published, repository, service, users };
};

test("Party migration is strict, idempotent, indexed, and preserves applied state", () => {
  const fixture = createFixture();
  applyDomainMigrations(fixture.database, [partyMigration]);
  assert.equal(fixture.database.prepare(
    "SELECT COUNT(*) AS count FROM nebula_domain_migrations WHERE migration_id = 'party-v1'"
  ).get().count, 1);
  assert.equal(fixture.database.prepare(
    "SELECT strict FROM pragma_table_list WHERE name = 'party_messages'"
  ).get().strict, 1);
  const indexes = fixture.database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'party_%'"
  ).all().map(({ name }) => name);
  assert.ok(indexes.includes("party_messages_conversation_sequence"));
  assert.throws(() => fixture.database.prepare(`INSERT INTO party_conversations
    (id, kind, direct_key, title, created_by_user_id, created_at, updated_at)
    VALUES (?, 'direct', NULL, 'bad', ?, ?, ?)`).run(
      randomUUID(), fixture.users[0].id, new Date().toISOString(), new Date().toISOString()
    ), /constraint/i);
  fixture.database.close();
});

test("Party canonicalizes direct conversations and minimizes enabled user discovery", () => {
  const fixture = createFixture();
  const first = fixture.service.createDirect({ userId: fixture.users[1].id }, fixture.context(0));
  const reverse = fixture.service.createDirect({ userId: fixture.users[0].id }, fixture.context(1));
  assert.equal(first.created, true);
  assert.equal(reverse.created, false);
  assert.equal(first.conversation.id, reverse.conversation.id);
  assert.equal(fixture.database.prepare(
    "SELECT COUNT(*) AS count FROM party_conversations WHERE kind = 'direct'"
  ).get().count, 1);
  assert.deepEqual(
    fixture.service.discoverUsers({ query: "cy" }, fixture.context(0)),
    [{ displayName: "Cy Member", id: fixture.users[2].id, username: "cy" }]
  );
  assert.equal(JSON.stringify(fixture.service.discoverUsers({}, fixture.context(0))).includes("role"), false);
  assert.equal(JSON.stringify(fixture.service.discoverUsers({}, fixture.context(0))).includes("disabled"), false);
  assert.throws(
    () => fixture.service.createDirect({ userId: fixture.users[3].id }, fixture.context(0)),
    (error) => error.status === 404
  );
  assert.throws(
    () => fixture.service.listConversations({}, { kind: "service", user: null }),
    (error) => error.code === "party_account_required"
  );
  fixture.database.close();
});

test("Party group owner and administrator permissions are bounded and audited without content", () => {
  const fixture = createFixture();
  const group = fixture.service.createGroup({
    memberIds: [fixture.users[1].id],
    title: "Launch crew"
  }, fixture.context(0));
  assert.equal(group.members.find(({ id }) => id === fixture.users[0].id).role, "owner");
  assert.equal(group.members.find(({ id }) => id === fixture.users[1].id).role, "member");
  assert.throws(
    () => fixture.service.addMember(group.id, { role: "admin", userId: fixture.users[2].id }, fixture.context(1)),
    (error) => error.status === 403
  );
  fixture.service.addMember(group.id, { userId: fixture.users[2].id }, fixture.context(0));
  fixture.service.updateMemberRole(group.id, fixture.users[1].id, { role: "admin" }, fixture.context(0));
  assert.throws(
    () => fixture.service.removeMember(group.id, fixture.users[0].id, fixture.context(1)),
    (error) => error.code === "party_owner_immutable"
  );
  assert.throws(
    () => fixture.service.updateGroup(group.id, { title: "Nope" }, fixture.context(2)),
    (error) => error.status === 403
  );
  const updated = fixture.service.updateGroup(group.id, { title: "  Ready   crew " }, fixture.context(1));
  assert.equal(updated.title, "Ready crew");
  fixture.service.removeMember(group.id, fixture.users[2].id, fixture.context(1));
  assert.equal(fixture.service.getConversation(group.id, fixture.context(0)).memberCount, 2);
  assert.deepEqual(fixture.audit.map(({ eventType }) => fixture.audit && eventType), [
    "party.group_created",
    "party.member_added",
    "party.member_role_changed",
    "party.group_updated",
    "party.member_removed"
  ]);
  assert.equal(JSON.stringify(fixture.audit).includes("Ready crew"), false);
  fixture.database.close();
});

test("Party messages are idempotent, paginated chronologically, isolated, and track unread state", () => {
  const fixture = createFixture();
  const direct = fixture.service.createDirect(
    { userId: fixture.users[1].id }, fixture.context(0)
  ).conversation;
  for (let index = 1; index <= 4; index += 1) {
    fixture.service.sendMessage(direct.id, {
      clientId: `client-${index}`,
      text: `message ${index}`
    }, fixture.context(index % 2));
  }
  const duplicate = fixture.service.sendMessage(direct.id, {
    clientId: "client-2",
    text: "message 2"
  }, fixture.context(0));
  assert.equal(duplicate.duplicate, true);
  assert.throws(() => fixture.service.sendMessage(direct.id, {
    clientId: "client-2",
    text: "different"
  }, fixture.context(0)), (error) => error.status === 409);

  const latest = fixture.service.listMessages(direct.id, { limit: 2 }, fixture.context(0));
  assert.deepEqual(latest.messages.map(({ sequence }) => sequence), [3, 4]);
  assert.equal(latest.nextCursor, 3);
  const older = fixture.service.listMessages(
    direct.id, { beforeSequence: latest.nextCursor, limit: 2 }, fixture.context(0)
  );
  assert.deepEqual(older.messages.map(({ sequence }) => sequence), [1, 2]);
  assert.equal(older.nextCursor, null);
  assert.equal(fixture.service.getConversation(direct.id, fixture.context(0)).unreadCount, 2);
  const read = fixture.service.markRead(direct.id, { sequence: 999_999 }, fixture.context(0));
  assert.equal(read.lastReadSequence, 4);
  assert.equal(read.unreadCount, 0);
  const publicationsAfterReadAdvance = fixture.published.length;
  fixture.service.markRead(direct.id, { sequence: 4 }, fixture.context(0));
  assert.equal(
    fixture.published.length,
    publicationsAfterReadAdvance,
    "unchanged read state must not create an SSE feedback loop"
  );
  assert.throws(
    () => fixture.service.listMessages(direct.id, {}, fixture.context(2)),
    (error) => error.status === 404
  );
  fixture.database.close();
});

test("Party attachment message commits are scoped, quota checked, and member protected", () => {
  const fixture = createFixture();
  const direct = fixture.service.createDirect(
    { userId: fixture.users[1].id }, fixture.context(0)
  ).conversation;
  const metadata = {
    conversationId: direct.id,
    createdAt: "2026-01-02T00:00:00.000Z",
    displayName: "photo.png",
    id: randomUUID(),
    mimeType: "image/png",
    sha256: "a".repeat(64),
    sizeBytes: 42,
    storageKey: "ab/cd/asset.blob",
    uploaderUserId: fixture.users[0].id
  };
  const result = fixture.service.createAttachmentMessage(
    direct.id, metadata, "upload-1", fixture.context(0)
  );
  assert.equal(result.message.text, "");
  assert.equal(result.message.attachments[0].size, 42);
  assert.equal(fixture.service.getAttachment(metadata.id, fixture.context(1)).storageKey, metadata.storageKey);
  assert.throws(
    () => fixture.service.getAttachment(metadata.id, fixture.context(2)),
    (error) => error.status === 404
  );
  assert.throws(
    () => fixture.service.createAttachmentMessage(direct.id, {
      ...metadata,
      id: randomUUID(),
      storageKey: "ab/cd/other.blob",
      uploaderUserId: fixture.users[1].id
    }, "upload-2", fixture.context(0)),
    (error) => error.status === 403
  );
  fixture.database.close();
});

test("Party SSE emits only opaque hints to current members and tears down connections", () => {
  const allowed = new Set(["conversation-a:user-a"]);
  const events = createPartyEvents({
    heartbeatMs: 60_000,
    isConversationMember: ({ conversationId, userId }) => allowed.has(`${conversationId}:${userId}`)
  });
  const makeStream = () => {
    const request = new EventEmitter();
    const response = new EventEmitter();
    response.chunks = [];
    response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
    response.write = (chunk) => { response.chunks.push(chunk); return true; };
    response.end = () => response.emit("close");
    return { request, response };
  };
  const member = makeStream();
  const outsider = makeStream();
  events.subscribe(member.request, member.response, "user-a");
  events.subscribe(outsider.request, outsider.response, "user-b");
  events.publish("conversation-a");
  assert.match(member.response.chunks.join(""), /"conversationId":"conversation-a"/);
  assert.doesNotMatch(outsider.response.chunks.join(""), /conversation-a/);
  assert.doesNotMatch(member.response.chunks.join(""), /message|text|sender/i);
  allowed.clear();
  events.publish("conversation-a");
  assert.equal((member.response.chunks.join("").match(/conversation-a/g) ?? []).length, 1);
  member.request.emit("close");
  outsider.request.emit("close");
  assert.equal(events.subscriberCount(), 0);
  events.close();
});

test("Party SSE binds account sessions and closes revoked or disabled identities", () => {
  const activeSessions = new Set(["user-a:session-a", "user-b:session-b"]);
  const events = createPartyEvents({
    isConversationMember: () => true,
    isIdentityActive: ({ sessionId, userId }) => activeSessions.has(`${userId}:${sessionId}`),
    revalidateMs: 1
  });
  const makeStream = () => {
    const request = new EventEmitter();
    const response = new EventEmitter();
    response.chunks = [];
    response.ended = false;
    response.writeHead = () => {};
    response.write = (chunk) => { response.chunks.push(chunk); return true; };
    response.end = () => {
      if (response.ended) return;
      response.ended = true;
      response.emit("close");
    };
    return { request, response };
  };
  const identity = (userId, sessionId) => ({
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    kind: "account",
    sessionId,
    user: { disabled: false, id: userId }
  });
  const first = makeStream();
  const second = makeStream();
  events.subscribe(first.request, first.response, identity("user-a", "session-a"));
  events.subscribe(second.request, second.response, identity("user-b", "session-b"));
  assert.equal(events.subscriberCount(), 2);

  activeSessions.delete("user-a:session-a");
  events.publish("conversation-a");
  assert.equal(first.response.ended, true);
  assert.equal(events.subscriberCount(), 1);
  assert.match(second.response.chunks.join(""), /conversation-a/);

  events.closeUser("user-b");
  assert.equal(second.response.ended, true);
  assert.equal(events.subscriberCount(), 0);

  const expired = makeStream();
  assert.throws(
    () => events.subscribe(expired.request, expired.response, {
      ...identity("user-a", "session-a"),
      expiresAt: new Date(Date.now() - 1).toISOString()
    }),
    (error) => error.code === "party_event_session_inactive"
  );
  events.close();
});

test("Party HTTP routes expose the bounded contract and fail closed across accounts", async (t) => {
  const fixture = createFixture();
  const routes = createPartyRoutes({ service: fixture.service });
  const server = createServer(async (request, response) => {
    const index = Number(request.headers["x-test-user"]);
    request.nebulaAuth = Number.isInteger(index) && fixture.users[index]
      ? fixture.context(index)
      : { kind: "service", user: null };
    try {
      const handled = await routes(request, response, new URL(request.url, "http://party.test"));
      if (!handled) response.writeHead(404).end();
    } catch (error) {
      response.writeHead(error.status ?? 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: error.code, error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fixture.database.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, user, method = "GET", body) => fetch(base + path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(user === null ? {} : { "x-test-user": String(user) })
    },
    method
  });

  const createdResponse = await call("/api/party/direct", 0, "POST", {
    userId: fixture.users[1].id
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.created, true);
  assert.equal(created.conversation.kind, "direct");

  const messageResponse = await call(
    `/api/party/conversations/${created.conversation.id}/messages`,
    0,
    "POST",
    { clientId: "route-message", text: "Hello over HTTP" }
  );
  assert.equal(messageResponse.status, 201);
  assert.equal((await messageResponse.json()).message.sequence, 1);
  const denied = await call(
    `/api/party/conversations/${created.conversation.id}/messages`, 2
  );
  assert.equal(denied.status, 404);
  assert.equal((await denied.json()).code, "conversation_not_found");
  const serviceDenied = await call("/api/party/conversations", null);
  assert.equal(serviceDenied.status, 403);
  assert.equal((await serviceDenied.json()).code, "party_account_required");
});
