import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyDomainMigrations } from "../server/database.mjs";
import {
  clusterMigration,
  classifyClusterProtocolVersion,
  createClusterRepository,
  createClusterSyncService,
  createClusterTrustService,
  validateClusterDelegatedMediaGrant,
  validateClusterManifestPage,
  validateClusterSignedEnvelope
} from "../server/cluster/index.mjs";

const nodeId = "node_rolling_shard_01";
const manifestSource = () => ({
  availability: "available", bitrate: null, durationSeconds: 90, externalIds: [],
  fingerprint: { algorithm: "sha256", digest: "a".repeat(64), sourceRevision: 1, state: "ready" },
  height: 720, itemKind: "movie", localItemId: "item_rolling_fixture_01",
  localSourceId: "source_rolling_fixture_01", mediaKind: "video", removedAt: null,
  renditions: [], sizeBytes: 1024, sourceRevision: 1, title: "Rolling Fixture", width: 1280, year: 2026
});
const manifestPage = (overrides = {}) => ({
  complete: true, cursor: null, manifestRevision: 1, nodeId, protocolVersion: 1,
  sources: [manifestSource()], ...overrides
});
const envelope = (overrides = {}) => ({
  bodyDigest: "b".repeat(64), method: "POST", nodeId, nonce: "nonce_rolling_fixture_01",
  path: "/api/shard/v1/manifest", protocolVersion: 1,
  signature: Buffer.alloc(64, 9).toString("base64url"), timestamp: "2026-07-19T12:00:00.000Z",
  ...overrides
});
const grant = (overrides = {}) => ({
  accountId: "account_rolling_01", assetPrefix: "/api/shard/v1/media/grant_rolling_01/",
  clientOrigin: "https://home.tail024251.ts.net", clusterId: "cluster_rolling_01",
  deliveryId: null, deliveryProtocol: "file", deviceId: "device_rolling_01",
  expiresAt: "2026-07-19T12:10:00.000Z", federatedItemId: "fitem_rolling_01",
  grantId: "grant_rolling_01", issuedAt: "2026-07-19T12:00:00.000Z",
  localSourceId: "source_rolling_01", methods: ["GET", "HEAD"], nodeId,
  nonce: "nonce_rolling_grant_01", profileId: "original", protocolVersion: 1,
  sessionId: "session_rolling_01", sourceRevision: 1, ...overrides
});

test("rolling compatibility gates classify versions and fail closed across wire-contract changes", () => {
  assert.equal(classifyClusterProtocolVersion(1), "current");
  assert.equal(classifyClusterProtocolVersion(0), "invalid");
  assert.equal(classifyClusterProtocolVersion(2), "too-new");

  assert.equal(validateClusterManifestPage(manifestPage()).protocolVersion, 1);
  assert.throws(() => validateClusterManifestPage(manifestPage({ protocolVersion: 2 })), { code: "unsupported_protocol" });
  const oldSource = manifestSource(); delete oldSource.renditions;
  assert.throws(() => validateClusterManifestPage(manifestPage({ sources: [oldSource] })), { code: "manifest_limit" });
  assert.throws(() => validateClusterManifestPage({ ...manifestPage(), optionalFutureField: true }), { code: "unknown_field" });

  assert.equal(validateClusterSignedEnvelope(envelope()).protocolVersion, 1);
  assert.throws(() => validateClusterSignedEnvelope(envelope({ protocolVersion: 2 })), { code: "unsupported_protocol" });
  assert.throws(() => validateClusterSignedEnvelope(envelope({ compatibilityToken: "unsafe" })), { code: "unknown_field" });

  assert.equal(validateClusterDelegatedMediaGrant(grant()).deliveryProtocol, "file");
  const oldGrant = grant(); delete oldGrant.deliveryProtocol;
  assert.throws(() => validateClusterDelegatedMediaGrant(oldGrant), { code: "invalid_delivery" });
  assert.throws(() => validateClusterDelegatedMediaGrant(grant({ proxyTarget: "http://127.0.0.1" })), { code: "unknown_field" });
});

test("coordinator retries one stale manifest cursor with a fresh reconciliation generation", async () => {
  const calls = [];
  const applied = [];
  const client = {
    async page({ payload }) {
      calls.push(payload.cursor);
      if (calls.length === 1) return { envelope: envelope(), payload: manifestPage({ complete: false, cursor: "cursor_rolling_page_01" }) };
      if (calls.length === 2) throw Object.assign(new Error("Catalog changed"), { code: "cursor_lost", status: 409 });
      return { envelope: envelope({ nonce: "nonce_rolling_fixture_02" }), payload: manifestPage({ manifestRevision: 2 }) };
    }
  };
  const federation = {
    applyManifestPage({ page, syncGeneration }) {
      applied.push({ cursor: page.cursor, syncGeneration });
      return { complete: page.complete, cursor: page.cursor, manifestRevision: page.manifestRevision, syncGeneration };
    }
  };
  const trust = {
    listNodes: () => [{ endpoint: "https://shard.tail024251.ts.net", nodeId, state: "online" }],
    signRequest: () => envelope(),
    verifyRequest: () => ({ nodeId })
  };
  const result = await createClusterSyncService({ client, federation, maxCursorRestarts: 1, trust }).syncNode(nodeId);
  assert.deepEqual(calls, [null, "cursor_rolling_page_01", null]);
  assert.equal(result.manifestRevision, 2);
  assert.notEqual(applied[0].syncGeneration, applied[1].syncGeneration);
});

test("repeated cursor loss remains bounded during a rolling shard restart", async () => {
  let calls = 0;
  const sync = createClusterSyncService({
    client: { page: async () => { calls += 1; throw Object.assign(new Error("Restarting"), { code: "cursor_lost", status: 409 }); } },
    federation: { applyManifestPage: () => { throw new Error("not reached"); } },
    maxCursorRestarts: 1,
    trust: {
      listNodes: () => [{ endpoint: "https://shard.tail024251.ts.net", nodeId, state: "online" }],
      signRequest: () => envelope(), verifyRequest: () => ({ nodeId })
    }
  });
  await assert.rejects(sync.syncNode(nodeId), { code: "cursor_lost" });
  assert.equal(calls, 2);
});

test("coordinator and shard identities survive rolling database restarts while revocation remains authoritative", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-cluster-restart-"));
  let coordinator;
  let shard;
  t.after(async () => {
    try { coordinator?.database.close(); } catch {}
    try { shard?.database.close(); } catch {}
    await rm(root, { force: true, recursive: true });
  });
  const capabilities = { directPlay: true, hls: true, remux: true, renditionProfiles: [], transcode: true };
  const open = (name, endpoint, role) => {
    const database = new DatabaseSync(path.join(root, `${name}.sqlite`));
    database.exec("PRAGMA foreign_keys = ON");
    applyDomainMigrations(database, [clusterMigration]);
    const repository = createClusterRepository(database);
    const trust = createClusterTrustService({ capabilities, endpoint, name, repository, role });
    return { database, repository, trust };
  };

  coordinator = open("Home", "https://home.tail024251.ts.net/", "coordinator");
  shard = open("Shard", "https://shard.tail024251.ts.net/", "shard");
  const pairing = shard.trust.acceptPairing({
    clusterId: coordinator.trust.identity().clusterId,
    pairingCode: shard.trust.createPairingCode().pairingCode,
    requester: coordinator.trust.identity().descriptor
  });
  coordinator.trust.registerPairedNode(pairing);
  const coordinatorIdentity = coordinator.trust.identity();
  const shardIdentity = shard.trust.identity();
  coordinator.database.close(); shard.database.close();

  coordinator = open("Home", "https://home.tail024251.ts.net/", "coordinator");
  shard = open("Shard", "https://shard.tail024251.ts.net/", "shard");
  assert.deepEqual(coordinator.trust.identity(), coordinatorIdentity);
  assert.deepEqual(shard.trust.identity(), shardIdentity);
  const health = { probe: "rolling-restart" };
  shard.trust.verifyRequest(coordinator.trust.signRequest({ body: health, method: "POST", path: "/api/shard/v1/health" }), health);

  coordinator.database.prepare("UPDATE cluster_nodes SET state = 'draining' WHERE node_id = ?").run(shardIdentity.descriptor.nodeId);
  coordinator.database.close();
  coordinator = open("Home", "https://home.tail024251.ts.net/", "coordinator");
  assert.equal(coordinator.repository.getNode(shardIdentity.descriptor.nodeId).state, "draining");
  coordinator.trust.revokeNode(shardIdentity.descriptor.nodeId);
  coordinator.database.close();
  coordinator = open("Home", "https://home.tail024251.ts.net/", "coordinator");
  assert.equal(coordinator.repository.getNode(shardIdentity.descriptor.nodeId).state, "revoked");
  assert.equal(coordinator.trust.listNodes().some(({ nodeId: candidate }) => candidate === shardIdentity.descriptor.nodeId), false);
  const shardRequest = shard.trust.signRequest({ body: health, method: "POST", path: "/api/shard/v1/health" });
  assert.throws(() => coordinator.trust.verifyRequest(shardRequest, health), { code: "untrusted_node" });
  coordinator.database.close(); shard.database.close();
});

test("generated rolling fixtures are removed after success and failure", async () => {
  const roots = [];
  const withFixture = async (action) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nebula-cluster-rolling-"));
    roots.push(root);
    try {
      await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifestPage()));
      return await action(root);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  };
  await withFixture(async (root) => access(path.join(root, "manifest.json")));
  await assert.rejects(withFixture(async () => { throw new Error("fixture failure"); }), /fixture failure/);
  for (const root of roots) await assert.rejects(access(root), { code: "ENOENT" });
});
