import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAccountStore } from "../server/accountStore.mjs";
import { applyCatalogMigration, bootstrapSharedContentRoot, createCatalogRepository } from "../server/catalog/index.mjs";
import { createJobsRepository } from "../server/jobs/repository.mjs";
import { migrateJobsSchema } from "../server/jobs/schema.mjs";
import { createPartyRepository } from "../server/party/repository.mjs";
import { partyMigration } from "../server/party/schema.mjs";
import { createPartyService } from "../server/party/service.mjs";
import { createPlaybackRepository } from "../server/playback/repository.mjs";
import { migratePlaybackSchema } from "../server/playback/schema.mjs";

test("account activity writes are throttled and stale credentials are pruned", async () => {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const database = new DatabaseSync(":memory:");
  const store = await createAccountStore({
    credentialRetentionMs: 24 * 60 * 60 * 1000,
    database,
    now: () => clock,
    sessionTouchIntervalMs: 60_000
  });
  const setup = await store.setupOwner({
    clientLabel: "test", displayName: "Owner", password: "correct horse battery", username: "owner"
  });
  const initial = database.prepare("SELECT last_seen_at FROM sessions WHERE id = ?").get(setup.session.id).last_seen_at;
  clock += 30_000;
  assert.ok(store.authenticateSession(setup.session.token));
  assert.equal(database.prepare("SELECT last_seen_at FROM sessions WHERE id = ?").get(setup.session.id).last_seen_at, initial);
  clock += 31_000;
  assert.ok(store.authenticateSession(setup.session.token));
  assert.notEqual(database.prepare("SELECT last_seen_at FROM sessions WHERE id = ?").get(setup.session.id).last_seen_at, initial);
  store.revokeSession(setup.user.id, setup.session.id);
  clock += 2 * 24 * 60 * 60 * 1000;
  assert.equal(store.pruneCredentials().sessions, 1);
  database.close();
});

test("playback maintenance bounds old events and sessions without deleting state", () => {
  let clock = Date.parse("2026-02-01T00:00:00.000Z");
  const database = new DatabaseSync(":memory:");
  migratePlaybackSchema(database);
  const repository = createPlaybackRepository({ db: database, now: () => clock, retentionDays: 7 });
  const eventId = randomUUID();
  const sessionId = randomUUID();
  const itemId = randomUUID();
  repository.recordEvent({
    applyProgress: true, clientLabel: "test", completed: false, durationSeconds: 100,
    event: "start", eventId, itemId, positionSeconds: 0, recordedAt: new Date(clock).toISOString(),
    sessionId, sourceId: randomUUID(), userId: "user-a"
  });
  clock += 8 * 24 * 60 * 60 * 1000;
  const removed = repository.prune();
  assert.equal(removed.localEventsByAge, 1);
  assert.equal(removed.localSessions, 1);
  assert.ok(repository.getState("user-a", itemId));
  database.close();
});

test("job lanes reserve interactive work while retaining normal priority", () => {
  const database = new DatabaseSync(":memory:");
  migrateJobsSchema(database);
  const repository = createJobsRepository({ db: database, now: () => Date.parse("2026-01-01T00:00:00.000Z") });
  const maintenance = repository.enqueue({ type: "scan" }).job;
  const interactive = repository.enqueue({ type: "rendition" }).job;
  assert.equal(repository.claimNext({ lane: "interactive" }).id, interactive.id);
  assert.equal(repository.claimNext({ lane: "maintenance" }).id, maintenance.id);
  assert.throws(() => repository.claimNext({ lane: "unknown" }), /lane/);
  database.close();
});

test("catalog reconciliation commits bounded batches and remains idempotent", () => {
  const database = new DatabaseSync(":memory:");
  applyCatalogMigration(database);
  const repository = createCatalogRepository(database, { scanBatchSize: 10 });
  const { root } = bootstrapSharedContentRoot(repository, {
    contentRoot: "/content", libraryId: randomUUID(), rootId: randomUUID()
  });
  const files = Array.from({ length: 25 }, (_, index) => ({
    fileKey: `device:${index}`, itemType: "movie", mediaKind: "video",
    modifiedMs: index, path: `Movies/${index}.mp4`, size: 100 + index, title: `Movie ${index}`
  }));
  assert.equal(repository.reconcileScan({ files, rootId: root.id }).new, 25);
  assert.equal(repository.reconcileScan({ files, rootId: root.id }).unchanged, 25);
  assert.equal(repository.listItems({ availability: "available" }).length, 25);
  database.close();
});

test("Party enforces conversation, account, and server attachment quotas", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0
  ) STRICT;`);
  const users = ["owner", "member"].map((username) => ({
    disabled: false, displayName: username, id: randomUUID(), role: username === "owner" ? "owner" : "member", username
  }));
  for (const user of users) database.prepare(
    "INSERT INTO users (id, username, display_name, disabled) VALUES (?, ?, ?, 0)"
  ).run(user.id, user.username, user.displayName);
  partyMigration.apply(database);
  const repository = createPartyRepository({ database });
  const service = createPartyService({
    listUsers: () => users,
    maxConversationAttachmentBytes: 100,
    maxGlobalAttachmentBytes: 100,
    maxUserAttachmentBytes: 50,
    repository
  });
  const context = { kind: "account", user: users[0] };
  const direct = service.createDirect({ userId: users[1].id }, context).conversation;
  const metadata = (sizeBytes, suffix) => ({
    conversationId: direct.id, displayName: `${suffix}.png`, id: randomUUID(), mimeType: "image/png",
    sha256: suffix.repeat(64).slice(0, 64), sizeBytes, storageKey: `ab/cd/${suffix}.blob`, uploaderUserId: users[0].id
  });
  service.createAttachmentMessage(direct.id, metadata(40, "a"), "first", context);
  assert.deepEqual(repository.getAttachmentUsage({ conversationId: direct.id, userId: users[0].id }), {
    conversationBytes: 40, globalBytes: 40, userBytes: 40
  });
  assert.throws(
    () => service.createAttachmentMessage(direct.id, metadata(20, "b"), "second", context),
    (error) => error.code === "attachment_user_quota_exceeded"
  );
  database.close();
});
