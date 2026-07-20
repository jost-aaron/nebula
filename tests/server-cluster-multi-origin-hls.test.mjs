import assert from "node:assert/strict";
import test from "node:test";

import { createMultiOriginHlsContract, multiOriginHlsExperimentEnabled } from "../server/cluster/multiOriginHls.mjs";

const digest = (value) => value.repeat(64).slice(0, 64);
const replica = (nodeId, overrides = {}) => ({
  endpoint: `https://${nodeId}.example-tail.ts.net/`,
  fingerprintAlgorithm: "sha256",
  fingerprintByteLength: 10_000,
  fingerprintDigest: digest("a"),
  grant: {
    accountId: "account_fixture_01", expiresAt: "2099-01-01T00:00:00.000Z",
    federatedItemId: "fitem_fixture_01", nodeId, revoked: false,
    sessionId: "session_fixture_01", sourceRevision: 3
  },
  nodeId,
  playlistDigest: digest("b"),
  profileId: "720p",
  profileVersion: 1,
  renditionDigest: digest("c"),
  segments: [
    { byteLength: 4, name: "segment-00000.ts", sha256: digest("d") },
    { byteLength: 5, name: "segment-00001.ts", sha256: digest("e") }
  ],
  sourceRevision: 3,
  ticketUrl: `https://${nodeId}.example-tail.ts.net/api/shard/v1/media/grant_fixture_01/hls/master.m3u8?ticket=ticket_fixture_01`,
  ...overrides
});
const request = (replicas, overrides = {}) => ({
  accountId: "account_fixture_01", enabled: true, federatedItemId: "fitem_fixture_01",
  now: Date.parse("2026-01-01T00:00:00.000Z"), replicas, sessionId: "session_fixture_01", ...overrides
});

test("experiment is exact opt-in and disabled contracts do not alter scheduling", () => {
  assert.equal(multiOriginHlsExperimentEnabled({}), false);
  assert.equal(multiOriginHlsExperimentEnabled({ NEBULA_MULTI_ORIGIN_HLS_EXPERIMENT: "TRUE" }), false);
  assert.equal(multiOriginHlsExperimentEnabled({ NEBULA_MULTI_ORIGIN_HLS_EXPERIMENT: "true" }), true);
  assert.equal(createMultiOriginHlsContract({ ...request([]), enabled: false }), null);
});

test("contract accepts only two or more byte-identical rendition maps", () => {
  const contract = createMultiOriginHlsContract(request([replica("node_alpha"), replica("node_bravo")]));
  assert.equal(contract.origins.length, 2);
  assert.equal(contract.segmentMap.length, 2);
  assert.equal(contract.renditionDigest, digest("c"));
  assert.equal(JSON.stringify(contract).includes("storage"), false);
});

test("contract rejects alternate sources, profiles, revisions, maps, and tampered segments", () => {
  for (const changed of [
    { fingerprintDigest: digest("f") }, { sourceRevision: 4, grant: replica("node_bravo").grant },
    { profileId: "480p" }, { profileVersion: 2 }, { renditionDigest: digest("f") },
    { playlistDigest: digest("f") },
    { segments: [{ byteLength: 4, name: "segment-00000.ts", sha256: digest("f") }] }
  ]) {
    assert.throws(() => createMultiOriginHlsContract(request([replica("node_alpha"), replica("node_bravo", changed)])), /same exact rendition|scope/);
  }
});

test("contract rejects wrong account, session, item, origin, expiry, and revocation", () => {
  const base = replica("node_bravo");
  for (const grant of [
    { ...base.grant, accountId: "account_fixture_02" },
    { ...base.grant, sessionId: "session_fixture_02" },
    { ...base.grant, federatedItemId: "fitem_fixture_02" },
    { ...base.grant, expiresAt: "2020-01-01T00:00:00.000Z" },
    { ...base.grant, revoked: true }
  ]) assert.throws(() => createMultiOriginHlsContract(request([replica("node_alpha"), { ...base, grant }])), /grant/);
  assert.throws(() => createMultiOriginHlsContract(request([replica("node_alpha"), { ...base, ticketUrl: "https://wrong.example-tail.ts.net/x?ticket=x" }])), /ticket/);
  assert.throws(() => createMultiOriginHlsContract(request([replica("node_alpha"), { ...base, ticketUrl: "https://node_bravo.example-tail.ts.net/api/shard/v1/media/grant_fixture_01/hls/segment-00000.ts?ticket=x" }])), /ticket/);
  assert.throws(() => createMultiOriginHlsContract(request([replica("node_alpha"), { ...base, ticketUrl: `${base.ticketUrl}&extra=denied` }])), /ticket/);
  assert.throws(() => createMultiOriginHlsContract(request([replica("node_alpha"), { ...base, ticketUrl: "not a URL" }])), /ticket/);
});
