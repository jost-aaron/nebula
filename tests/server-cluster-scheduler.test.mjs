import assert from "node:assert/strict";
import test from "node:test";
import { createClusterPlaybackScheduler } from "../server/cluster/index.mjs";

const capabilities = { deviceId: "device_fixture_01", supportsHls: true };
const request = (overrides = {}) => ({ capabilities, federatedItemId: "fitem_fixture_01", preferredProfileId: "auto", ...overrides });
const source = (nodeId, overrides = {}) => ({
  availability: "available",
  capabilities: { directPlay: true, hls: true, remux: true, renditionProfiles: ["720p"], transcode: true },
  endpoint: `https://${nodeId}.tail024251.ts.net`,
  exactReplicaKey: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:100",
  federatedSourceId: `fsource_${nodeId}`,
  local: false,
  localItemId: `item_${nodeId}`,
  localSourceId: `source_${nodeId}`,
  nodeId,
  nodeName: nodeId,
  nodeState: "online",
  renditions: [],
  sourceRevision: 1,
  ...overrides
});

test("scheduler balances sessions, stays sticky, and explains its choice", () => {
  const sources = [source("node_alpha"), source("node_bravo")];
  const scheduler = createClusterPlaybackScheduler({ federation: { listPlaybackSources: () => sources }, now: () => 1_000, uuid: (() => { let value = 0; return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`; })() });
  const first = scheduler.create(request(), { accountId: "account_fixture_01" });
  const second = scheduler.create(request(), { accountId: "account_fixture_02" });
  assert.equal(first.session.candidate.nodeId, "node_alpha");
  assert.equal(second.session.candidate.nodeId, "node_bravo");
  assert.equal(scheduler.get(first.session.id, { accountId: "account_fixture_01" }).candidate.nodeId, "node_alpha");
  assert.deepEqual(first.session.candidate.reasons, [{ code: "DIRECT_PLAY", score: 500 }]);
  assert.doesNotMatch(JSON.stringify(first.session), /tail024251|localSourceId|endpoint/);
  assert.deepEqual(scheduler.snapshot(), { activeByNode: { node_alpha: 1, node_bravo: 1 }, sessionCount: 2 });
});

test("scheduler prefers a requested ready rendition and ignores draining nodes", () => {
  const sources = [
    source("node_alpha", { nodeState: "draining", renditions: [{ profileId: "720p", revision: 1, state: "ready" }] }),
    source("node_bravo", { renditions: [{ profileId: "720p", revision: 1, state: "ready" }] })
  ];
  const scheduler = createClusterPlaybackScheduler({ federation: { listPlaybackSources: () => sources }, now: () => 1_000, uuid: () => "00000000-0000-4000-8000-000000000001" });
  const selected = scheduler.create(request({ preferredProfileId: "720p" }), { accountId: "account_fixture_01" });
  assert.equal(selected.session.candidate.nodeId, "node_bravo");
  assert.equal(selected.session.candidate.mode, "prebuilt-rendition");
  assert.equal(selected.session.candidate.decision, "transcode");
});

test("failover switches only to an exact replica and cools down the failed node", () => {
  let time = 1_000;
  const sources = [source("node_alpha"), source("node_bravo")];
  const scheduler = createClusterPlaybackScheduler({ federation: { listPlaybackSources: () => sources }, now: () => time, uuid: () => "00000000-0000-4000-8000-000000000001" });
  const created = scheduler.create(request(), { accountId: "account_fixture_01" });
  const switched = scheduler.failover(created.session.id, { accountId: "account_fixture_01" }, "node_alpha");
  assert.equal(switched.session.candidate.nodeId, "node_bravo");
  assert.deepEqual(scheduler.snapshot(), { activeByNode: { node_alpha: 0, node_bravo: 1 }, sessionCount: 1 });
  scheduler.release(created.session.id, { accountId: "account_fixture_01" });
  assert.equal(scheduler.create(request(), { accountId: "account_fixture_02" }).session.candidate.nodeId, "node_bravo");
  time += 60_001;
  assert.equal(scheduler.create(request(), { accountId: "account_fixture_03" }).session.candidate.nodeId, "node_alpha");
});

test("failover refuses alternate encodes and account boundaries fail closed", () => {
  const sources = [source("node_alpha"), source("node_bravo", { exactReplicaKey: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:100" })];
  const scheduler = createClusterPlaybackScheduler({ federation: { listPlaybackSources: () => sources }, now: () => 1_000, uuid: () => "00000000-0000-4000-8000-000000000001" });
  const created = scheduler.create(request(), { accountId: "account_fixture_01" });
  assert.throws(() => scheduler.get(created.session.id, { accountId: "account_fixture_02" }), { code: "cluster_playback_session_not_found" });
  assert.throws(() => scheduler.failover(created.session.id, { accountId: "account_fixture_01" }, "node_alpha"), { code: "failover_unavailable" });
});
