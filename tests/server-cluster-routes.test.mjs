import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createClusterAdminRoutes, createClusterIngressRoutes } from "../server/cluster/index.mjs";

const response = () => ({ body: "", headers: {}, end(value = "") { this.body += value; }, writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); } });
const request = (method, body) => {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = method; stream.headers = {};
  return stream;
};

test("shard ingress exposes only pairing and signed health contracts", async () => {
  const service = {
    acceptPairing: (body) => ({ clusterId: body.clusterId, node: { nodeId: "node_shard_001" } }),
    identity: () => ({ clusterId: "cluster_fixture_01", descriptor: { nodeId: "node_shard_001" } }),
    verifyRequest: (_envelope, payload) => ({ nodeId: payload.peer })
  };
  const routes = createClusterIngressRoutes(service);
  const paired = response();
  assert.equal(await routes(request("POST", { clusterId: "cluster_fixture_01" }), paired, new URL("http://nebula/api/shard/v1/pair")), true);
  assert.equal(paired.status, 201);
  const health = response();
  await routes(request("POST", { envelope: {}, payload: { peer: "node_home_0001" } }), health, new URL("http://nebula/api/shard/v1/health"));
  assert.equal(JSON.parse(health.body).peer.nodeId, "node_home_0001");
  const unknown = response();
  await routes(request("GET"), unknown, new URL("http://nebula/api/shard/v1/proxy"));
  assert.equal(unknown.status, 404);
});

test("cluster admin routes create codes, pair, list, and revoke through injected services", async () => {
  const nodes = [];
  const service = {
    createPairingCode: () => ({ pairingCode: "pairing_code_123", expiresAt: "2026-07-19T12:10:00.000Z" }),
    identity: () => ({ clusterId: "cluster_fixture_01" }), listNodes: () => nodes,
    registerPairedNode: ({ node }) => { nodes.push(node); return node; },
    revokeNode: (nodeId) => { nodes.splice(nodes.findIndex((node) => node.nodeId === nodeId), 1); }
  };
  const pairingClient = { pair: async () => ({ clusterId: "cluster_fixture_01", node: { nodeId: "node_shard_001" } }) };
  const routes = createClusterAdminRoutes({ pairingClient, service });
  const code = response();
  await routes(request("POST"), code, new URL("http://nebula/api/admin/cluster/pairing-code"));
  assert.equal(code.status, 201);
  const added = response();
  await routes(request("POST", { endpoint: "https://nebula-shard.example-tail.ts.net/", pairingCode: "pairing_code_123" }), added, new URL("http://nebula/api/admin/cluster/nodes"));
  assert.equal(JSON.parse(added.body).node.nodeId, "node_shard_001");
  const listed = response();
  await routes(request("GET"), listed, new URL("http://nebula/api/admin/cluster"));
  assert.equal(JSON.parse(listed.body).nodes.length, 1);
  const removed = response();
  await routes(request("DELETE"), removed, new URL("http://nebula/api/admin/cluster/nodes/node_shard_001"));
  assert.equal(removed.status, 204);
});

test("manifest ingress and coordinator controls remain signed, bounded, and owner-routed", async () => {
  const service = {
    signRequest: ({ body }) => ({ nodeId: body.nodeId, signature: "signed" }),
    verifyRequest: () => ({ nodeId: "node_home_0001" })
  };
  const manifest = { page: () => ({ complete: true, cursor: null, manifestRevision: 1, nodeId: "node_shard_001", protocolVersion: 1, sources: [] }) };
  const ingress = createClusterIngressRoutes({ manifest, service });
  const result = response();
  await ingress(request("POST", { envelope: {}, payload: { cursor: null, limit: 10 } }), result, new URL("http://nebula/api/shard/v1/manifest"));
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).payload.nodeId, "node_shard_001");

  const federation = {
    listConflicts: () => [{ id: "conflict_001" }], listItems: () => [{ id: "fitem_001" }],
    setOverride: (body) => ({ ...body, targetItemId: "fitem_001" })
  };
  const sync = { syncNode: async (nodeId) => ({ complete: true, manifestRevision: 4, nodeId }) };
  const admin = createClusterAdminRoutes({ federation, pairingClient: {}, service: {}, sync });
  const items = response(); await admin(request("GET"), items, new URL("http://nebula/api/admin/cluster/items"));
  assert.equal(JSON.parse(items.body).items[0].id, "fitem_001");
  const synced = response(); await admin(request("POST"), synced, new URL("http://nebula/api/admin/cluster/nodes/node_shard_001/sync"));
  assert.equal(JSON.parse(synced.body).manifestRevision, 4);
  const override = response();
  await admin(request("POST", { action: "merge", leftOrigin: "node_a:item_a", rightOrigin: "node_b:item_b" }), override, new URL("http://nebula/api/admin/cluster/dedupe-overrides"));
  assert.equal(JSON.parse(override.body).targetItemId, "fitem_001");
});

test("generated HLS ingress rewrites only shard-owned relative assets with the media ticket", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-shard-hls-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const playlist = path.join(root, "master.m3u8");
  await writeFile(playlist, "#EXTM3U\nsegment-000.ts\n");
  const grants = { resolve: () => ({ clientOrigin: "http://127.0.0.1:5173", delivery: {}, source: {} }) };
  const shardDelivery = { resolveHlsAsset: async () => playlist };
  const routes = createClusterIngressRoutes({ contentRoot: root, grants, service: {}, shardDelivery });
  const req = request("GET"); req.headers.origin = "http://127.0.0.1:5173";
  const res = response();
  await routes(req, res, new URL("http://nebula/api/shard/v1/media/grant_fixture_01/hls/master.m3u8?ticket=ticket_fixture_01"));
  assert.equal(res.status, 200);
  assert.match(res.body, /segment-000\.ts\?ticket=ticket_fixture_01/);
  assert.equal(res.headers["access-control-allow-origin"], "http://127.0.0.1:5173");
  const head = response();
  const headRequest = request("HEAD"); headRequest.headers.origin = "http://127.0.0.1:5173";
  await routes(headRequest, head, new URL("http://nebula/api/shard/v1/media/grant_fixture_01/hls/master.m3u8?ticket=ticket_fixture_01"));
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-length"], Buffer.byteLength(res.body));
  assert.equal(head.body, "");

  await writeFile(playlist, "#EXTM3U\nhttps://attacker.example/segment.ts\n");
  const denied = response();
  await routes(req, denied, new URL("http://nebula/api/shard/v1/media/grant_fixture_01/hls/master.m3u8?ticket=ticket_fixture_01"));
  assert.equal(denied.status, 502);
  assert.equal(JSON.parse(denied.body).code, "invalid_delivery_playlist");

  await writeFile(playlist, "#EXTM3U\nsegment-000.ts#drop-ticket\n");
  const fragment = response();
  await routes(req, fragment, new URL("http://nebula/api/shard/v1/media/grant_fixture_01/hls/master.m3u8?ticket=ticket_fixture_01"));
  assert.equal(fragment.status, 502);

  await writeFile(playlist, "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://attacker.example/key\"\nsegment-000.ts\n");
  const embedded = response();
  await routes(req, embedded, new URL("http://nebula/api/shard/v1/media/grant_fixture_01/hls/master.m3u8?ticket=ticket_fixture_01"));
  assert.equal(embedded.status, 502);
});
