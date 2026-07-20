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
  const playback = createClusterPlaybackService({
    authorize: ({ accountId, federatedItemId }) => accountId === "account_fixture_01" && federatedItemId === request.federatedItemId,
    client, grants, scheduler
  });
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

test("remote generated delivery is polled and activated with a delivery-bound HLS grant", async () => {
  const candidate = { decision: "transcode", endpoint: "https://basement.tail024251.ts.net", federatedSourceId: "fsource_fixture_01", local: false, localItemId: "item_fixture_01", localSourceId: "source_fixture_01", mode: "live-transcode", nodeId: "node_fixture_01", sourceRevision: 4 };
  const scheduled = session(candidate);
  const scheduler = { create: () => scheduled, get: () => scheduled.session, release: () => assert.fail("should not release") };
  const result = { decision: "transcode", deliveryId: "delivery_fixture_01", output: { protocol: "hls" }, reasons: [], status: "queued" };
  let issued = null;
  const deliveryClient = {
    create: async () => result,
    get: async () => ({ ...result, status: "ready" })
  };
  const grants = { issue: (value) => {
    issued = value;
    return { grant: { assetPrefix: "/api/shard/v1/media/grant_fixture_01/" } };
  } };
  const client = { activate: async () => ({ expiresAt: "2026-07-19T12:10:00.000Z", mediaTicket: "ticket_fixture_01" }) };
  const playback = createClusterPlaybackService({
    authorize: ({ accountId, federatedItemId }) => accountId === "account_fixture_01" && federatedItemId === request.federatedItemId,
    client, deliveryClient, grants, scheduler
  });
  const created = await playback.create(request, { accountId: "account_fixture_01" });
  assert.equal(created.session.status, "queued");
  const ready = await playback.get(created.session.id, { accountId: "account_fixture_01" });
  assert.equal(issued.delivery.deliveryId, "delivery_fixture_01");
  assert.equal(ready.session.deliveryUrl, "https://basement.tail024251.ts.net/api/shard/v1/media/grant_fixture_01/hls/master.m3u8?ticket=ticket_fixture_01");
  assert.doesNotMatch(JSON.stringify(ready), /localItemId|localSourceId|endpoint|account_fixture/);
});

test("generated delivery plan mismatch releases shard delivery and scheduler capacity", async () => {
  let cancelled = null; let released = null;
  const candidate = { decision: "transcode", endpoint: "https://basement.tail024251.ts.net", local: false, localItemId: "item_fixture_01", localSourceId: "source_fixture_01", mode: "live-transcode", nodeId: "node_fixture_01", sourceRevision: 1 };
  const scheduler = { create: () => session(candidate), release: (id) => { released = id; } };
  const deliveryClient = {
    cancel: async (_endpoint, payload) => { cancelled = payload; },
    create: async () => ({ decision: "remux", deliveryId: "delivery_fixture_01", output: { protocol: "file" }, reasons: [], status: "ready" })
  };
  const playback = createClusterPlaybackService({ client: {}, deliveryClient, grants: {}, scheduler });
  await assert.rejects(playback.create(request, { accountId: "account_fixture_01" }), { code: "shard_delivery_plan_mismatch" });
  assert.equal(cancelled, null);
  assert.equal(released, "cluster_session_fixture_01");
});

test("abandoned coordinator sessions expire without status refresh and release exactly once", async () => {
  let currentTime = 1_000;
  let sweep = null;
  let timerCleared = 0;
  let schedulerReleases = 0;
  let shardCancels = 0;
  const candidate = { decision: "transcode", endpoint: "https://basement.tail024251.ts.net", federatedSourceId: "fsource_fixture_01", local: false, localItemId: "item_fixture_01", localSourceId: "source_fixture_01", mode: "live-transcode", nodeId: "node_fixture_01", sourceRevision: 4 };
  const scheduled = session(candidate);
  scheduled.session.expiresAt = new Date(1_050).toISOString();
  const scheduler = {
    create: () => scheduled,
    get: () => scheduled.session,
    release: () => { schedulerReleases += 1; }
  };
  const result = { decision: "transcode", deliveryId: "delivery_fixture_01", output: { protocol: "hls" }, reasons: [], status: "queued" };
  const playback = createClusterPlaybackService({
    client: {},
    deliveryClient: {
      cancel: async () => { shardCancels += 1; },
      create: async () => result,
      get: async () => result
    },
    grants: {},
    scheduler,
    now: () => currentTime,
    sessionTtlMs: 50,
    setTimer: (callback) => { sweep = callback; return { unref() {} }; },
    clearTimer: () => { timerCleared += 1; }
  });

  const created = await playback.create(request, { accountId: "account_fixture_01" });
  currentTime = 1_040;
  assert.equal((await playback.get(created.session.id, { accountId: "account_fixture_01" })).session.status, "queued");
  currentTime = 1_050;
  sweep();
  await new Promise(setImmediate);
  assert.equal(shardCancels, 1);
  assert.equal(schedulerReleases, 1);
  await assert.rejects(playback.get(created.session.id, { accountId: "account_fixture_01" }), { code: "cluster_playback_session_not_found" });
  await playback.shutdown();
  await playback.shutdown();
  assert.equal(shardCancels, 1);
  assert.equal(schedulerReleases, 1);
  assert.equal(timerCleared, 1);
});

test("delivery creation finishing after coordinator expiry is cancelled without reclaiming capacity", async () => {
  let currentTime = 3_000;
  let sweep = null;
  let finishCreate;
  let schedulerReleases = 0;
  let shardCancels = 0;
  const candidate = { decision: "transcode", endpoint: "https://basement.tail024251.ts.net", federatedSourceId: "fsource_fixture_01", local: false, localItemId: "item_fixture_01", localSourceId: "source_fixture_01", mode: "live-transcode", nodeId: "node_fixture_01", sourceRevision: 4 };
  const scheduled = session(candidate);
  scheduled.session.expiresAt = new Date(3_050).toISOString();
  const playback = createClusterPlaybackService({
    client: {}, grants: {}, now: () => currentTime, sessionTtlMs: 50,
    scheduler: { create: () => scheduled, release: () => { schedulerReleases += 1; } },
    deliveryClient: {
      create: () => new Promise((resolve) => { finishCreate = resolve; }),
      cancel: async () => { shardCancels += 1; }
    },
    setTimer: (callback) => { sweep = callback; return { unref() {} }; }, clearTimer: () => undefined
  });
  const pending = playback.create(request, { accountId: "account_fixture_01" });
  await Promise.resolve();
  currentTime = 3_050;
  sweep();
  await new Promise(setImmediate);
  finishCreate({ decision: "transcode", deliveryId: "delivery_fixture_01", output: { protocol: "hls" }, reasons: [], status: "queued" });
  await assert.rejects(pending, { code: "cluster_playback_session_expired" });
  assert.equal(schedulerReleases, 1);
  assert.equal(shardCancels, 1);
  await playback.shutdown();
  assert.equal(shardCancels, 1);
});

test("changed member permissions release sessions and block polling, failover, release, and fresh grants", async () => {
  const candidate = { decision: "direct-play", endpoint: "https://basement.tail024251.ts.net", exactReplicaKey: "sha256:fixture", federatedSourceId: "fsource_fixture_01", local: false, localSourceId: "source_fixture_01", mode: "original", nodeId: "node_fixture_01", sourceRevision: 3 };
  let allowed = true;
  let grantsIssued = 0;
  let releases = 0;
  const sessions = new Map();
  let next = 0;
  const scheduler = {
    create: () => {
      const value = session(candidate);
      value.internal.id = value.session.id = `cluster_session_fixture_0${++next}`;
      sessions.set(value.session.id, value);
      return value;
    },
    failover: () => assert.fail("authorization must run before failover"),
    get: (id) => sessions.get(id).session,
    release: (id) => { releases += 1; sessions.delete(id); }
  };
  const playback = createClusterPlaybackService({
    authorize: () => allowed,
    client: { activate: async ({ grant }) => ({ expiresAt: grant.expiresAt, mediaTicket: "ticket_fixture_01" }) },
    grants: { issue: () => {
      grantsIssued += 1;
      return { grant: { assetPrefix: "/api/shard/v1/media/grant_fixture_01/", expiresAt: "2026-07-19T12:10:00.000Z" } };
    } },
    scheduler
  });

  const first = await playback.create(request, { accountId: "account_fixture_01" });
  assert.equal(grantsIssued, 1);
  allowed = false;
  await assert.rejects(playback.get(first.session.id, { accountId: "account_fixture_01" }), { code: "cluster_item_not_found" });
  assert.equal(releases, 1);
  await assert.rejects(playback.create(request, { accountId: "account_fixture_01" }), { code: "cluster_item_not_found" });
  assert.equal(grantsIssued, 1);

  allowed = true;
  const second = await playback.create(request, { accountId: "account_fixture_01" });
  allowed = false;
  await assert.rejects(playback.failover(second.session.id, { accountId: "account_fixture_01" }, candidate.nodeId), { code: "cluster_item_not_found" });
  assert.equal(releases, 2);

  allowed = true;
  const third = await playback.create(request, { accountId: "account_fixture_01" });
  allowed = false;
  await assert.rejects(playback.release(third.session.id, { accountId: "account_fixture_01" }), { code: "cluster_item_not_found" });
  assert.equal(releases, 3);
  await playback.shutdown();
});

test("authorized member failover preserves account and logical-item grant binding", async () => {
  const first = { decision: "direct-play", endpoint: "https://first.tail024251.ts.net", exactReplicaKey: "sha256:fixture", federatedSourceId: "fsource_first_01", local: false, localSourceId: "source_first_01", mode: "original", nodeId: "node_first_01", sourceRevision: 3 };
  const second = { ...first, endpoint: "https://second.tail024251.ts.net", federatedSourceId: "fsource_second_01", localSourceId: "source_second_01", nodeId: "node_second_01" };
  const scheduled = session(first);
  const issued = [];
  const scheduler = {
    create: () => scheduled,
    failover: () => ({ ...scheduled, internal: { ...scheduled.internal, candidate: second }, session: { ...scheduled.session, candidate: { nodeId: second.nodeId } } }),
    release: () => undefined
  };
  const playback = createClusterPlaybackService({
    authorize: ({ accountId, federatedItemId }) => accountId === "account_fixture_01" && federatedItemId === request.federatedItemId,
    client: { activate: async ({ grant }) => ({ expiresAt: grant.expiresAt, mediaTicket: "ticket_fixture_01" }) },
    grants: { issue: (value) => {
      issued.push(value);
      return { grant: { assetPrefix: `/api/shard/v1/media/grant_fixture_0${issued.length}/`, expiresAt: "2026-07-19T12:10:00.000Z" } };
    } },
    scheduler
  });
  const created = await playback.create(request, { accountId: "account_fixture_01" });
  const failedOver = await playback.failover(created.session.id, { accountId: "account_fixture_01" }, first.nodeId);
  assert.equal(failedOver.session.candidate.nodeId, second.nodeId);
  assert.deepEqual(issued.map(({ accountId, federatedItemId, candidate }) => ({ accountId, federatedItemId, nodeId: candidate.nodeId })), [
    { accountId: "account_fixture_01", federatedItemId: request.federatedItemId, nodeId: first.nodeId },
    { accountId: "account_fixture_01", federatedItemId: request.federatedItemId, nodeId: second.nodeId }
  ]);
  await playback.shutdown();
});
