import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPlaybackCompatibilityResolver } from "../server/playback/compatibilityResolver.mjs";
import { createPlaybackRepository } from "../server/playback/repository.mjs";
import { migratePlaybackSchema, PLAYBACK_SCHEMA_SQL } from "../server/playback/schema.mjs";
import { createPlaybackService } from "../server/playback/service.mjs";

const ids = () => ({ eventId: randomUUID(), itemId: randomUUID(), sourceId: randomUUID() });
const principal = (userId = "user-a") => ({ type: "user", userId });

const fixture = ({ now = () => Date.now(), compatibilityResolver = null } = {}) => {
  const db = new DatabaseSync(":memory:");
  migratePlaybackSchema(db);
  const repository = createPlaybackRepository({ db });
  const service = createPlaybackService({ compatibilityResolver, now, repository });
  return { db, repository, service };
};

const start = async (service, identity, user = principal(), extra = {}) => service.recordEvent({
  ...identity, clientLabel: "Test player", durationSeconds: 100, event: "start",
  positionSeconds: 0, sessionId: null, ...extra
}, user);

const event = async (service, started, kind, positionSeconds, user = principal(), extra = {}) => service.recordEvent({
  durationSeconds: 100, event: kind, eventId: randomUUID(), itemId: started.state.itemId,
  positionSeconds, sessionId: started.session.id, sourceId: started.session.sourceId, ...extra
}, user);

test("playback schema is centrally composable and repository migration is opt-in", () => {
  assert.doesNotMatch(PLAYBACK_SCHEMA_SQL, /PRAGMA|user_version/i);
  const db = new DatabaseSync(":memory:");
  assert.throws(() => createPlaybackRepository({ db }).getState("user", randomUUID()), /no such table/);
  const repository = createPlaybackRepository({ db, migrate: true });
  assert.equal(repository.getState("user", randomUUID()), null);
  db.close();
});

test("state, sessions, and Continue Watching are strictly isolated by user", async (t) => {
  const { db, service } = fixture();
  t.after(() => db.close());
  const identity = ids();
  const first = await start(service, identity);
  await event(service, first, "pause", 35);
  assert.equal(service.getState(identity.itemId, principal("user-b")), null);
  assert.equal(service.getSession(first.session.id, principal("user-b")), null);
  assert.deepEqual(service.listContinueWatching({}, principal("user-b")), []);
  assert.equal(service.listContinueWatching({}, principal())[0].positionSeconds, 35);
  await assert.rejects(() => event(service, first, "progress", 40, principal("user-b")), { status: 404 });
  await assert.rejects(() => start(service, { ...identity, eventId: randomUUID() }, { type: "service", userId: "service" }), { status: 403 });
});

test("rejects malformed positions, durations, identities, and completion below threshold", async (t) => {
  const { db, service } = fixture();
  t.after(() => db.close());
  const identity = ids();
  for (const request of [
    { ...identity, durationSeconds: 100, event: "start", positionSeconds: -1, sessionId: null },
    { ...identity, eventId: randomUUID(), durationSeconds: 0, event: "start", positionSeconds: 0, sessionId: null },
    { ...identity, eventId: randomUUID(), durationSeconds: 10, event: "start", positionSeconds: 11, sessionId: null },
    { ...identity, eventId: "retry-me", durationSeconds: 10, event: "start", positionSeconds: 1, sessionId: null }
  ]) await assert.rejects(() => service.recordEvent(request, principal()), { status: 400 });

  const started = await start(service, { ...identity, eventId: randomUUID() });
  await assert.rejects(() => event(service, started, "complete", 89), /at least 90%/);
  assert.equal((await event(service, started, "complete", 90)).state.completed, true);
});

test("start, progress, pause, resume, stop, and completion have valid session lifecycles", async (t) => {
  const { db, service } = fixture();
  t.after(() => db.close());
  const first = await start(service, ids());
  assert.equal(first.session.state, "active");
  assert.equal((await event(service, first, "pause", 20)).session.state, "paused");
  assert.equal((await event(service, first, "progress", 30)).session.state, "active");
  const stopped = await event(service, first, "stop", 40);
  assert.equal(stopped.session.state, "stopped");
  assert.equal(stopped.state.completed, false);
  await assert.rejects(() => event(service, first, "progress", 50), { status: 409 });

  const second = await start(service, { ...ids(), itemId: first.state.itemId });
  const completed = await event(service, second, "stop", 90);
  assert.equal(completed.session.state, "stopped");
  assert.equal(completed.state.completed, true);
  assert.equal(completed.state.positionSeconds, 0);
  assert.equal(completed.state.playCount, 1);
});

test("event retries are idempotent and cannot increment play count twice", async (t) => {
  const { db, service } = fixture();
  t.after(() => db.close());
  const started = await start(service, ids());
  const request = {
    durationSeconds: 100, event: "complete", eventId: randomUUID(), itemId: started.state.itemId,
    positionSeconds: 100, sessionId: started.session.id, sourceId: started.session.sourceId
  };
  const first = await service.recordEvent(request, principal());
  const retry = await service.recordEvent(request, principal());
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.state.playCount, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM playback_events").get().count, 2);
  await assert.rejects(() => service.recordEvent({ ...request, positionSeconds: 99 }, principal()), { status: 409 });
});

test("progress is coalesced while pause and stop terminal updates are never lost", async (t) => {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const { db, service } = fixture({ now: () => clock });
  t.after(() => db.close());
  const started = await start(service, ids());
  clock += 1_000;
  const coalesced = await event(service, started, "progress", 5);
  assert.equal(coalesced.state.positionSeconds, 0);
  assert.equal(db.prepare("SELECT applied FROM playback_events WHERE event_kind = 'progress'").get().applied, 0);
  const paused = await event(service, started, "pause", 6);
  assert.equal(paused.state.positionSeconds, 6);
  clock += 1_000;
  const stopped = await event(service, started, "stop", 7);
  assert.equal(stopped.state.positionSeconds, 7);
  assert.equal(stopped.session.state, "stopped");
});

test("Continue Watching is bounded, newest-first, and excludes completed or untouched items", async (t) => {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const { db, service } = fixture({ now: () => clock });
  t.after(() => db.close());
  const old = await start(service, ids());
  await event(service, old, "pause", 20);
  clock += 1_000;
  const recent = await start(service, ids());
  await event(service, recent, "pause", 30);
  clock += 1_000;
  const done = await start(service, ids());
  await event(service, done, "complete", 100);
  await start(service, ids());
  const entries = service.listContinueWatching({ limit: 1 }, principal());
  assert.deepEqual(entries.map(({ itemId }) => itemId), [recent.state.itemId]);
  assert.equal(entries[0].progress, 0.3);
  assert.throws(() => service.listContinueWatching({ limit: 101 }, principal()), { status: 400 });
});

test("compatibility resolver validates paths before translating to canonical IDs", async (t) => {
  const identity = ids();
  const calls = [];
  const resolver = createPlaybackCompatibilityResolver({
    resolveContentPath: async (contentPath) => (contentPath === "Movies/valid.mp4" ? identity : null),
    validateContentPath: async (contentPath) => { calls.push(contentPath); return contentPath.includes("..") ? null : contentPath; }
  });
  const { db, service } = fixture({ compatibilityResolver: resolver });
  t.after(() => db.close());
  const result = await service.recordEvent({
    contentPath: "Movies/valid.mp4", durationSeconds: 100, event: "start", eventId: randomUUID(),
    positionSeconds: 0, sessionId: null
  }, principal());
  assert.equal(result.state.itemId, identity.itemId);
  await assert.rejects(() => service.recordEvent({
    contentPath: "../secret.mp4", durationSeconds: 100, event: "start", eventId: randomUUID(),
    positionSeconds: 0, sessionId: null
  }, principal()), { status: 404 });
  assert.deepEqual(calls, ["Movies/valid.mp4", "../secret.mp4"]);
});

test("direct stable IDs can be validated against the catalog boundary", async (t) => {
  const allowed = ids();
  const { db, repository } = fixture();
  t.after(() => db.close());
  const service = createPlaybackService({
    identityValidator: ({ itemId, sourceId }) => itemId === allowed.itemId && sourceId === allowed.sourceId,
    repository
  });
  await start(service, allowed);
  await assert.rejects(() => start(service, ids()), { status: 404 });
});

test("manual watched state does not create synthetic playback sessions", async (t) => {
  const { db, repository, service } = fixture();
  t.after(() => db.close());
  const identity = ids();
  const watched = await service.setWatched({ ...identity, watched: true }, principal());
  assert.equal(watched.completed, true);
  assert.equal(watched.playCount, 1);
  const unplayed = await service.setWatched({ ...identity, watched: false }, principal());
  assert.equal(unplayed.completed, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM playback_sessions").get().count, 0);
});
