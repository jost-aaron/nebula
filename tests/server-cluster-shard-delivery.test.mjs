import assert from "node:assert/strict";
import test from "node:test";
import { createClusterShardDeliveryService } from "../server/cluster/index.mjs";

const peer = { nodeId: "node_coordinator_01", role: "coordinator" };
const source = { availability: "available", contentRevision: 3, id: "source_fixture_01", itemId: "item_fixture_01" };
const input = {
  accountId: "account_fixture_01",
  capabilities: { deviceId: "device_fixture_01", supportsHls: true },
  clusterSessionId: "cluster_session_fixture_01",
  federatedItemId: "fitem_fixture_01",
  localItemId: source.itemId,
  localSourceId: source.id,
  profileId: "720p",
  sourceRevision: source.contentRevision,
  startPositionSeconds: null
};

test("shard delivery binds generated output to the coordinator session and grant", async () => {
  let cancelled = null;
  const delivery = {
    cancel: async (id) => { cancelled = id; },
    create: async () => ({
      plan: { decision: "transcode", output: { protocol: "hls" }, reasons: [] },
      session: { id: "delivery_fixture_01", status: "running" }
    }),
    get: () => ({ id: "delivery_fixture_01", status: "ready" }),
    resolveHlsAsset: async (_id, asset) => `/tmp/${asset}`
  };
  const service = createClusterShardDeliveryService({ catalog: { getSource: () => source }, delivery, localNodeId: "node_shard_01" });
  const created = await service.create(input, peer);
  assert.equal(created.status, "ready");
  assert.deepEqual(service.operationsSnapshot(), { active: 1, states: { cancelled: 0, expired: 0, failed: 0, queued: 0, ready: 1, running: 0 } });
  const grant = { accountId: input.accountId, deliveryId: created.deliveryId, deliveryProtocol: "hls", federatedItemId: input.federatedItemId, localSourceId: input.localSourceId, profileId: input.profileId, sessionId: input.clusterSessionId, sourceRevision: input.sourceRevision };
  const authorized = service.authorizeGrant(grant);
  assert.equal(await service.resolveHlsAsset(authorized, "master.m3u8"), "/tmp/master.m3u8");
  await service.cancel({ clusterSessionId: input.clusterSessionId, deliveryId: created.deliveryId }, peer);
  assert.equal(cancelled, created.deliveryId);
  assert.deepEqual(service.operationsSnapshot(), { active: 0, states: { cancelled: 0, expired: 0, failed: 0, queued: 0, ready: 0, running: 0 } });
});

test("shard delivery rejects stale sources and another coordinator's session", async () => {
  const delivery = {
    create: async () => ({ plan: { decision: "remux", output: { protocol: "file" }, reasons: [] }, session: { id: "delivery_fixture_01" } }),
    get: () => ({ status: "ready" })
  };
  const service = createClusterShardDeliveryService({ catalog: { getSource: () => source }, delivery, localNodeId: "node_shard_01" });
  await assert.rejects(service.create({ ...input, sourceRevision: 2 }, peer), { code: "shard_delivery_source_unavailable" });
  const created = await service.create(input, peer);
  assert.throws(() => service.get({ clusterSessionId: input.clusterSessionId, deliveryId: created.deliveryId }, { nodeId: "node_other_01", role: "coordinator" }), { code: "shard_delivery_not_found" });
});

test("permanently queued shard delivery has a hard expiry and is cancelled exactly once", async () => {
  let currentTime = 2_000;
  let sweep = null;
  let timerCleared = 0;
  let cancellations = 0;
  const delivery = {
    cancel: async () => { cancellations += 1; },
    create: async () => ({
      plan: { decision: "transcode", output: { protocol: "hls" }, reasons: [] },
      session: { id: "delivery_fixture_01", status: "queued" }
    }),
    get: () => ({ id: "delivery_fixture_01", status: "queued" })
  };
  const service = createClusterShardDeliveryService({
    catalog: { getSource: () => source },
    delivery,
    localNodeId: "node_shard_01",
    now: () => currentTime,
    sessionTtlMs: 50,
    setTimer: (callback) => { sweep = callback; return { unref() {} }; },
    clearTimer: () => { timerCleared += 1; }
  });
  const created = await service.create(input, peer);
  currentTime = 2_040;
  assert.equal(service.get({ clusterSessionId: input.clusterSessionId, deliveryId: created.deliveryId }, peer).status, "queued");
  currentTime = 2_050;
  sweep();
  await new Promise(setImmediate);
  assert.equal(cancellations, 1);
  assert.throws(() => service.get({ clusterSessionId: input.clusterSessionId, deliveryId: created.deliveryId }, peer), { code: "shard_delivery_not_found" });
  await service.shutdown();
  await service.shutdown();
  assert.equal(cancellations, 1);
  assert.equal(timerCleared, 1);
});

test("shard shutdown cancels delivery creation that finishes after the registry closes", async () => {
  let finishCreate;
  let cancellations = 0;
  const service = createClusterShardDeliveryService({
    catalog: { getSource: () => source },
    delivery: {
      create: () => new Promise((resolve) => { finishCreate = resolve; }),
      cancel: async () => { cancellations += 1; }
    },
    localNodeId: "node_shard_01"
  });
  const pending = service.create(input, peer);
  await Promise.resolve();
  await service.shutdown();
  finishCreate({ plan: { decision: "transcode", output: { protocol: "hls" }, reasons: [] }, session: { id: "delivery_fixture_01", status: "queued" } });
  await assert.rejects(pending, { code: "shard_delivery_closed" });
  assert.equal(cancellations, 1);
  await service.shutdown();
  assert.equal(cancellations, 1);
});
