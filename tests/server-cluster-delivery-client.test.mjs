import assert from "node:assert/strict";
import test from "node:test";
import { createClusterDeliveryClient } from "../server/cluster/index.mjs";

const endpoint = "https://basement.tail024251.ts.net";
const result = {
  decision: "transcode",
  deliveryId: "delivery_fixture_01",
  output: { audioCodec: "aac", bitrate: 4_000_000, container: "mpegts", height: 720, profileId: "720p", protocol: "hls", videoCodec: "h264", width: 1280 },
  reasons: [{ code: "VIDEO_PROFILE", message: "A compatible profile is required.", streamIndex: 0 }],
  status: "running"
};
const trust = (peerEndpoint = endpoint) => ({
  signRequest: ({ body, path }) => ({ body, path, signed: true }),
  verifyRequest: () => ({ endpoint: peerEndpoint, nodeId: "node_shard_01" })
});
const signedResponse = (payload = result, init = {}) => new Response(JSON.stringify({ envelope: { signed: true }, payload }), { status: 200, ...init });
const controlledTimer = () => {
  let active = false; let callback; let cleared = 0;
  return {
    clearTimeoutFn: () => { active = false; cleared += 1; },
    get cleared() { return cleared; },
    setTimeoutFn: (next) => { active = true; callback = next; return { unref() {} }; },
    trigger: () => { if (active) callback(); }
  };
};
const clientWith = (fetcher, timer, options = {}) => createClusterDeliveryClient({
  allowDirect: true, clearTimeoutFn: timer.clearTimeoutFn, fetcher, proxyUrl: null,
  setTimeoutFn: timer.setTimeoutFn, timeoutMs: 10, trust: trust(), ...options
});

test("delivery client pins fixed signed routes and accepts bounded delivery status", async () => {
  const requests = [];
  const client = createClusterDeliveryClient({ allowDirect: true, proxyUrl: null, trust: trust(), fetcher: async (url, options) => {
    requests.push({ options, url });
    return new Response(JSON.stringify({ envelope: { signed: true }, payload: result }), { status: 201 });
  } });
  assert.deepEqual(await client.create(endpoint, { clusterSessionId: "cluster_session_fixture_01" }), result);
  assert.equal(requests[0].url, `${endpoint}/api/shard/v1/playback/delivery`);
  assert.equal(requests[0].options.redirect, "error");
});

test("delivery client rejects endpoint substitution and path-bearing shard output", async () => {
  const response = (payload) => async () => new Response(JSON.stringify({ envelope: { signed: true }, payload }), { status: 200 });
  const substituted = createClusterDeliveryClient({ allowDirect: true, proxyUrl: null, trust: trust("https://attacker.tail024251.ts.net"), fetcher: response(result) });
  await assert.rejects(substituted.get(endpoint, {}), { code: "endpoint_mismatch" });
  const unsafe = createClusterDeliveryClient({ allowDirect: true, proxyUrl: null, trust: trust(), fetcher: response({ ...result, output: { ...result.output, path: "/tmp/media" } }) });
  await assert.rejects(unsafe.get(endpoint, {}), { code: "invalid_shard_response" });
});

test("delivery client deadline aborts a request waiting for response headers", async () => {
  const timer = controlledTimer();
  let signal;
  const client = clientWith((_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  }, timer);
  const pending = client.create(endpoint, {});
  await Promise.resolve();
  timer.trigger();
  await assert.rejects(pending, { code: "shard_unreachable" });
  assert.equal(signal.aborted, true);
  assert.equal(timer.cleared, 1);
});

test("delivery client deadline cancels a response body that stalls after headers", async () => {
  const timer = controlledTimer();
  let cancelled = false;
  const body = new ReadableStream({ cancel: () => { cancelled = true; } });
  const client = clientWith(async () => new Response(body, { status: 200 }), timer);
  const pending = client.get(endpoint, {});
  await Promise.resolve();
  timer.trigger();
  await assert.rejects(pending, { code: "shard_unreachable" });
  assert.equal(cancelled, true);
  assert.equal(timer.cleared, 1);
});

test("delivery client cancels an oversized body while it is dripping chunks", async () => {
  const timer = controlledTimer();
  let cancelled = false; let stream;
  const body = new ReadableStream({
    cancel: () => { cancelled = true; },
    start: (controller) => { stream = controller; }
  });
  const client = clientWith(async () => new Response(body, { status: 200 }), timer, { maxResponseBytes: 8 });
  const pending = client.get(endpoint, {});
  stream.enqueue(Buffer.from("1234"));
  await Promise.resolve();
  stream.enqueue(Buffer.from("56789"));
  await assert.rejects(pending, { code: "invalid_shard_response" });
  assert.equal(cancelled, true);
  assert.equal(timer.cleared, 1);
});

test("delivery client clears its deadline after a successful bounded response", async () => {
  const timer = controlledTimer();
  let signal;
  const client = clientWith(async (_url, options) => {
    signal = options.signal;
    return signedResponse();
  }, timer);
  assert.deepEqual(await client.get(endpoint, {}), result);
  assert.equal(timer.cleared, 1);
  timer.trigger();
  assert.equal(signal.aborted, false);
});
