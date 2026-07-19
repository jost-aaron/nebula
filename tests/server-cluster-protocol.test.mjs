import assert from "node:assert/strict";
import test from "node:test";
import {
  CLUSTER_MANIFEST_PAGE_LIMIT,
  validateClusterDelegatedMediaGrant,
  validateClusterEndpoint,
  validateClusterManifestPage,
  validateClusterNodeDescriptor,
  validateClusterPairingRequest,
  validateClusterPairingResponse,
  validateClusterSignedEnvelope
} from "../server/cluster/protocol.mjs";

const node = () => ({
  capabilities: { directPlay: true, hls: true, remux: true, renditionProfiles: ["480p", "720p"], transcode: true },
  endpoint: "https://nebula-basement.example-tail.ts.net/",
  name: "Basement",
  nodeId: "node_basement_01",
  protocolVersion: 1,
  publicKey: Buffer.alloc(32, 7).toString("base64url"),
  role: "shard"
});

const source = () => ({
  availability: "available",
  bitrate: 4_000_000,
  durationSeconds: 3600,
  externalIds: [{ mediaType: "movie", provider: "tmdb", providerItemId: "123" }],
  fingerprint: { algorithm: "sha256", digest: "a".repeat(64), sourceRevision: 2, state: "ready" },
  height: 1080,
  itemKind: "movie",
  localItemId: "item_fixture_01",
  localSourceId: "source_fixture_01",
  mediaKind: "video",
  removedAt: null,
  renditions: [{ profileId: "720p", revision: 1, state: "ready" }],
  sizeBytes: 10_000,
  sourceRevision: 2,
  title: "Fixture",
  width: 1920,
  year: 2026
});

test("cluster node descriptors require exact private Tailscale HTTPS origins", () => {
  assert.equal(validateClusterEndpoint(node().endpoint), "https://nebula-basement.example-tail.ts.net");
  assert.equal(validateClusterNodeDescriptor(node()).nodeId, "node_basement_01");
  for (const endpoint of [
    "http://nebula.example-tail.ts.net/",
    "https://user:secret@nebula.example-tail.ts.net/",
    "https://nebula.example-tail.ts.net/api",
    "https://nebula.example-tail.ts.net/?target=http://127.0.0.1",
    "https://attacker.example/"
  ]) assert.throws(() => validateClusterEndpoint(endpoint), /endpoint/);
  assert.throws(() => validateClusterNodeDescriptor({ ...node(), dashboardSocket: "/var/run/docker.sock" }), (error) => error.code === "unknown_field");
});

test("pairing contracts accept only bounded one-time codes and known node fields", () => {
  const request = { clusterId: "cluster_fixture_01", pairingCode: "pairing_code_123", requester: node() };
  assert.equal(validateClusterPairingRequest(request).requester.name, "Basement");
  assert.throws(() => validateClusterPairingRequest({ ...request, pairingCode: "short" }), (error) => error.code === "invalid_pairing_code");
  assert.throws(() => validateClusterPairingRequest({ ...request, requester: { ...node(), protocolVersion: 2 } }), (error) => error.code === "unsupported_protocol");
  assert.equal(validateClusterPairingResponse({ clusterId: request.clusterId, node: node() }).node.nodeId, node().nodeId);
  assert.throws(() => validateClusterPairingResponse({ clusterId: request.clusterId, node: node(), token: "secret" }), (error) => error.code === "unknown_field");
});

test("manifest contracts are path-free, revision-bound, and bounded", () => {
  const manifest = { complete: true, cursor: null, manifestRevision: 4, nodeId: node().nodeId, protocolVersion: 1, sources: [source()] };
  assert.equal(validateClusterManifestPage(manifest).sources[0].title, "Fixture");
  assert.throws(() => validateClusterManifestPage({ ...manifest, sources: [{ ...source(), contentPath: "Movies/Fixture.mkv" }] }), (error) => error.code === "unknown_field");
  assert.throws(() => validateClusterManifestPage({ ...manifest, sources: [{ ...source(), fingerprint: { ...source().fingerprint, sourceRevision: 1 } }] }), (error) => error.code === "revision_mismatch");
  assert.throws(() => validateClusterManifestPage({ ...manifest, sources: Array.from({ length: CLUSTER_MANIFEST_PAGE_LIMIT + 1 }, source) }), (error) => error.code === "manifest_limit");
});

test("signed envelopes reject traversal, query targets, bad signatures, and unknown methods", () => {
  const envelope = {
    bodyDigest: "b".repeat(64), method: "POST", nodeId: node().nodeId, nonce: "nonce_fixture_01",
    path: "/api/shard/v1/health", protocolVersion: 1,
    signature: Buffer.alloc(64, 9).toString("base64url"), timestamp: "2026-07-19T12:00:00.000Z"
  };
  assert.equal(validateClusterSignedEnvelope(envelope).method, "POST");
  for (const path of ["/api/shard/v1/../accounts", "/api/shard/v1/proxy?url=http://localhost", "https://example.com/api/shard/v1/health"]) {
    assert.throws(() => validateClusterSignedEnvelope({ ...envelope, path }), (error) => error.code === "invalid_path");
  }
  assert.throws(() => validateClusterSignedEnvelope({ ...envelope, method: "CONNECT" }), (error) => error.code === "invalid_method");
  assert.throws(() => validateClusterSignedEnvelope({ ...envelope, signature: "not-a-signature" }), (error) => error.code === "invalid_encoding");
});

test("delegated grants are source-scoped, read-only, and short lived", () => {
  const grant = {
    accountId: "account_fixture_01", assetPrefix: "/api/shard/v1/media/grant_fixture_01/", clusterId: "cluster_fixture_01",
    deviceId: "device_fixture_01", expiresAt: "2026-07-19T12:15:00.000Z", federatedItemId: "federated_item_01",
    grantId: "grant_fixture_01", issuedAt: "2026-07-19T12:00:00.000Z", localSourceId: "source_fixture_01",
    methods: ["GET", "HEAD"], nodeId: node().nodeId, nonce: "nonce_fixture_01", profileId: "720p",
    protocolVersion: 1, sessionId: "session_fixture_01", sourceRevision: 2
  };
  assert.equal(validateClusterDelegatedMediaGrant(grant).profileId, "720p");
  assert.throws(() => validateClusterDelegatedMediaGrant({ ...grant, methods: ["DELETE"] }), (error) => error.code === "invalid_method");
  assert.throws(() => validateClusterDelegatedMediaGrant({ ...grant, assetPrefix: "/api/files/" }), (error) => error.code === "invalid_path");
  assert.throws(() => validateClusterDelegatedMediaGrant({ ...grant, expiresAt: "2026-07-19T13:00:00.000Z" }), (error) => error.code === "invalid_expiry");
});
