import assert from "node:assert/strict";
import test from "node:test";
import {
  CLUSTER_KEY_ROTATION_PREPARE_PATH, createClusterKeyRotationClient
} from "../server/cluster/index.mjs";

const endpoint = "https://shard.tail024251.ts.net";
const payload = {
  clusterId: "cluster_fixture_01",
  expiresAt: "2026-07-19T12:15:00.000Z",
  newKeyVersion: 2,
  newPublicKey: Buffer.alloc(32, 2).toString("base64url"),
  nodeId: "node_home_0001",
  oldKeyVersion: 1,
  oldPublicKey: Buffer.alloc(32, 1).toString("base64url"),
  rotationId: "rotation_fixture_01"
};
const ack = { keyVersion: 2, nodeId: "node_shard_001", rotationId: payload.rotationId, state: "prepared" };

test("key rotation client pins the exact route and consumes a bounded signed response", async () => {
  const requests = [];
  const client = createClusterKeyRotationClient({ allowDirect: true, proxyUrl: null, fetcher: async (url, options) => {
    requests.push({ options, url });
    return new Response(JSON.stringify({ envelope: { signed: true }, payload: ack }), { status: 200 });
  } });
  const result = await client.prepare({ endpoint, envelope: { signed: true }, payload });
  assert.deepEqual(result.payload, ack);
  assert.equal(requests[0].url, `${endpoint}${CLUSTER_KEY_ROTATION_PREPARE_PATH}`);
  assert.equal(requests[0].options.redirect, "error");
});

test("key rotation client cancels an oversized response body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() { cancelled = true; },
    start(controller) { controller.enqueue(new Uint8Array(65)); }
  });
  const client = createClusterKeyRotationClient({
    allowDirect: true, maxResponseBytes: 64, proxyUrl: null,
    fetcher: async () => new Response(body, { status: 200 })
  });
  await assert.rejects(client.prepare({ endpoint, envelope: {}, payload }), { code: "invalid_shard_response" });
  assert.equal(cancelled, true);
});

test("key rotation deadline remains active through body consumption and cancels the reader", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() { cancelled = true; },
    pull() { return new Promise(() => {}); }
  });
  const client = createClusterKeyRotationClient({
    allowDirect: true, proxyUrl: null, timeoutMs: 5,
    fetcher: async () => new Response(body, { status: 200 })
  });
  await assert.rejects(client.prepare({ endpoint, envelope: {}, payload }), { code: "shard_unreachable" });
  assert.equal(cancelled, true);
});
