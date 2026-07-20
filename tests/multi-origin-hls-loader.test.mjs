import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";

import { createMultiOriginHlsLoader, createVerifiedMultiOriginFetcher, multiOriginHlsClientExperimentEnabled } from "../src/cinema/multiOriginHlsLoader.ts";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const bytes = Buffer.from("verified-segment");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const contract = {
  expiresAt: "2099-01-01T00:00:00.000Z",
  origins: [
    { endpoint: "https://alpha.example-tail.ts.net", nodeId: "node_alpha", ticketUrl: "https://alpha.example-tail.ts.net/api/shard/v1/media/grant_alpha/hls/master.m3u8?ticket=alpha_secret" },
    { endpoint: "https://bravo.example-tail.ts.net", nodeId: "node_bravo", ticketUrl: "https://bravo.example-tail.ts.net/api/shard/v1/media/grant_bravo/hls/master.m3u8?ticket=bravo_secret" }
  ],
  segmentMap: [{ byteLength: bytes.length, name: "segment-00000.ts", sha256 }]
};

test("verified fetch retries another approved origin after integrity failure", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ options, url: String(url) });
    const body = calls.length === 1 ? Buffer.from("tampered-segment") : bytes;
    return new Response(body, { headers: { "content-length": String(body.length) } });
  };
  const result = await createVerifiedMultiOriginFetcher(contract, { fetcher }).load("segment-00000.ts");
  assert.deepEqual(Buffer.from(result.data), bytes);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.referrerPolicy, "no-referrer");
  assert.match(calls[0].url, /alpha_secret/);
  assert.match(calls[1].url, /bravo_secret/);
});

test("client loader is exact opt-in and defaults off", () => {
  assert.equal(multiOriginHlsClientExperimentEnabled(), false);
  assert.equal(multiOriginHlsClientExperimentEnabled("TRUE"), false);
  assert.equal(multiOriginHlsClientExperimentEnabled("true"), true);
  assert.throws(() => createMultiOriginHlsLoader(contract), /disabled/);
});

test("selector rejects unknown, oversized, expired, and stalled segments with bounded attempts", async () => {
  await assert.rejects(createVerifiedMultiOriginFetcher(contract, { fetcher: async () => new Response(bytes) }).load("segment-99999.ts"), /not approved/);
  assert.throws(() => createVerifiedMultiOriginFetcher(contract, { maxBodyBytes: bytes.length - 1 }), /segment map/);
  await assert.rejects(createVerifiedMultiOriginFetcher({ ...contract, expiresAt: "2020-01-01T00:00:00.000Z" }).load("segment-00000.ts"), /expired/);
  let oversizedAttempts = 0;
  await assert.rejects(createVerifiedMultiOriginFetcher(contract, {
    fetcher: async () => { oversizedAttempts += 1; return new Response(Buffer.concat([bytes, Buffer.from("excess")])); }
  }).load("segment-00000.ts"), /bound/);
  assert.equal(oversizedAttempts, 2);
  let attempts = 0;
  const stalled = (_url, { signal }) => new Promise((_resolve, reject) => {
    attempts += 1;
    signal.addEventListener("abort", () => reject(Object.assign(new Error("stalled"), { name: "AbortError" })), { once: true });
  });
  await assert.rejects(createVerifiedMultiOriginFetcher(contract, { fetcher: stalled, timeoutMs: 5, maxRetries: 1 }).load("segment-00000.ts"));
  assert.equal(attempts, 2);
});

test("HLS-compatible loader coalesces duplicate requests and invokes success once", async () => {
  let requests = 0;
  const Loader = createMultiOriginHlsLoader(contract, { fetcher: async () => { requests += 1; return new Response(bytes); } }, { enabled: true });
  const first = new Loader();
  const second = new Loader();
  let successes = 0;
  const done = new Promise((resolve, reject) => {
    const callbacks = { onError: reject, onTimeout: reject, onSuccess: () => { successes += 1; if (successes === 2) resolve(); } };
    first.load({ url: "https://coordinator.invalid/segment-00000.ts" }, {}, callbacks);
    second.load({ url: "https://coordinator.invalid/segment-00000.ts" }, {}, callbacks);
  });
  await done;
  assert.equal(requests, 1);
  assert.equal(successes, 2);
});
