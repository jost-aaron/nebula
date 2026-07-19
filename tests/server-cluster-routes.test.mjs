import assert from "node:assert/strict";
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
