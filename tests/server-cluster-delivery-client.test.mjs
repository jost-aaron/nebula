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
