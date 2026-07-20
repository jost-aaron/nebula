import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";
import {
  clusterMigration,
  createClusterGrantClient,
  createClusterGrantService,
  createClusterIngressRoutes,
  createClusterPlaybackScheduler,
  createClusterPlaybackService,
  createClusterRepository,
  createClusterTrustService
} from "../server/cluster/index.mjs";

const NODE_CAPABILITIES = {
  directPlay: true,
  hls: true,
  remux: true,
  renditionProfiles: [],
  transcode: true
};

const listen = async (route) => {
  const server = createServer((request, response) => {
    void route(request, response, new URL(request.url, "http://localhost"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    origin: `http://127.0.0.1:${server.address().port}`
  };
};

const trustFixture = ({ endpoint, name, role }) => {
  const database = new DatabaseSync(":memory:");
  applyDomainMigrations(database, [clusterMigration]);
  const trust = createClusterTrustService({
    capabilities: NODE_CAPABILITIES,
    endpoint,
    name,
    repository: createClusterRepository(database),
    role
  });
  return { database, trust };
};

const pair = (coordinator, shard) => {
  const code = shard.createPairingCode();
  const accepted = shard.acceptPairing({
    clusterId: coordinator.identity().clusterId,
    pairingCode: code.pairingCode,
    requester: coordinator.identity().descriptor
  });
  coordinator.registerPairedNode(accepted);
};

test("coordinator scheduling delegates exact-replica playback to isolated shard media routes", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "nebula-cluster-playback-e2e-"));
  const coordinator = trustFixture({ endpoint: "https://home.tail024251.ts.net/", name: "Home", role: "coordinator" });
  const shardDefinitions = [
    { endpoint: "https://alpha.tail024251.ts.net/", name: "Alpha", slug: "alpha" },
    { endpoint: "https://bravo.tail024251.ts.net/", name: "Bravo", slug: "bravo" }
  ];
  const mediaBytes = Buffer.from("nebula-exact-replica-0123456789-abcdefghijklmnopqrstuvwxyz");
  const shardFixtures = [];

  t.after(async () => {
    await Promise.all(shardFixtures.map((fixture) => fixture.server.close()));
    for (const fixture of shardFixtures) fixture.database.close();
    coordinator.database.close();
    await rm(temporaryRoot, { force: true, recursive: true });
  });

  for (const definition of shardDefinitions) {
    const root = path.join(temporaryRoot, definition.slug);
    const relativePath = path.join("Movies", "replica.mp4");
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), mediaBytes);

    const fixture = trustFixture({ endpoint: definition.endpoint, name: definition.name, role: "shard" });
    pair(coordinator.trust, fixture.trust);
    const source = {
      availability: "available",
      contentRevision: 7,
      id: `catalog_${definition.slug}_private`,
      path: relativePath
    };
    const catalog = { getSource: (sourceId) => sourceId === source.id ? source : null };
    const grants = createClusterGrantService({ catalog, trust: fixture.trust });
    const route = createClusterIngressRoutes({ contentRoot: root, grants, service: fixture.trust });
    const server = await listen(route);
    shardFixtures.push({ ...definition, ...fixture, catalog, grants, root, server, source });
  }

  const exactReplicaKey = `sha256:${"a".repeat(64)}:${mediaBytes.length}`;
  const sources = shardFixtures.map((fixture) => ({
    availability: "available",
    capabilities: NODE_CAPABILITIES,
    endpoint: fixture.endpoint,
    exactReplicaKey,
    federatedSourceId: `fsource_${fixture.slug}_fixture`,
    local: false,
    localItemId: `item_${fixture.slug}_fixture`,
    localSourceId: fixture.source.id,
    nodeId: fixture.trust.identity().descriptor.nodeId,
    nodeName: fixture.name,
    nodeState: "online",
    renditions: [],
    sourceRevision: fixture.source.contentRevision
  }));
  const scheduler = createClusterPlaybackScheduler({
    federation: { listPlaybackSources: (itemId) => itemId === "fitem_movie_fixture" ? sources : [] }
  });
  const coordinatorGrants = createClusterGrantService({ catalog: { getSource: () => null }, trust: coordinator.trust });
  const endpointMap = new Map(shardFixtures.map((fixture) => [new URL(fixture.endpoint).origin, fixture.server.origin]));
  const activationRequests = [];
  const client = createClusterGrantClient({
    allowDirect: true,
    fetcher: async (url, options) => {
      const requested = new URL(url);
      const localOrigin = endpointMap.get(requested.origin);
      assert.ok(localOrigin, `Unexpected shard endpoint: ${requested.origin}`);
      activationRequests.push({ body: JSON.parse(options.body), endpoint: requested.origin });
      return fetch(`${localOrigin}${requested.pathname}`, options);
    }
  });
  const playback = createClusterPlaybackService({ client, grants: coordinatorGrants, scheduler });
  const request = {
    capabilities: { deviceId: "device_browser_fixture", supportsHls: true },
    federatedItemId: "fitem_movie_fixture",
    preferredProfileId: "original",
    startPositionSeconds: 19
  };

  const [first, second] = await Promise.all([
    playback.create(request, { accountId: "account_alice_fixture" }),
    playback.create(request, { accountId: "account_alice_fixture" })
  ]);
  assert.notEqual(first.session.candidate.nodeId, second.session.candidate.nodeId);
  assert.deepEqual(Object.values(scheduler.snapshot().activeByNode).sort(), [1, 1]);

  const privateMaterial = [
    "Movies/replica.mp4",
    "catalog_alpha_private",
    "catalog_bravo_private",
    "account_alice_fixture",
    coordinator.trust.identity().privateJwk,
    "BEGIN PRIVATE KEY",
    "envelope",
    "signature"
  ].filter(Boolean);
  const publicPayload = JSON.stringify({ first, second });
  for (const value of privateMaterial) assert.doesNotMatch(publicPayload, new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const result of [first, second]) {
    const delivery = new URL(result.session.deliveryUrl);
    assert.equal(delivery.pathname.startsWith("/api/shard/v1/media/grant_"), true);
    assert.match(delivery.searchParams.get("ticket"), /^[A-Za-z0-9_-]{32,256}$/);
    assert.equal(Object.keys(result.session).includes("accountId"), false);
  }

  const readRange = async (deliveryUrl, start, end) => {
    const remote = new URL(deliveryUrl);
    const localOrigin = endpointMap.get(remote.origin);
    assert.ok(localOrigin);
    return fetch(`${localOrigin}${remote.pathname}${remote.search}`, {
      headers: { origin: new URL(coordinator.trust.identity().descriptor.endpoint).origin, range: `bytes=${start}-${end}` }
    });
  };
  const initialRange = await readRange(first.session.deliveryUrl, 19, 27);
  assert.equal(initialRange.status, 206);
  assert.deepEqual(Buffer.from(await initialRange.arrayBuffer()), mediaBytes.subarray(19, 28));
  assert.equal(initialRange.headers.get("content-range"), `bytes 19-27/${mediaBytes.length}`);
  assert.equal(initialRange.headers.get("cache-control"), "private, no-store");

  await assert.rejects(
    playback.get(first.session.id, { accountId: "account_bob_fixture" }),
    { code: "cluster_playback_session_not_found" }
  );
  await assert.rejects(
    playback.release(first.session.id, { accountId: "account_bob_fixture" }),
    { code: "cluster_playback_session_not_found" }
  );

  const failedNodeId = first.session.candidate.nodeId;
  const failedOver = await playback.failover(first.session.id, { accountId: "account_alice_fixture" }, failedNodeId);
  assert.equal(failedOver.session.id, first.session.id);
  assert.notEqual(failedOver.session.candidate.nodeId, failedNodeId);
  assert.equal(failedOver.session.candidate.mode, "original");
  const resumedRange = await readRange(failedOver.session.deliveryUrl, 19, 27);
  assert.equal(resumedRange.status, 206);
  assert.deepEqual(Buffer.from(await resumedRange.arrayBuffer()), mediaBytes.subarray(19, 28));

  const firstActivation = activationRequests[0];
  const replayTarget = endpointMap.get(firstActivation.endpoint);
  const replay = await fetch(`${replayTarget}/api/shard/v1/playback/grants/validate`, {
    body: JSON.stringify(firstActivation.body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).code, "request_replayed");

  const activeShard = shardFixtures.find((fixture) => fixture.trust.identity().descriptor.nodeId === failedOver.session.candidate.nodeId);
  activeShard.source.contentRevision += 1;
  const substitutedRevision = await readRange(failedOver.session.deliveryUrl, 19, 27);
  assert.equal(substitutedRevision.status, 404);
  assert.equal((await substitutedRevision.json()).code, "grant_source_unavailable");

  const staleCandidate = sources.find((source) => source.nodeId === activeShard.trust.identity().descriptor.nodeId);
  const staleGrant = coordinatorGrants.issue({
    accountId: "account_alice_fixture",
    candidate: staleCandidate,
    deviceId: request.capabilities.deviceId,
    federatedItemId: request.federatedItemId,
    profileId: request.preferredProfileId,
    sessionId: first.session.id
  });
  const staleAcceptance = await fetch(`${activeShard.server.origin}/api/shard/v1/playback/grants/validate`, {
    body: JSON.stringify(staleGrant),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  assert.equal(staleAcceptance.status, 404);
  assert.equal((await staleAcceptance.json()).code, "grant_source_unavailable");
});
