import assert from "node:assert/strict";
import test from "node:test";
import { createClusterOperationsService, createClusterPlaybackScheduler } from "../server/cluster/index.mjs";

const baseTime = Date.parse("2026-07-19T12:00:00.000Z");
const forbidden = /tail024251|private\.mp4|source_secret|grant_secret|ticket_secret|node_key|sha256|\/Users\/private|ts\.net/i;

test("cluster readiness and metrics remain bounded, aggregate-only, and low-cardinality", () => {
  const events = [];
  const operations = createClusterOperationsService({
    audit: { recordBestEffort: (event) => events.push(event) },
    deliverySnapshot: () => ({ active: 2, states: { queued: 1, ready: 1 } }),
    manifestSnapshot: () => [
      { lastCompleteAt: new Date(baseTime - 1_000).toISOString(), sourceId: "source_secret", endpoint: "https://secret.ts.net" },
      { lastCompleteAt: new Date(baseTime - 8 * 60_000).toISOString(), hash: "sha256:secret" }
    ],
    nodesSnapshot: () => [
      { endpoint: "https://nebula.tail024251.ts.net", nodeId: "node_key", publicKey: "node_key_secret", state: "online" },
      { path: "/Users/private/private.mp4", state: "offline" },
      { state: "revoked", ticket: "ticket_secret" }
    ],
    now: () => baseTime,
    schedulerSnapshot: () => ({ activeNodes: 1, activeSessions: 3, cooldownMaxRemainingMs: 12_000, cooldowns: 1 })
  });
  const readiness = operations.readiness();
  assert.equal(readiness.status, "degraded");
  assert.deepEqual(readiness.reasons, ["NODE_UNAVAILABLE", "MANIFEST_AGING"]);
  assert.deepEqual(readiness.nodes, { paired: 2, states: { draining: 0, offline: 1, online: 1, revoked: 1 } });
  assert.equal(readiness.manifests.oldestAgeBucket, "aging");
  assert.equal(readiness.scheduler.cooldownMaxRemainingBucket, "10-60s");
  const metrics = operations.metrics();
  assert.equal(metrics.samples.length, 22);
  assert.equal(new Set(metrics.samples.map(({ name }) => name)).size, metrics.samples.length);
  assert.ok(metrics.samples.every(({ name, value }) => /^nebula_cluster_[a-z_]+$/.test(name) && Number.isSafeInteger(value) && value >= 0));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { actor: { kind: "system" }, eventType: "cluster.readiness_changed", metadata: { reason: "cluster-degraded" }, outcome: "failure" });
  assert.doesNotMatch(JSON.stringify({ events, metrics, readiness }), forbidden);
});

test("readiness distinguishes stale, hard-unavailable, recovered, and failed providers", () => {
  let time = baseTime;
  let nodes = [{ state: "offline" }];
  let manifests = [{ lastCompleteAt: new Date(baseTime - 60 * 60_000).toISOString() }];
  let failScheduler = false;
  const events = [];
  const operations = createClusterOperationsService({
    audit: { recordBestEffort: (event) => events.push(event) },
    manifestSnapshot: () => manifests,
    nodesSnapshot: () => nodes,
    now: () => time,
    schedulerSnapshot: () => { if (failScheduler) throw new Error("/Users/private/private.mp4 ticket_secret"); return {}; }
  });
  const unavailable = operations.readiness();
  assert.equal(unavailable.status, "not-ready");
  assert.deepEqual(unavailable.reasons, ["NO_AVAILABLE_NODES", "MANIFEST_STALE"]);
  nodes = [{ state: "online" }];
  manifests = [{ lastCompleteAt: new Date(time).toISOString() }];
  assert.equal(operations.readiness().status, "ready");
  failScheduler = true;
  const failed = operations.readiness();
  assert.equal(failed.status, "not-ready");
  assert.deepEqual(failed.reasons, ["OBSERVABILITY_INPUT_UNAVAILABLE"]);
  assert.deepEqual(events.map(({ metadata }) => metadata), [
    { reason: "cluster-not-ready" }, { reason: "cluster-ready" }, { reason: "cluster-not-ready" }
  ]);
  assert.doesNotMatch(JSON.stringify({ events, failed }), forbidden);
});

test("clock diagnostics are bounded and expose buckets instead of raw skew", () => {
  const events = [];
  const operations = createClusterOperationsService({
    audit: { recordBestEffort: (event) => events.push(event) },
    clockSampleLimit: 8,
    now: () => baseTime
  });
  for (let index = 0; index < 20; index += 1) operations.recordClockSkew({ accepted: index % 4 !== 0, skewMs: index * 7_777.123 });
  const readiness = operations.readiness();
  assert.equal(readiness.clock.samples, 8);
  assert.equal(readiness.clock.accepted, 6);
  assert.equal(readiness.clock.rejected, 2);
  assert.deepEqual(readiness.clock.buckets, { "under-1s": 0, "1-10s": 0, "10-60s": 0, "over-60s": 8 });
  assert.equal(readiness.status, "degraded");
  assert.equal(events.filter(({ eventType }) => eventType === "cluster.clock_skew_detected").length, 1);
  assert.ok(events.every((event) => event.eventType === "cluster.clock_skew_detected" || event.eventType === "cluster.readiness_changed"));
  assert.doesNotMatch(JSON.stringify({ events, readiness }), /7777|15554|skewMs/);
});

test("scheduler operations snapshot reports aggregate cooldowns without node labels", () => {
  let time = 1_000;
  const sources = ["alpha", "bravo"].map((name) => ({
    capabilities: { directPlay: true, remux: true, transcode: true }, endpoint: `https://${name}.ts.net`,
    exactReplicaKey: "secret-hash", federatedSourceId: `source_${name}`, local: false,
    localItemId: `item_${name}`, localSourceId: `local_${name}`, nodeId: `node_${name}`,
    nodeName: name, nodeState: "online", renditions: [], sourceRevision: 1
  }));
  const scheduler = createClusterPlaybackScheduler({
    federation: { listPlaybackSources: () => sources }, now: () => time,
    uuid: () => "00000000-0000-4000-8000-000000000001"
  });
  const request = { capabilities: { deviceId: "device_fixture", supportsHls: true }, federatedItemId: "fitem_fixture", preferredProfileId: "auto" };
  const created = scheduler.create(request, { accountId: "account_fixture" });
  scheduler.failover(created.session.id, { accountId: "account_fixture" }, "node_alpha");
  assert.deepEqual(scheduler.operationsSnapshot(), { activeNodes: 1, activeSessions: 1, cooldownMaxRemainingMs: 60_000, cooldowns: 1 });
  assert.doesNotMatch(JSON.stringify(scheduler.operationsSnapshot()), /alpha|bravo|source_|local_|secret-hash/);
  time += 60_001;
  assert.deepEqual(scheduler.operationsSnapshot(), { activeNodes: 1, activeSessions: 1, cooldownMaxRemainingMs: 0, cooldowns: 0 });
});
