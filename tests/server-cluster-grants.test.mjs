import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";
import { createClusterGrantService, createClusterRepository, createClusterTrustService, clusterMigration } from "../server/cluster/index.mjs";

const capabilities = { directPlay: true, hls: true, remux: true, renditionProfiles: [], transcode: true };
const fixture = ({ endpoint, name, role }) => {
  const database = new DatabaseSync(":memory:");
  applyDomainMigrations(database, [clusterMigration]);
  const trust = createClusterTrustService({ capabilities, endpoint, name, repository: createClusterRepository(database), role });
  return { database, trust };
};
const source = { availability: "available", contentRevision: 3, id: "source_fixture_01", path: "Movies/fixture.mp4" };
const candidate = { localSourceId: source.id, nodeId: null, sourceRevision: source.contentRevision };

test("coordinator-signed grants are source and revision bound on the target shard", () => {
  const coordinator = fixture({ endpoint: "https://home.tail024251.ts.net/", name: "Home", role: "coordinator" });
  const shard = fixture({ endpoint: "https://basement.tail024251.ts.net/", name: "Basement", role: "shard" });
  const code = shard.trust.createPairingCode();
  const acceptedPair = shard.trust.acceptPairing({ clusterId: coordinator.trust.identity().clusterId, pairingCode: code.pairingCode, requester: coordinator.trust.identity().descriptor });
  coordinator.trust.registerPairedNode(acceptedPair);
  const catalog = { getSource: (id) => id === source.id ? source : null };
  const coordinatorGrants = createClusterGrantService({ catalog, isClientOriginAllowed: (origin) => origin === "http://127.0.0.1:5173", trust: coordinator.trust, now: () => 1_000, uuid: () => "00000000-0000-4000-8000-000000000001", random: (bytes) => Buffer.alloc(bytes, 7) });
  const shardGrants = createClusterGrantService({ catalog, trust: shard.trust, now: () => 1_000, random: (bytes) => Buffer.alloc(bytes, 9) });
  const signed = coordinatorGrants.issue({ accountId: "account_fixture_01", candidate: { ...candidate, nodeId: shard.trust.identity().descriptor.nodeId }, clientOrigin: "http://127.0.0.1:5173", deviceId: "device_fixture_01", federatedItemId: "fitem_fixture_01", sessionId: "session_fixture_01" });
  const accepted = shardGrants.accept(signed);
  const resolved = shardGrants.resolve({ grantId: accepted.grantId, method: "GET", ticket: accepted.mediaTicket });
  assert.equal(resolved.source.id, source.id);
  assert.equal(resolved.grant.sourceRevision, 3);
  assert.equal(resolved.clientOrigin, "http://127.0.0.1:5173");
  assert.doesNotMatch(JSON.stringify(accepted), /Movies|fixture\.mp4|account_fixture/);
  assert.throws(() => shardGrants.resolve({ grantId: accepted.grantId, method: "DELETE", ticket: accepted.mediaTicket }), { code: "delegated_media_not_found" });
  assert.throws(() => shardGrants.resolve({ grantId: accepted.grantId, method: "GET", ticket: "wrong_ticket" }), { code: "delegated_media_not_found" });
  const strictIssuer = createClusterGrantService({ catalog, trust: coordinator.trust, now: () => 1_000 });
  assert.throws(() => strictIssuer.issue({ accountId: "account_fixture_01", candidate: { ...candidate, nodeId: shard.trust.identity().descriptor.nodeId }, clientOrigin: "https://attacker.example", deviceId: "device_fixture_01", federatedItemId: "fitem_fixture_01", sessionId: "session_fixture_02" }), { code: "client_origin_denied" });
  coordinator.database.close(); shard.database.close();
});

test("grant acceptance rejects replay, target substitution, and stale source revisions", () => {
  const coordinator = fixture({ endpoint: "https://home.tail024251.ts.net/", name: "Home", role: "coordinator" });
  const shard = fixture({ endpoint: "https://basement.tail024251.ts.net/", name: "Basement", role: "shard" });
  const code = shard.trust.createPairingCode();
  const acceptedPair = shard.trust.acceptPairing({ clusterId: coordinator.trust.identity().clusterId, pairingCode: code.pairingCode, requester: coordinator.trust.identity().descriptor });
  coordinator.trust.registerPairedNode(acceptedPair);
  const catalog = { getSource: () => source };
  const issuer = createClusterGrantService({ catalog, trust: coordinator.trust, now: () => 1_000, uuid: () => "00000000-0000-4000-8000-000000000001", random: (bytes) => Buffer.alloc(bytes, 5) });
  const validator = createClusterGrantService({ catalog, trust: shard.trust, now: () => 1_000 });
  const signed = issuer.issue({ accountId: "account_fixture_01", candidate: { ...candidate, nodeId: shard.trust.identity().descriptor.nodeId }, deviceId: "device_fixture_01", federatedItemId: "fitem_fixture_01", sessionId: "session_fixture_01" });
  validator.accept(signed);
  assert.throws(() => validator.accept(signed), { code: "request_replayed" });
  const wrongTarget = issuer.issue({ accountId: "account_fixture_01", candidate: { ...candidate, nodeId: coordinator.trust.identity().descriptor.nodeId }, deviceId: "device_fixture_01", federatedItemId: "fitem_fixture_01", sessionId: "session_fixture_02" });
  assert.throws(() => validator.accept(wrongTarget), { code: "grant_scope_mismatch" });
  const staleIssuer = createClusterGrantService({ catalog, trust: coordinator.trust, now: () => 1_000, uuid: () => "00000000-0000-4000-8000-000000000002", random: (bytes) => Buffer.alloc(bytes, 6) });
  const stale = staleIssuer.issue({ accountId: "account_fixture_01", candidate: { ...candidate, nodeId: shard.trust.identity().descriptor.nodeId, sourceRevision: 2 }, deviceId: "device_fixture_01", federatedItemId: "fitem_fixture_01", sessionId: "session_fixture_03" });
  assert.throws(() => validator.accept(stale), { code: "grant_source_unavailable" });
  coordinator.database.close(); shard.database.close();
});
