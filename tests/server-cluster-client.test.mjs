import assert from "node:assert/strict";
import test from "node:test";
import { createClusterPairingClient, isTailscaleAddress, validateClusterProxyUrl } from "../server/cluster/index.mjs";

const descriptor = {
  capabilities: { directPlay: true, hls: true, remux: true, renditionProfiles: [], transcode: true },
  endpoint: "https://nebula-shard.example-tail.ts.net/", name: "Shard", nodeId: "node_shard_001",
  protocolVersion: 1, publicKey: Buffer.alloc(32, 1).toString("base64url"), role: "shard"
};
const localIdentity = { clusterId: "cluster_fixture_01", descriptor: { ...descriptor, endpoint: "https://nebula-home.example-tail.ts.net/", name: "Home", nodeId: "node_home_0001", role: "hybrid" } };
const response = (body, { ok = true, status = 201 } = {}) => ({
  body: ReadableStream.from([Buffer.from(JSON.stringify(body))]), headers: { get: () => null }, ok, status
});

test("Tailscale address classification accepts only CGNAT and tailnet IPv6 ranges", () => {
  for (const address of ["100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1"]) assert.equal(isTailscaleAddress(address), true);
  for (const address of ["100.63.255.255", "100.128.0.1", "127.0.0.1", "10.0.0.1", "fd00::1"]) assert.equal(isTailscaleAddress(address), false);
});

test("cluster proxy accepts only the fixed shared-loopback Tailscale listener", () => {
  assert.equal(validateClusterProxyUrl("http://127.0.0.1:1055"), "http://127.0.0.1:1055");
  assert.equal(validateClusterProxyUrl(""), null);
  for (const value of ["http://0.0.0.0:1055", "http://127.0.0.1:8080", "https://127.0.0.1:1055", "http://user:pass@127.0.0.1:1055"]) {
    assert.throws(() => validateClusterProxyUrl(value), (error) => error.code === "invalid_cluster_proxy");
  }
});

test("pairing client resolves an exact tailnet origin and refuses redirects", async () => {
  let request;
  const client = createClusterPairingClient({
    lookup: async () => [{ address: "100.80.1.2", family: 4 }],
    fetcher: async (url, options) => { request = { url, options }; return response({ clusterId: localIdentity.clusterId, node: descriptor }); }
  });
  const accepted = await client.pair({ endpoint: descriptor.endpoint, localIdentity, pairingCode: "pairing_code_123" });
  assert.equal(accepted.node.nodeId, descriptor.nodeId);
  assert.equal(request.url, "https://nebula-shard.example-tail.ts.net/api/shard/v1/pair");
  assert.equal(request.options.redirect, "error");
  assert.equal(JSON.parse(request.options.body).pairingCode, "pairing_code_123");
});

test("pairing client rejects mixed DNS answers, endpoint substitution, and oversized bodies", async () => {
  const mixed = createClusterPairingClient({ allowDirect: true, lookup: async () => [{ address: "100.80.1.2" }, { address: "203.0.113.4" }], proxyUrl: "" });
  await assert.rejects(mixed.pair({ endpoint: descriptor.endpoint, localIdentity, pairingCode: "pairing_code_123" }), (error) => error.code === "non_tailnet_endpoint");

  const substituted = createClusterPairingClient({
    lookup: async () => [{ address: "100.80.1.2" }],
    fetcher: async () => response({ clusterId: localIdentity.clusterId, node: { ...descriptor, endpoint: "https://different.example-tail.ts.net/" } })
  });
  await assert.rejects(substituted.pair({ endpoint: descriptor.endpoint, localIdentity, pairingCode: "pairing_code_123" }), (error) => error.code === "endpoint_mismatch");

  const oversized = createClusterPairingClient({
    lookup: async () => [{ address: "100.80.1.2" }], maxResponseBytes: 8,
    fetcher: async () => response({ clusterId: localIdentity.clusterId, node: descriptor })
  });
  await assert.rejects(oversized.pair({ endpoint: descriptor.endpoint, localIdentity, pairingCode: "pairing_code_123" }), (error) => error.code === "invalid_shard_response");
});

test("pairing client requires the fixed userspace proxy unless a test explicitly enables direct mode", () => {
  assert.throws(() => createClusterPairingClient({ proxyUrl: "" }), (error) => error.code === "cluster_proxy_required");
});
