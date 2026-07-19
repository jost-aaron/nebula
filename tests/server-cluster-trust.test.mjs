import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";
import { clusterMigration, createClusterRepository, createClusterTrustService } from "../server/cluster/index.mjs";

const fixedNow = Date.parse("2026-07-19T12:00:00.000Z");
const capabilities = { directPlay: true, hls: true, remux: true, renditionProfiles: ["480p", "720p"], transcode: true };

const fixture = ({ endpoint, name, role }) => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyDomainMigrations(database, [clusterMigration]);
  const repository = createClusterRepository(database, { now: () => new Date(fixedNow).toISOString() });
  const service = createClusterTrustService({ capabilities, endpoint, name, now: () => fixedNow, repository, role });
  return { database, repository, service };
};

const pair = () => {
  const coordinator = fixture({ endpoint: "https://nebula-home.example-tail.ts.net/", name: "Home", role: "hybrid" });
  const shard = fixture({ endpoint: "https://nebula-basement.example-tail.ts.net/", name: "Basement", role: "shard" });
  const code = shard.service.createPairingCode();
  const homeIdentity = coordinator.service.identity();
  const accepted = shard.service.acceptPairing({ clusterId: homeIdentity.clusterId, pairingCode: code.pairingCode, requester: homeIdentity.descriptor });
  coordinator.service.registerPairedNode(accepted);
  return { coordinator, shard, code, accepted };
};

test("cluster migration is centrally composable and private identity is persistent", () => {
  const first = fixture({ endpoint: "https://nebula-home.example-tail.ts.net/", name: "Home", role: "hybrid" });
  applyDomainMigrations(first.database, [clusterMigration]);
  const before = first.service.identity();
  const reopened = createClusterTrustService({ capabilities, endpoint: before.descriptor.endpoint, name: "Ignored", now: () => fixedNow, repository: first.repository, role: "shard" });
  assert.deepEqual(reopened.identity(), before);
  const row = first.database.prepare("SELECT public_key, private_jwk_json FROM cluster_identity").get();
  assert.equal(row.public_key, before.descriptor.publicKey);
  const privateJwk = JSON.parse(row.private_jwk_json);
  assert.equal(typeof privateJwk.d, "string");
  assert.equal(JSON.stringify(before).includes(privateJwk.d), false);
  assert.equal(first.database.prepare("SELECT COUNT(*) AS count FROM nebula_domain_migrations WHERE migration_id = 'cluster-v1'").get().count, 1);
  first.database.close();
});

test("invalid node configuration fails before cluster identity is persisted", () => {
  const database = new DatabaseSync(":memory:");
  applyDomainMigrations(database, [clusterMigration]);
  const repository = createClusterRepository(database, { now: () => new Date(fixedNow).toISOString() });
  assert.throws(
    () => createClusterTrustService({ capabilities, endpoint: "http://public.example.com/", name: "Unsafe", now: () => fixedNow, repository, role: "hybrid" }),
    (error) => error.code === "invalid_endpoint"
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM cluster_identity").get().count, 0);
  database.close();
});

test("one-time pairing joins the coordinator cluster and stores only a code hash", () => {
  const { coordinator, shard, code } = pair();
  const home = coordinator.service.identity();
  assert.equal(shard.service.identity().clusterId, home.clusterId);
  assert.equal(shard.service.listNodes()[0].nodeId, home.descriptor.nodeId);
  assert.equal(coordinator.service.listNodes()[0].nodeId, shard.service.identity().descriptor.nodeId);
  assert.equal(shard.database.prepare("SELECT COUNT(*) AS count FROM cluster_pairing_codes WHERE code_hash = ?").get(code.pairingCode)?.count ?? 0, 0);
  assert.equal(shard.database.prepare("SELECT COUNT(*) AS count FROM cluster_pairing_codes WHERE code_hash != ?").get(code.pairingCode).count, 1);
  assert.throws(() => shard.service.acceptPairing({ clusterId: home.clusterId, pairingCode: code.pairingCode, requester: home.descriptor }), (error) => error.code === "pairing_denied");
  coordinator.database.close(); shard.database.close();
});

test("paired nodes authenticate signed bodies once within the clock window", () => {
  const { coordinator, shard } = pair();
  const body = { probe: "health" };
  const envelope = coordinator.service.signRequest({ body, method: "POST", path: "/api/shard/v1/health" });
  assert.equal(shard.service.verifyRequest(envelope, body).name, "Home");
  assert.throws(() => shard.service.verifyRequest(envelope, body), (error) => error.code === "request_replayed");

  const tampered = coordinator.service.signRequest({ body, method: "POST", path: "/api/shard/v1/health", nonce: "nonce_tampered_01" });
  assert.throws(() => shard.service.verifyRequest(tampered, { probe: "secrets" }), (error) => error.code === "body_mismatch");
  const expired = coordinator.service.signRequest({ body, method: "POST", path: "/api/shard/v1/health", nonce: "nonce_expired_001", timestamp: "2026-07-19T11:00:00.000Z" });
  assert.throws(() => shard.service.verifyRequest(expired, body), (error) => error.code === "request_expired");
  const wrongRoute = coordinator.service.signRequest({ body, method: "POST", path: "/api/shard/v1/health", nonce: "nonce_wrongroute_01" });
  assert.throws(() => shard.service.verifyRequest(wrongRoute, body, { method: "POST", path: "/api/shard/v1/manifest" }), (error) => error.code === "path_mismatch");
  coordinator.database.close(); shard.database.close();
});

test("signature substitution and node revocation fail closed", () => {
  const { coordinator, shard } = pair();
  const body = {};
  const envelope = coordinator.service.signRequest({ body, method: "GET", path: "/api/shard/v1/health" });
  const altered = { ...envelope, signature: Buffer.alloc(64, 3).toString("base64url") };
  assert.throws(() => shard.service.verifyRequest(altered, body), (error) => error.code === "bad_signature");
  shard.service.revokeNode(coordinator.service.identity().descriptor.nodeId);
  assert.throws(() => shard.service.verifyRequest(envelope, body), (error) => error.code === "untrusted_node");
  assert.equal(shard.service.listNodes().length, 0);
  assert.equal(shard.repository.listNodes({ includeRevoked: true })[0].state, "revoked");
  coordinator.database.close(); shard.database.close();
});
