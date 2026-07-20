import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { capabilitiesForRole, capabilityForRoute } from "../server/auth.mjs";
import {
  CLUSTER_KEY_ROTATION_COMMIT_PATH, CLUSTER_KEY_ROTATION_PREPARE_PATH,
  clusterKeyRotationMigration, clusterMigration, createClusterKeyRotationService,
  createClusterRepository, createClusterTrustService
} from "../server/cluster/index.mjs";
import { applyDomainMigrations } from "../server/database.mjs";

const capabilities = { directPlay: true, hls: true, remux: true, renditionProfiles: [], transcode: true };
const start = Date.parse("2026-07-19T12:00:00.000Z");

const fixture = ({ database = new DatabaseSync(":memory:"), endpoint, name, role, time }) => {
  database.exec("PRAGMA foreign_keys = ON");
  applyDomainMigrations(database, [clusterMigration, clusterKeyRotationMigration]);
  const repository = createClusterRepository(database, { now: () => new Date(time.value).toISOString() });
  const trust = createClusterTrustService({ capabilities, endpoint, name, now: () => time.value, repository, role });
  return { database, repository, trust };
};

const pair = () => {
  const time = { value: start };
  const coordinator = fixture({ endpoint: "https://home.tail024251.ts.net/", name: "Home", role: "coordinator", time });
  const shard = fixture({ endpoint: "https://shard.tail024251.ts.net/", name: "Shard", role: "shard", time });
  const pairingCode = shard.trust.createPairingCode().pairingCode;
  const accepted = shard.trust.acceptPairing({
    clusterId: coordinator.trust.identity().clusterId,
    pairingCode,
    requester: coordinator.trust.identity().descriptor
  });
  coordinator.trust.registerPairedNode(accepted);
  return { coordinator, shard, time };
};

const directClient = ({ failCommit = () => false, shard }) => ({
  async prepare({ envelope, payload }) {
    const accepted = shard.trust.acceptKeyRotationPrepare(envelope, payload, { method: "POST", path: CLUSTER_KEY_ROTATION_PREPARE_PATH });
    const ack = { keyVersion: accepted.newKeyVersion, nodeId: shard.trust.identity().descriptor.nodeId, rotationId: accepted.rotationId, state: "prepared" };
    return { envelope: shard.trust.signRequest({ body: ack, method: "POST", path: CLUSTER_KEY_ROTATION_PREPARE_PATH }), origin: new URL(shard.trust.identity().descriptor.endpoint).origin, payload: ack };
  },
  async commit({ envelope, payload }) {
    if (failCommit()) throw Object.assign(new Error("Generated transport interruption."), { code: "shard_unreachable", status: 502 });
    const accepted = shard.trust.acceptKeyRotationCommit(envelope, payload, { method: "POST", path: CLUSTER_KEY_ROTATION_COMMIT_PATH });
    const ack = { keyVersion: accepted.newKeyVersion, nodeId: shard.trust.identity().descriptor.nodeId, rotationId: accepted.rotationId, state: "committed" };
    return { envelope: shard.trust.signRequest({ body: ack, method: "POST", path: CLUSTER_KEY_ROTATION_COMMIT_PATH }), origin: new URL(shard.trust.identity().descriptor.endpoint).origin, payload: ack };
  }
});

test("owner rotation prepares every peer, commits the successor, and rejects the retired key", async (t) => {
  const { coordinator, shard, time } = pair();
  t.after(() => { coordinator.database.close(); shard.database.close(); });
  const oldEnvelope = coordinator.trust.signRequest({ body: { probe: true }, method: "POST", path: "/api/shard/v1/health", nonce: "nonce_old_after_rotation_01" });
  const rotation = createClusterKeyRotationService({ client: directClient({ shard }), now: () => time.value, repository: coordinator.repository, trust: coordinator.trust });
  const result = await rotation.advance();

  assert.equal(result.state, "completed");
  assert.equal(result.oldKeyVersion, 1);
  assert.equal(result.newKeyVersion, 2);
  assert.deepEqual(result.peers.map(({ state }) => state), ["committed"]);
  assert.equal(coordinator.trust.identity().keyVersion, 2);
  assert.equal(coordinator.repository.getNode(coordinator.trust.identity().descriptor.nodeId).keyVersion, 2);
  assert.equal(shard.repository.getNode(coordinator.trust.identity().descriptor.nodeId).keyVersion, 2);
  assert.equal(JSON.stringify(result).includes("publicKey"), false);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.throws(() => shard.trust.verifyRequest(oldEnvelope, { probe: true }, { method: "POST", path: "/api/shard/v1/health" }), { code: "bad_signature" });

  const current = coordinator.trust.signRequest({ body: { probe: true }, method: "POST", path: "/api/shard/v1/health", nonce: "nonce_new_after_rotation_01" });
  assert.equal(shard.trust.verifyRequest(current, { probe: true }).nodeId, coordinator.trust.identity().descriptor.nodeId);
  const stored = coordinator.repository.getIdentityRotation(result.rotationId);
  assert.equal(stored.oldPrivateJwk, null);
  assert.equal(stored.newPrivateJwk, null);
});

test("prepared rotation accepts the successor only inside the bounded transition and rejects replay", (t) => {
  const { coordinator, shard } = pair();
  t.after(() => { coordinator.database.close(); shard.database.close(); });
  const rotation = coordinator.trust.beginKeyRotation();
  const payload = coordinator.trust.rotationPayload(rotation);
  const envelope = coordinator.trust.signRequest({ body: payload, method: "POST", path: CLUSTER_KEY_ROTATION_PREPARE_PATH, nonce: "nonce_rotation_prepare_01" });
  shard.trust.acceptKeyRotationPrepare(envelope, payload, { method: "POST", path: CLUSTER_KEY_ROTATION_PREPARE_PATH });
  assert.throws(() => shard.trust.acceptKeyRotationPrepare(envelope, payload, { method: "POST", path: CLUSTER_KEY_ROTATION_PREPARE_PATH }), { code: "request_replayed" });

  const substituted = { ...payload, newPublicKey: shard.trust.identity().descriptor.publicKey };
  const substitutionEnvelope = coordinator.trust.signRequest({ body: substituted, method: "POST", path: CLUSTER_KEY_ROTATION_PREPARE_PATH, nonce: "nonce_rotation_substitute_01" });
  assert.throws(() => shard.trust.acceptKeyRotationPrepare(substitutionEnvelope, substituted, { method: "POST", path: CLUSTER_KEY_ROTATION_PREPARE_PATH }), { code: "rotation_replayed" });
});

test("an interrupted active rotation resumes after restart without reverting to the old key", async (t) => {
  const { coordinator, shard, time } = pair();
  t.after(() => { coordinator.database.close(); shard.database.close(); });
  let interrupt = true;
  const first = createClusterKeyRotationService({
    client: directClient({ failCommit: () => { const value = interrupt; interrupt = false; return value; }, shard }),
    now: () => time.value,
    repository: coordinator.repository,
    trust: coordinator.trust
  });
  await assert.rejects(first.advance(), { code: "shard_unreachable" });
  const open = coordinator.repository.getOpenIdentityRotation();
  assert.equal(open.state, "active");
  assert.equal(coordinator.repository.getIdentity().keyVersion, 2);
  assert.equal(shard.repository.getPreparedNodeKeyRotation(coordinator.trust.identity().descriptor.nodeId).state, "prepared");

  const restarted = fixture({ database: coordinator.database, endpoint: "https://home.tail024251.ts.net/", name: "Home", role: "coordinator", time });
  const resumed = createClusterKeyRotationService({ client: directClient({ shard }), now: () => time.value, repository: restarted.repository, trust: restarted.trust });
  const result = await resumed.advance();
  assert.equal(result.state, "completed");
  assert.equal(restarted.trust.identity().keyVersion, 2);
  assert.equal(shard.repository.getNode(restarted.trust.identity().descriptor.nodeId).keyVersion, 2);
});

test("expired interrupted rotations fail closed and cannot reactivate old trust", async (t) => {
  const { coordinator, shard, time } = pair();
  t.after(() => { coordinator.database.close(); shard.database.close(); });
  const rotation = coordinator.trust.beginKeyRotation();
  const payload = coordinator.trust.rotationPayload(rotation);
  const prepare = coordinator.trust.signRequest({ body: payload, method: "POST", path: CLUSTER_KEY_ROTATION_PREPARE_PATH });
  shard.trust.acceptKeyRotationPrepare(prepare, payload, { method: "POST", path: CLUSTER_KEY_ROTATION_PREPARE_PATH });
  time.value = Date.parse(rotation.expiresAt) + 1;
  const commit = coordinator.trust.signRequest({ body: payload, method: "POST", path: CLUSTER_KEY_ROTATION_COMMIT_PATH });
  assert.throws(() => shard.trust.acceptKeyRotationCommit(commit, payload, { method: "POST", path: CLUSTER_KEY_ROTATION_COMMIT_PATH }), { code: "rotation_expired" });
});

test("key rotation administration requires the exact server.admin boundary", () => {
  for (const method of ["GET", "POST"]) {
    assert.equal(capabilityForRoute({ method }, new URL("http://nebula/api/admin/cluster/key-rotation")), "server.admin");
  }
  assert.equal(capabilitiesForRole("owner").has("server.admin"), true);
  assert.equal(capabilitiesForRole("member").has("server.admin"), false);
});
