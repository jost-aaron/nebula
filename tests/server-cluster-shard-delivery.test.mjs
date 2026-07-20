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
