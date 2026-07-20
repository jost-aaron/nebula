import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";
import { createPlaybackRepository } from "../server/playback/repository.mjs";
import {
  FEDERATED_PLAYBACK_SCHEMA_SQL, migratePlaybackSchema, PLAYBACK_MIGRATION, PLAYBACK_SCHEMA_SQL, PLAYBACK_SCHEMA_VERSION
} from "../server/playback/schema.mjs";
import { createPlaybackService } from "../server/playback/service.mjs";

const principal = (userId = "user-a") => ({ type: "user", userId });
const localIdentity = () => ({ itemId: randomUUID(), sourceId: randomUUID() });
const federatedIdentity = (suffix = "alpha") => ({ itemId: `fitem_${suffix}`, sourceId: `fsource_${suffix}` });

const fixture = ({ federatedVisibilityFilter = null, now = () => Date.now(), validator = async () => true, visibilityFilter = null } = {}) => {
  const db = new DatabaseSync(":memory:");
  migratePlaybackSchema(db);
  const repository = createPlaybackRepository({ db });
  const service = createPlaybackService({ federatedIdentityValidator: validator, federatedVisibilityFilter, now, repository, visibilityFilter });
  return { db, repository, service };
};

const startFederated = (service, identity, user = principal(), extra = {}) => service.recordEvent({
  clientLabel: "Federated test player", durationSeconds: 100, event: "start", eventId: randomUUID(),
  federatedIdentity: identity, positionSeconds: 0, sessionId: null, ...extra
}, user);

const federatedEvent = (service, started, event, positionSeconds, user = principal(), extra = {}) => service.recordEvent({
  durationSeconds: 100, event, eventId: randomUUID(), federatedIdentity: started.state.federatedIdentity,
  positionSeconds, sessionId: started.session.id, ...extra
}, user);

const startLocal = (service, identity, user = principal(), extra = {}) => service.recordEvent({
  ...identity, clientLabel: "Local test player", durationSeconds: 100, event: "start", eventId: randomUUID(),
  positionSeconds: 0, sessionId: null, ...extra
}, user);

const localEvent = (service, started, event, positionSeconds, user = principal(), extra = {}) => service.recordEvent({
  durationSeconds: 100, event, eventId: randomUUID(), itemId: started.state.itemId,
  positionSeconds, sessionId: started.session.id, sourceId: started.session.sourceId, ...extra
}, user);

test("federated playback schema is an additive centrally composable v2 migration", () => {
  assert.equal(PLAYBACK_SCHEMA_VERSION, 2);
  assert.equal(PLAYBACK_MIGRATION.id, "playback-v2");
  assert.doesNotMatch(FEDERATED_PLAYBACK_SCHEMA_SQL, /PRAGMA|user_version/i);
  const db = new DatabaseSync(":memory:");
  db.exec(PLAYBACK_SCHEMA_SQL);
  const itemId = randomUUID();
  db.prepare(`INSERT INTO playback_states
    (user_id, item_id, position_seconds, completed, play_count, updated_at)
    VALUES ('user-a', ?, 12, 0, 0, '2026-01-01T00:00:00.000Z')`).run(itemId);
  applyDomainMigrations(db, [PLAYBACK_MIGRATION]);
  assert.equal(db.prepare("SELECT position_seconds FROM playback_states WHERE item_id = ?").get(itemId).position_seconds, 12);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'federated_playback_states'").get());
  assert.ok(db.prepare("SELECT 1 FROM nebula_domain_migrations WHERE migration_id = 'playback-v2'").get());
  db.close();
});

test("federated requests are explicit, mutually exclusive, bounded, and fail closed without validation", async (t) => {
  const db = new DatabaseSync(":memory:");
  migratePlaybackSchema(db);
  const repository = createPlaybackRepository({ db });
  t.after(() => db.close());
  const withoutValidator = createPlaybackService({ repository });
  await assert.rejects(() => startFederated(withoutValidator, federatedIdentity()), { status: 404 });

  const denied = createPlaybackService({ federatedIdentityValidator: async () => false, repository });
  await assert.rejects(() => startFederated(denied, federatedIdentity()), { status: 404 });

  const service = createPlaybackService({ federatedIdentityValidator: async () => true, repository });
  await assert.rejects(() => service.recordEvent({
    durationSeconds: 100, event: "start", eventId: randomUUID(), federatedIdentity: federatedIdentity(),
    itemId: randomUUID(), positionSeconds: 0, sessionId: null, sourceId: randomUUID()
  }, principal()), /mutually exclusive/);
  await assert.rejects(() => startFederated(service, { itemId: "../shard/path", sourceId: "source" }), { status: 400 });
  await assert.rejects(() => startFederated(service, { itemId: "fitem", sourceId: "fsource", shardLocalPath: "/secret" }), { status: 400 });
});

test("validator receives only coordinator federated identity and principal for every event", async (t) => {
  const calls = [];
  const { db, service } = fixture({ validator: async (identity, actor) => { calls.push({ actor, identity }); return true; } });
  t.after(() => db.close());
  const identity = federatedIdentity("validated");
  const started = await startFederated(service, identity);
  await federatedEvent(service, started, "pause", 10);
  assert.deepEqual(calls, [
    { actor: principal(), identity },
    { actor: principal(), identity }
  ]);
  assert.equal(JSON.stringify(started).includes("localItemId"), false);
  assert.equal(JSON.stringify(started).includes("localSourceId"), false);
  assert.equal(JSON.stringify(started).includes("/app/content"), false);
});

test("federated lifecycle, completion, coalescing, and idempotency match local playback", async (t) => {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const { db, service } = fixture({ now: () => clock });
  t.after(() => db.close());
  const started = await startFederated(service, federatedIdentity("lifecycle"));
  assert.equal(started.session.identityKind, "federated");
  assert.equal(started.session.state, "active");
  clock += 1_000;
  const coalesced = await federatedEvent(service, started, "progress", 5);
  assert.equal(coalesced.state.positionSeconds, 0);
  assert.equal(db.prepare("SELECT applied FROM federated_playback_events WHERE event_kind = 'progress'").get().applied, 0);
  assert.equal((await federatedEvent(service, started, "pause", 10)).session.state, "paused");
  assert.equal((await federatedEvent(service, started, "progress", 20)).session.state, "active");

  const completeRequest = {
    durationSeconds: 100, event: "complete", eventId: randomUUID(), federatedIdentity: started.state.federatedIdentity,
    positionSeconds: 100, sessionId: started.session.id
  };
  const completed = await service.recordEvent(completeRequest, principal());
  const retry = await service.recordEvent(completeRequest, principal());
  assert.equal(completed.state.completed, true);
  assert.equal(completed.state.positionSeconds, 0);
  assert.equal(completed.state.playCount, 1);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.state.playCount, 1);
  await assert.rejects(() => federatedEvent(service, started, "progress", 99), { status: 409 });
  await assert.rejects(() => service.recordEvent({ ...completeRequest, positionSeconds: 99 }, principal()), { status: 409 });
});

test("federated sessions and state remain isolated by account", async (t) => {
  const { db, service } = fixture();
  t.after(() => db.close());
  const identity = federatedIdentity("private");
  const started = await startFederated(service, identity);
  await federatedEvent(service, started, "pause", 35);
  assert.equal(service.getFederatedState(identity, principal("user-b")), null);
  assert.equal(service.getSession(started.session.id, principal("user-b")), null);
  assert.deepEqual(service.listContinueWatching({}, principal("user-b")), []);
  await assert.rejects(() => federatedEvent(service, started, "progress", 40, principal("user-b")), { status: 404 });
  assert.equal(service.listContinueWatching({}, principal())[0].positionSeconds, 35);
});

test("federated history and resume state fail closed after library permission revocation", async (t) => {
  let allowed = true;
  const { db, service } = fixture({ federatedVisibilityFilter: () => allowed });
  t.after(() => db.close());
  const identity = federatedIdentity("permissioned");
  const started = await startFederated(service, identity);
  await federatedEvent(service, started, "pause", 35);
  assert.equal(service.getFederatedState(identity, principal()).positionSeconds, 35);
  assert.equal(service.listContinueWatching({}, principal()).length, 1);
  allowed = false;
  assert.equal(service.getFederatedState(identity, principal()), null);
  assert.deepEqual(service.listContinueWatching({}, principal()), []);
  assert.deepEqual(service.listHistory({}, principal()), []);
});

test("local and federated playback merge deterministically without weakening local visibility", async (t) => {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const hiddenLocal = localIdentity();
  const { db, service } = fixture({
    now: () => clock,
    visibilityFilter: (entry) => entry.itemId !== hiddenLocal.itemId
  });
  t.after(() => db.close());
  const visible = await startLocal(service, localIdentity());
  await localEvent(service, visible, "pause", 10);
  clock += 1_000;
  const hidden = await startLocal(service, hiddenLocal);
  await localEvent(service, hidden, "pause", 20);
  clock += 1_000;
  const remote = await startFederated(service, federatedIdentity("remote"));
  await federatedEvent(service, remote, "pause", 30);
  clock += 1_000;
  const completed = await startFederated(service, federatedIdentity("done"));
  await federatedEvent(service, completed, "complete", 100);

  assert.deepEqual(service.listContinueWatching({}, principal()).map((entry) => [entry.identityKind, entry.itemId]), [
    ["federated", remote.state.itemId], ["local", visible.state.itemId]
  ]);
  assert.deepEqual(service.listHistory({}, principal()).map((entry) => [entry.identityKind, entry.itemId]), [
    ["federated", completed.state.itemId], ["federated", remote.state.itemId], ["local", visible.state.itemId]
  ]);
  assert.deepEqual(service.listHistory({ limit: 1 }, principal()).map((entry) => entry.itemId), [completed.state.itemId]);
});

test("event and session idempotency keys cannot collide across local and federated domains", async (t) => {
  const { db, service } = fixture();
  t.after(() => db.close());
  const sharedEventId = randomUUID();
  await startLocal(service, localIdentity(), principal(), { eventId: sharedEventId });
  await assert.rejects(() => startFederated(service, federatedIdentity("event-collision"), principal(), { eventId: sharedEventId }), { status: 409 });

  const sharedSessionId = randomUUID();
  await startLocal(service, localIdentity(), principal(), { sessionId: sharedSessionId });
  await assert.rejects(() => startFederated(service, federatedIdentity("session-collision"), principal(), { sessionId: sharedSessionId }), { status: 404 });
});
