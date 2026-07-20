import assert from "node:assert/strict";
import test from "node:test";
import { createClusterPlaybackService } from "../server/cluster/index.mjs";

const request = { capabilities: { deviceId: "device_fixture_01", supportsHls: true }, federatedItemId: "fitem_fixture_01", preferredProfileId: "original" };
const session = (candidate) => ({ internal: { accountId: "account_fixture_01", candidate, federatedItemId: request.federatedItemId, id: "cluster_session_fixture_01", request }, session: { candidate: { nodeId: candidate.nodeId }, id: "cluster_session_fixture_01" } });

test("remote playback activates one signed grant and returns a direct sanitized shard URL", async () => {
  let issued = null; let activated = null;
  const candidate = { decision: "direct-play", endpoint: "https://basement.tail024251.ts.net", federatedSourceId: "fsource_fixture_01", local: false, localSourceId: "source_fixture_01", mode: "original", nodeId: "node_fixture_01", sourceRevision: 3 };
  const scheduler = { create: () => session(candidate), release: () => assert.fail("should not release") };
  const grants = { issue: (value) => { issued = value; return { envelope: { signed: true }, grant: { assetPrefix: "/api/shard/v1/media/grant_fixture_01/", expiresAt: "2026-07-19T12:10:00.000Z", grantId: "grant_fixture_01" } }; } };
  const client = { activate: async (value) => { activated = value; return { expiresAt: "2026-07-19T12:10:00.000Z", grantId: "grant_fixture_01", mediaTicket: "ticket_fixture_01" }; } };
  const playback = createClusterPlaybackService({ client, grants, scheduler });
  const result = await playback.create(request, { accountId: "account_fixture_01" });
  assert.equal(issued.accountId, "account_fixture_01");
  assert.equal(activated.endpoint, candidate.endpoint);
  assert.equal(result.session.deliveryUrl, "https://basement.tail024251.ts.net/api/shard/v1/media/grant_fixture_01/file?ticket=ticket_fixture_01");
  assert.doesNotMatch(JSON.stringify(result), /localSourceId|endpoint|account_fixture/);
});

test("local playback delegates to the existing delivery engine", async () => {
  const candidate = { decision: "direct-play", federatedSourceId: "fsource_fixture_01", local: true, localItemId: "item_fixture_01", localSourceId: "source_fixture_01", mode: "original", nodeId: "node_fixture_01", sourceRevision: 1 };
  let localRequest = null;
  let cancelled = null; let released = null;
  const scheduler = { create: () => session(candidate), release: (id) => { released = id; } };
  const localDelivery = {
    cancel: async (id, principal) => { cancelled = { id, principal }; },
    create: async (value, principal) => { localRequest = { principal, value }; return { plan: { decision: "direct-play" }, session: { deliveryUrl: "/api/playback/delivery-sessions/local/file", id: "local" } }; }
  };
  const playback = createClusterPlaybackService({ client: {}, grants: {}, localDelivery, scheduler });
  const result = await playback.create(request, { accountId: "account_fixture_01" });
  assert.deepEqual(localRequest.value, { capabilities: request.capabilities, itemId: candidate.localItemId, quality: { mode: "original" }, sourceId: candidate.localSourceId, startPositionSeconds: null });
  assert.deepEqual(localRequest.principal, { type: "user", userId: "account_fixture_01" });
  assert.equal(result.session.deliveryUrl, "/api/playback/delivery-sessions/local/file");
  await playback.release(result.session.id, { accountId: "account_fixture_01" });
  assert.deepEqual(cancelled, { id: "local", principal: { type: "user", userId: "account_fixture_01" } });
  assert.equal(released, "cluster_session_fixture_01");
});

test("failed local activation releases scheduler capacity", async () => {
  const candidate = { decision: "direct-play", local: true, localItemId: "item_fixture_01", localSourceId: "source_fixture_01", mode: "original", nodeId: "node_fixture_01" };
  let released = null;
  const scheduler = { create: () => session(candidate), release: (id) => { released = id; } };
  const localDelivery = { create: async () => { throw new Error("planner failed"); } };
  const playback = createClusterPlaybackService({ client: {}, grants: {}, localDelivery, scheduler });
  await assert.rejects(playback.create(request, { accountId: "account_fixture_01" }), /planner failed/);
  assert.equal(released, "cluster_session_fixture_01");
});

test("unsupported remote modes release scheduling capacity", async () => {
  let released = null;
  const candidate = { decision: "transcode", endpoint: "https://basement.tail024251.ts.net", local: false, mode: "live-transcode", nodeId: "node_fixture_01" };
  const scheduler = { create: () => session(candidate), release: (id) => { released = id; } };
  const playback = createClusterPlaybackService({ client: {}, grants: {}, scheduler });
  await assert.rejects(playback.create(request, { accountId: "account_fixture_01" }), { code: "remote_delivery_mode_pending" });
  assert.equal(released, "cluster_session_fixture_01");
});
