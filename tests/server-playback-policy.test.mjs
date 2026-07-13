import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";
import { createPlaybackPolicyRepository, createPlaybackPolicyService, playbackPolicyMigration } from "../server/playbackPolicy/index.mjs";

const alice = "10000000-0000-4000-8000-000000000001";
const bob = "20000000-0000-4000-8000-000000000002";
const fixture = () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL,
      role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0) STRICT;
    INSERT INTO users VALUES ('${alice}', 'alice', 'Alice', 'owner', 0), ('${bob}', 'bob', 'Bob', 'member', 0);`);
  applyDomainMigrations(database, [playbackPolicyMigration]);
  const repository = createPlaybackPolicyRepository(database);
  return { database, repository, service: createPlaybackPolicyService({ repository }) };
};

test("policy migration composes centrally and unlimited defaults persist current behavior", () => {
  const value = fixture();
  applyDomainMigrations(value.database, [playbackPolicyMigration]);
  assert.equal(playbackPolicyMigration.id, "playback-policy-v1");
  assert.deepEqual(value.repository.getGlobal(), { maxBitrate: null, maxConcurrentStreams: null });
  assert.equal(value.database.prepare("SELECT COUNT(*) AS count FROM nebula_domain_migrations").get().count, 1);
  const lease = value.service.admit({ decision: "transcode", producedBitrate: 50_000_000, requestedBitrate: null, sessionId: "one", userId: alice });
  assert.equal(value.service.status().activeStreams, 1);
  lease.release(); lease.release();
  assert.equal(value.service.status().activeStreams, 0);
  value.database.close();
});

test("global and per-user limits admit atomically and return stable safe denial codes", async () => {
  const value = fixture();
  value.service.setGlobal({ maxBitrate: null, maxConcurrentStreams: 2 });
  value.service.setUser(alice, { maxBitrate: null, maxConcurrentStreams: 1 });
  const attempts = await Promise.allSettled(["a", "b"].map(async (sessionId) => value.service.admit({ decision: "transcode", sessionId, userId: alice })));
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.find(({ status }) => status === "rejected").reason.code, "user_stream_limit_reached");
  const bobLease = value.service.admit({ decision: "remux", sessionId: "bob", userId: bob });
  assert.throws(() => value.service.admit({ decision: "transcode", sessionId: "global", userId: bob }), { code: "global_stream_limit_reached", status: 429 });
  attempts.find(({ status }) => status === "fulfilled").value.release();
  bobLease.release();
  value.database.close();
});

test("requested and remux-produced bitrate are denied while transcode output is capped", () => {
  const value = fixture();
  value.service.setGlobal({ maxBitrate: 5_000_000, maxConcurrentStreams: null });
  value.service.setUser(alice, { maxBitrate: 3_000_000, maxConcurrentStreams: null });
  assert.throws(() => value.service.admit({ decision: "transcode", requestedBitrate: 4_000_000, sessionId: "requested", userId: alice }), { code: "bitrate_limit_exceeded" });
  assert.throws(() => value.service.admit({ decision: "remux", producedBitrate: 4_000_000, requestedBitrate: 2_000_000, sessionId: "produced", userId: alice }), { code: "produced_bitrate_limit_exceeded" });
  const lease = value.service.admit({ decision: "transcode", producedBitrate: 8_000_000, requestedBitrate: 2_000_000, sessionId: "capped", userId: alice });
  assert.equal(lease.maxProducedBitrate, 3_000_000);
  lease.release();
  assert.deepEqual(value.service.constraints(alice), { maxBitrate: 3_000_000, maxConcurrentStreams: null });
  assert.throws(() => value.service.admit({ decision: "transcode", fixedProfile: true, producedBitrate: 4_000_000, requestedBitrate: 3_000_000, sessionId: "fixed", userId: alice }), { code: "rendition_bitrate_limit_exceeded" });
  value.database.close();
});

test("configuration survives service recreation while active accounting restarts clean", () => {
  const value = fixture();
  value.service.setGlobal({ maxBitrate: 9_000_000, maxConcurrentStreams: 4 });
  value.service.setUser(bob, { maxBitrate: 2_000_000, maxConcurrentStreams: 1 });
  value.service.admit({ decision: "transcode", sessionId: "active-before-restart", userId: bob });
  value.service.shutdown();
  const restarted = createPlaybackPolicyService({ repository: value.repository });
  assert.equal(restarted.status().activeStreams, 0);
  assert.deepEqual(restarted.getConfig().global, { maxBitrate: 9_000_000, maxConcurrentStreams: 4 });
  assert.deepEqual(value.repository.getUser(bob), { maxBitrate: 2_000_000, maxConcurrentStreams: 1 });
  value.database.close();
});

test("invalid configuration and missing accounts fail closed", () => {
  const value = fixture();
  assert.throws(() => value.service.setGlobal({ maxBitrate: 1, maxConcurrentStreams: null }), { code: "invalid_bitrate_limit" });
  assert.throws(() => value.service.setGlobal({ maxBitrate: null, maxConcurrentStreams: 0 }), { code: "invalid_stream_limit" });
  assert.throws(() => value.service.setUser("30000000-0000-4000-8000-000000000003", { maxBitrate: null, maxConcurrentStreams: null }), { code: "user_not_found" });
  value.database.close();
});
