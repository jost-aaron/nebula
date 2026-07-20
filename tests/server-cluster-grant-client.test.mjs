import assert from "node:assert/strict";
import test from "node:test";
import { createClusterGrantClient } from "../server/cluster/index.mjs";

const grant = {
  accountId: "account_fixture_01", assetPrefix: "/api/shard/v1/media/grant_fixture_01/", clientOrigin: "https://home.tail024251.ts.net", clusterId: "cluster_fixture_01",
  deviceId: "device_fixture_01", expiresAt: "2026-07-19T12:10:00.000Z", federatedItemId: "fitem_fixture_01",
  grantId: "grant_fixture_01", issuedAt: "2026-07-19T12:00:00.000Z", localSourceId: "source_fixture_01",
  methods: ["GET", "HEAD"], nodeId: "node_fixture_01", nonce: "nonce_fixture_01", profileId: "original",
  protocolVersion: 1, sessionId: "session_fixture_01", sourceRevision: 1
};

test("grant client uses only the exact shard endpoint with bounded strict output", async () => {
  let request = null;
  const client = createClusterGrantClient({ allowDirect: true, fetcher: async (url, options) => {
    request = { options, url };
    return new Response(JSON.stringify({ expiresAt: grant.expiresAt, grantId: grant.grantId, mediaTicket: "t".repeat(43) }), { status: 201 });
  }, proxyUrl: null });
  const result = await client.activate({ endpoint: "https://basement.tail024251.ts.net/", envelope: { signed: true }, grant });
  assert.equal(result.grantId, grant.grantId);
  assert.equal(request.url, "https://basement.tail024251.ts.net/api/shard/v1/playback/grants/validate");
  assert.equal(request.options.redirect, "error");
  assert.deepEqual(JSON.parse(request.options.body), { envelope: { signed: true }, grant });
});

test("grant client rejects endpoint and response substitution", async () => {
  const client = createClusterGrantClient({ allowDirect: true, fetcher: async () => new Response(JSON.stringify({ expiresAt: grant.expiresAt, grantId: "grant_attacker_01", mediaTicket: "t".repeat(43) }), { status: 201 }), proxyUrl: null });
  await assert.rejects(client.activate({ endpoint: "https://basement.tail024251.ts.net/", envelope: {}, grant }), { code: "invalid_shard_response" });
  await assert.rejects(client.activate({ endpoint: "https://example.com/", envelope: {}, grant }), { code: "invalid_endpoint" });
});
