import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";
import {
  clusterMigration,
  createClusterDeliveryClient,
  createClusterGrantClient,
  createClusterGrantService,
  createClusterIngressRoutes,
  createClusterPlaybackService,
  createClusterRepository,
  createClusterShardDeliveryService,
  createClusterTrustService
} from "../server/cluster/index.mjs";

const capabilities = { directPlay: true, hls: true, remux: true, renditionProfiles: ["720p"], transcode: true };
const fixture = (endpoint, name, role) => {
  const database = new DatabaseSync(":memory:");
  applyDomainMigrations(database, [clusterMigration]);
  return { database, trust: createClusterTrustService({ capabilities, endpoint, name, repository: createClusterRepository(database), role }) };
};
const listen = async (route) => {
  const server = createServer((request, response) => void route(request, response, new URL(request.url, "http://localhost")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { close: () => new Promise((resolve) => server.close(resolve)), origin: `http://127.0.0.1:${server.address().port}` };
};

test("coordinator creates signed remote HLS delivery and streams its ticketed segment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-cluster-generated-"));
  const coordinator = fixture("https://home.tail024251.ts.net/", "Home", "coordinator");
  const shard = fixture("https://basement.tail024251.ts.net/", "Basement", "shard");
  const pairing = shard.trust.acceptPairing({
    clusterId: coordinator.trust.identity().clusterId,
    pairingCode: shard.trust.createPairingCode().pairingCode,
    requester: coordinator.trust.identity().descriptor
  });
  coordinator.trust.registerPairedNode(pairing);
  const source = { availability: "available", contentRevision: 2, id: "source_fixture_01", itemId: "item_fixture_01" };
  const playlistPath = path.join(root, "master.m3u8");
  const segmentPath = path.join(root, "segment-000.ts");
  const segment = Buffer.from("generated-shard-segment");
  await writeFile(playlistPath, "#EXTM3U\n#EXTINF:4,\nsegment-000.ts\n");
  await writeFile(segmentPath, segment);
  const delivery = {
    cancel: async () => undefined,
    create: async () => ({
      plan: {
        decision: "transcode",
        output: { audioCodec: "aac", bitrate: 4_000_000, container: "mpegts", protocol: "hls", videoCodec: "h264" },
        reasons: [{ code: "VIDEO_PROFILE", message: "A compatible profile is required.", streamIndex: 0 }]
      },
      session: { id: "delivery_fixture_01", status: "ready" }
    }),
    get: () => ({ status: "ready" }),
    resolveHlsAsset: async (_id, asset) => asset === "master.m3u8" ? playlistPath : segmentPath
  };
  const shardDelivery = createClusterShardDeliveryService({ catalog: { getSource: () => source }, delivery, localNodeId: shard.trust.identity().descriptor.nodeId });
  const shardGrants = createClusterGrantService({ catalog: { getSource: () => source }, shardDelivery, trust: shard.trust });
  const ingress = createClusterIngressRoutes({ contentRoot: root, grants: shardGrants, service: shard.trust, shardDelivery });
  const server = await listen(ingress);
  t.after(async () => {
    await server.close();
    coordinator.database.close(); shard.database.close();
    await rm(root, { force: true, recursive: true });
  });
  const routedFetch = (url, options) => {
    const target = new URL(url);
    return fetch(`${server.origin}${target.pathname}${target.search}`, options);
  };
  const deliveryClient = createClusterDeliveryClient({ allowDirect: true, fetcher: routedFetch, proxyUrl: null, trust: coordinator.trust });
  const grantClient = createClusterGrantClient({ allowDirect: true, fetcher: routedFetch, proxyUrl: null });
  const candidate = {
    decision: "transcode", endpoint: shard.trust.identity().descriptor.endpoint, federatedSourceId: "fsource_fixture_01",
    local: false, localItemId: source.itemId, localSourceId: source.id, mode: "live-transcode",
    nodeId: shard.trust.identity().descriptor.nodeId, nodeName: "Basement", sourceRevision: source.contentRevision
  };
  const clusterSession = {
    internal: { candidate, federatedItemId: "fitem_fixture_01", id: "cluster_session_fixture_01", request: { capabilities: { deviceId: "device_fixture_01", supportsHls: true }, federatedItemId: "fitem_fixture_01", preferredProfileId: "720p" } },
    session: { candidate: { nodeId: candidate.nodeId, sourceId: candidate.federatedSourceId }, id: "cluster_session_fixture_01" }
  };
  const scheduler = { create: () => clusterSession, release: () => undefined };
  const coordinatorGrants = createClusterGrantService({ catalog: { getSource: () => null }, trust: coordinator.trust });
  const playback = createClusterPlaybackService({ client: grantClient, deliveryClient, grants: coordinatorGrants, scheduler });
  const created = await playback.create(clusterSession.internal.request, { accountId: "account_fixture_01" });
  assert.equal(created.session.status, "ready");
  assert.equal(created.plan.decision, "transcode");
  const remote = new URL(created.session.deliveryUrl);
  const playlist = await fetch(`${server.origin}${remote.pathname}${remote.search}`, { headers: { origin: coordinator.trust.identity().descriptor.endpoint.replace(/\/$/, "") } });
  assert.equal(playlist.status, 200);
  const body = await playlist.text();
  const segmentReference = body.split("\n").find((line) => line.startsWith("segment-000.ts"));
  assert.ok(segmentReference?.includes("ticket="));
  const assetPrefix = remote.pathname.slice(0, remote.pathname.lastIndexOf("/") + 1);
  const segmentResponse = await fetch(`${server.origin}${assetPrefix}${segmentReference}`, { headers: { origin: coordinator.trust.identity().descriptor.endpoint.replace(/\/$/, "") } });
  assert.equal(segmentResponse.status, 200);
  assert.deepEqual(Buffer.from(await segmentResponse.arrayBuffer()), segment);
});
