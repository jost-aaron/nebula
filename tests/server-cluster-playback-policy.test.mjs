import assert from "node:assert/strict";
import test from "node:test";
import { createClusterPlaybackService } from "../server/cluster/index.mjs";
import { createPlaybackPolicyService } from "../server/playbackPolicy/index.mjs";

const baseRequest = () => ({
  capabilities: { deviceId: "device_fixture_01", maxBitrate: 8_000_000, supportsHls: true },
  federatedItemId: "fitem_fixture_01",
  preferredProfileId: "720p"
});
const candidate = (mode = "live-transcode", overrides = {}) => ({
  decision: mode === "remux" ? "remux" : "transcode",
  endpoint: "https://shard.tail024251.ts.net",
  federatedSourceId: "fsource_fixture_01",
  local: false,
  localItemId: "item_fixture_01",
  localSourceId: "source_fixture_01",
  mode,
  nodeId: "node_fixture_01",
  sourceRevision: 3,
  ...overrides
});
const generatedResult = (mode = "live-transcode", overrides = {}) => ({
  decision: mode === "remux" ? "remux" : "transcode",
  deliveryId: "delivery_fixture_01",
  output: {
    bitrate: 4_000_000,
    protocol: mode === "remux" ? "file" : "hls",
    ...(mode === "prebuilt-rendition" ? { profileId: "720p" } : {})
  },
  reasons: [],
  status: "ready",
  ...overrides
});
const scheduled = (request, selected, id = "cluster_session_fixture_01") => ({
  internal: {
    accountId: "account_fixture_01",
    candidate: selected,
    federatedItemId: request.federatedItemId,
    id,
    request
  },
  session: { candidate: { nodeId: selected.nodeId }, id }
});
const grants = {
  issue: () => ({ grant: { assetPrefix: "/api/shard/v1/media/grant_fixture_01/", expiresAt: "2099-01-01T00:00:00.000Z" } })
};
const client = {
  activate: async ({ grant }) => ({ expiresAt: grant.expiresAt, mediaTicket: "ticket_fixture_01" })
};
const fakePolicy = ({ maxBitrate = 4_000_000 } = {}) => {
  const state = { admits: [], releases: [], validations: [] };
  return {
    state,
    service: {
      admit: (facts) => {
        state.admits.push(facts);
        let released = false;
        return {
          maxProducedBitrate: maxBitrate,
          release: () => {
            if (released) return;
            released = true;
            state.releases.push(facts.sessionId);
          }
        };
      },
      constraints: () => ({ maxBitrate, maxConcurrentStreams: null }),
      validate: (facts) => {
        state.validations.push(facts);
        return { maxProducedBitrate: maxBitrate };
      }
    }
  };
};
const playbackFor = ({
  deliveryClient, localDelivery = null, playbackPolicy = null, selected = candidate(),
  schedulerOverrides = {}, serviceOverrides = {}
} = {}) => {
  let requestSeen = null;
  const scheduler = {
    create: (request) => {
      requestSeen = request;
      return scheduled(request, selected);
    },
    get: (id) => ({ candidate: { nodeId: selected.nodeId }, id }),
    release: () => undefined,
    ...schedulerOverrides
  };
  return {
    playback: createClusterPlaybackService({
      client, deliveryClient, grants, localDelivery, playbackPolicy, scheduler, ...serviceOverrides
    }),
    requestSeen: () => requestSeen
  };
};

test("account bitrate is clamped before scheduling and forwarded without mutating caller input", async () => {
  const policy = fakePolicy();
  let remoteRequest = null;
  const original = baseRequest();
  const snapshot = structuredClone(original);
  const scope = playbackFor({
    playbackPolicy: policy.service,
    deliveryClient: {
      create: async (_endpoint, request) => { remoteRequest = request; return generatedResult(); },
      cancel: async () => undefined
    }
  });

  await scope.playback.create(original, { accountId: "account_fixture_01" });
  assert.deepEqual(original, snapshot);
  assert.notEqual(scope.requestSeen(), original);
  assert.notEqual(scope.requestSeen().capabilities, original.capabilities);
  assert.equal(scope.requestSeen().capabilities.maxBitrate, 4_000_000);
  assert.equal(remoteRequest.capabilities.maxBitrate, 4_000_000);
  assert.equal(policy.state.admits[0].requestedBitrate, 4_000_000);
  await scope.playback.shutdown();
});

test("remote direct play and local candidates do not allocate coordinator policy leases", async () => {
  const policy = fakePolicy();
  const direct = candidate("original", { decision: "direct-play" });
  const remote = playbackFor({ playbackPolicy: policy.service, selected: direct });
  await remote.playback.create(baseRequest(), { accountId: "account_fixture_01" });

  let localCreates = 0;
  const local = playbackFor({
    localDelivery: {
      cancel: async () => undefined,
      create: async () => {
        localCreates += 1;
        return { plan: { decision: "transcode" }, session: { deliveryUrl: "/local/hls", id: "local_delivery_01" } };
      }
    },
    playbackPolicy: policy.service,
    selected: candidate("live-transcode", { local: true })
  });
  await local.playback.create(baseRequest(), { accountId: "account_fixture_01" });
  assert.equal(localCreates, 1);
  assert.equal(policy.state.admits.length, 0);
  await Promise.all([remote.playback.shutdown(), local.playback.shutdown()]);
});

test("each remote generated mode allocates exactly one lease and revalidates it before its grant", async () => {
  for (const mode of ["remux", "live-transcode", "prebuilt-rendition"]) {
    const policy = fakePolicy();
    const scope = playbackFor({
      playbackPolicy: policy.service,
      selected: candidate(mode),
      deliveryClient: {
        create: async () => generatedResult(mode),
        cancel: async () => undefined
      }
    });
    const result = await scope.playback.create(baseRequest(), { accountId: "account_fixture_01" });
    assert.equal(policy.state.admits.length, 1, mode);
    assert.equal(policy.state.validations.length, 1, mode);
    assert.equal(policy.state.admits[0].fixedProfile, mode === "prebuilt-rendition", mode);
    await scope.playback.release(result.session.id, { accountId: "account_fixture_01" });
    assert.deepEqual(policy.state.releases, [result.session.id], mode);
  }
});

const repository = ({ global, users }) => ({
  getGlobal: () => global,
  getUser: (id) => users.get(id)?.policy ?? null,
  listUsers: () => [...users.values()],
  setGlobal: () => undefined,
  setUser: () => undefined
});

test("global and per-user limits combine existing local and remote generated accounting", async () => {
  const users = new Map([
    ["account_a", { disabled: false, displayName: "A", id: "account_a", policy: { maxBitrate: null, maxConcurrentStreams: 1 }, username: "a" }],
    ["account_b", { disabled: false, displayName: "B", id: "account_b", policy: null, username: "b" }],
    ["account_c", { disabled: false, displayName: "C", id: "account_c", policy: null, username: "c" }]
  ]);
  const policy = createPlaybackPolicyService({ repository: repository({ global: { maxBitrate: null, maxConcurrentStreams: 2 }, users }) });
  const localLease = policy.admit({ decision: "remux", sessionId: "local_delivery_01", userId: "account_a" });
  let sequence = 0;
  const scheduler = {
    create: (request) => scheduled(request, candidate("remux"), `cluster_session_0${++sequence}`),
    release: () => undefined
  };
  const playback = createClusterPlaybackService({
    client,
    deliveryClient: { cancel: async () => undefined, create: async () => generatedResult("remux", { output: { bitrate: 1_000_000, protocol: "file" } }) },
    grants,
    playbackPolicy: policy,
    scheduler
  });

  await assert.rejects(playback.create(baseRequest(), { accountId: "account_a" }), { code: "user_stream_limit_reached" });
  const second = await playback.create(baseRequest(), { accountId: "account_b" });
  await assert.rejects(playback.create(baseRequest(), { accountId: "account_c" }), { code: "global_stream_limit_reached" });
  assert.equal(policy.status().activeStreams, 2);
  localLease.release();
  await playback.release(second.session.id, { accountId: "account_b" });
  assert.equal(policy.status().activeStreams, 0);
  await playback.shutdown();
  policy.shutdown();
});

test("remote generated output bitrate and fixed-profile violations fail closed", async () => {
  for (const [mode, code] of [
    ["remux", "produced_bitrate_limit_exceeded"],
    ["prebuilt-rendition", "rendition_bitrate_limit_exceeded"],
    ["live-transcode", "produced_bitrate_limit_exceeded"]
  ]) {
    const users = new Map([["account_fixture_01", { disabled: false, displayName: "A", id: "account_fixture_01", policy: null, username: "a" }]]);
    const policy = createPlaybackPolicyService({ repository: repository({ global: { maxBitrate: 2_000_000, maxConcurrentStreams: null }, users }) });
    const scope = playbackFor({
      playbackPolicy: policy,
      selected: candidate(mode),
      deliveryClient: {
        cancel: async () => undefined,
        create: async () => generatedResult(mode, { output: { bitrate: 3_000_000, protocol: mode === "remux" ? "file" : "hls", ...(mode === "prebuilt-rendition" ? { profileId: "1080p" } : {}) } })
      }
    });
    await assert.rejects(scope.playback.create(baseRequest(), { accountId: "account_fixture_01" }), { code });
    assert.equal(policy.status().activeStreams, 0, mode);
    await scope.playback.shutdown();
    policy.shutdown();
  }
});

test("pending generated delivery holds one lease and terminal status releases it", async () => {
  const policy = fakePolicy();
  let status = generatedResult("live-transcode", { status: "queued" });
  const scope = playbackFor({
    playbackPolicy: policy.service,
    deliveryClient: {
      cancel: async () => undefined,
      create: async () => status,
      get: async () => status
    }
  });
  const pending = await scope.playback.create(baseRequest(), { accountId: "account_fixture_01" });
  assert.equal(policy.state.admits.length, 1);
  assert.equal(policy.state.validations.length, 0);
  status = generatedResult("live-transcode", { status: "failed" });
  await assert.rejects(scope.playback.get(pending.session.id, { accountId: "account_fixture_01" }), { code: "shard_delivery_failed" });
  assert.deepEqual(policy.state.releases, [pending.session.id]);
  await scope.playback.shutdown();
});

test("policy leases release on expiry, failed activation, failover, and shutdown", async () => {
  let currentTime = 1_000;
  let sweep = null;
  const expiryPolicy = fakePolicy();
  const expiring = playbackFor({
    playbackPolicy: expiryPolicy.service,
    deliveryClient: { cancel: async () => undefined, create: async () => generatedResult("live-transcode", { status: "queued" }) },
    serviceOverrides: {
      clearTimer: () => undefined,
      now: () => currentTime,
      sessionTtlMs: 50,
      setTimer: (callback) => { sweep = callback; return { unref() {} }; }
    }
  });
  await expiring.playback.create(baseRequest(), { accountId: "account_fixture_01" });
  currentTime = 1_050;
  sweep();
  await new Promise(setImmediate);
  assert.equal(expiryPolicy.state.releases.length, 1);
  await expiring.playback.shutdown();

  const failurePolicy = fakePolicy();
  const failing = playbackFor({
    playbackPolicy: failurePolicy.service,
    deliveryClient: { cancel: async () => undefined, create: async () => generatedResult() }
  });
  failing.playback = createClusterPlaybackService({
    client: { activate: async () => { throw new Error("activation failed"); } },
    deliveryClient: { cancel: async () => undefined, create: async () => generatedResult() },
    grants,
    playbackPolicy: failurePolicy.service,
    scheduler: { create: (request) => scheduled(request, candidate()), release: () => undefined }
  });
  await assert.rejects(failing.playback.create(baseRequest(), { accountId: "account_fixture_01" }), /activation failed/);
  assert.equal(failurePolicy.state.releases.length, 1);
  await failing.playback.shutdown();

  const failoverPolicy = fakePolicy();
  const first = candidate("live-transcode", { nodeId: "node_first" });
  const replacement = candidate("live-transcode", { endpoint: "https://second.tail024251.ts.net", nodeId: "node_second" });
  let activeScheduled = null;
  const failover = playbackFor({
    playbackPolicy: failoverPolicy.service,
    selected: first,
    deliveryClient: { cancel: async () => undefined, create: async () => generatedResult() },
    schedulerOverrides: {
      create: (request) => (activeScheduled = scheduled(request, first)),
      failover: () => ({ ...activeScheduled, internal: { ...activeScheduled.internal, candidate: replacement }, session: { ...activeScheduled.session, candidate: { nodeId: replacement.nodeId } } })
    }
  });
  const firstResult = await failover.playback.create(baseRequest(), { accountId: "account_fixture_01" });
  await failover.playback.failover(firstResult.session.id, { accountId: "account_fixture_01" }, first.nodeId);
  assert.equal(failoverPolicy.state.releases.length, 1);
  assert.equal(failoverPolicy.state.admits.length, 2);
  await failover.playback.shutdown();
  assert.equal(failoverPolicy.state.releases.length, 2);

  const shutdownPolicy = fakePolicy();
  const active = playbackFor({
    playbackPolicy: shutdownPolicy.service,
    deliveryClient: { cancel: async () => undefined, create: async () => generatedResult() }
  });
  await active.playback.create(baseRequest(), { accountId: "account_fixture_01" });
  await active.playback.shutdown();
  await active.playback.shutdown();
  assert.equal(shutdownPolicy.state.releases.length, 1);
});

test("a policy change while remote generation is pending is enforced before first grant", async () => {
  let maxBitrate = 4_000_000;
  let activations = 0;
  let status = generatedResult("live-transcode", { status: "queued" });
  const users = new Map([["account_fixture_01", { disabled: false, displayName: "A", id: "account_fixture_01", policy: null, username: "a" }]]);
  const repo = repository({ global: { maxBitrate, maxConcurrentStreams: null }, users });
  repo.getGlobal = () => ({ maxBitrate, maxConcurrentStreams: null });
  const policy = createPlaybackPolicyService({ repository: repo });
  const scope = playbackFor({
    playbackPolicy: policy,
    deliveryClient: {
      cancel: async () => undefined,
      create: async () => status,
      get: async () => status
    }
  });
  scope.playback = createClusterPlaybackService({
    client: { activate: async () => { activations += 1; return { expiresAt: "2099-01-01T00:00:00.000Z", mediaTicket: "ticket" }; } },
    deliveryClient: { cancel: async () => undefined, create: async () => status, get: async () => status },
    grants,
    playbackPolicy: policy,
    scheduler: { create: (request) => scheduled(request, candidate()), get: (id) => ({ id }), release: () => undefined }
  });
  const pending = await scope.playback.create(baseRequest(), { accountId: "account_fixture_01" });
  maxBitrate = 2_000_000;
  status = generatedResult("live-transcode", { status: "ready" });
  await assert.rejects(scope.playback.get(pending.session.id, { accountId: "account_fixture_01" }), { code: "bitrate_limit_exceeded" });
  assert.equal(activations, 0);
  assert.equal(policy.status().activeStreams, 0);
  await scope.playback.shutdown();
  policy.shutdown();
});
