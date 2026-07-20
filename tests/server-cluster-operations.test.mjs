import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";
import {
  clusterMigration, clusterOperationsMigration, createClusterRepository, createClusterTrustService
} from "../server/cluster/index.mjs";

const capabilities = { directPlay: true, hls: true, remux: true, renditionProfiles: [], transcode: true };
const createFixture = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyDomainMigrations(database, [clusterMigration, clusterOperationsMigration]);
  const repository = createClusterRepository(database, { now: () => "2026-07-19T12:00:00.000Z" });
  const service = createClusterTrustService({
    capabilities, endpoint: "https://home.example-tail.ts.net/", name: "Home", repository, role: "hybrid"
  });
  service.registerPairedNode({ clusterId: service.identity().clusterId, node: {
    capabilities, endpoint: "https://basement.example-tail.ts.net/", name: "Basement",
    nodeId: "node_basement_001", protocolVersion: 1, publicKey: service.identity().descriptor.publicKey, role: "shard"
  } });
  return { database, repository, service };
};

test("cluster operations migration persists bounded controls without mutating signed identity", () => {
  const fixture = createFixture();
  const before = fixture.repository.getNode("node_basement_001");
  const updated = fixture.service.updateNodeControls("node_basement_001", {
    maintenanceDrain: true, maxConcurrentStreams: 4, maxConcurrentTranscodes: 1, name: "Rack Two", priority: 25
  });
  assert.equal(updated.name, "Rack Two");
  assert.equal(updated.advertisedName, "Basement");
  assert.deepEqual(updated.controls, {
    maintenanceDrain: true, maxConcurrentStreams: 4, maxConcurrentTranscodes: 1,
    priority: 25, updatedAt: "2026-07-19T12:00:00.000Z"
  });
  assert.equal(updated.nodeId, before.nodeId);
  assert.equal(updated.endpoint, before.endpoint);
  assert.equal(updated.publicKey, before.publicKey);
  fixture.repository.upsertNode({
    capabilities: before.capabilities, endpoint: before.endpoint, name: "Basement", nodeId: before.nodeId,
    protocolVersion: 1, publicKey: before.publicKey, role: before.role
  }, fixture.service.identity().clusterId);
  const refreshed = fixture.repository.getNode("node_basement_001");
  assert.equal(refreshed.name, "Rack Two");
  assert.equal(refreshed.endpoint, before.endpoint);
  assert.equal(refreshed.publicKey, before.publicKey);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM nebula_domain_migrations WHERE migration_id = 'cluster-operations-v1'").get().count, 1);
  fixture.database.close();
});

test("node controls reject unknown fields, unsafe names, invalid limits, and revoked nodes", () => {
  const fixture = createFixture();
  for (const input of [
    { surprise: true }, { name: "<script>" }, { priority: 101 },
    { maxConcurrentStreams: 0 }, { maxConcurrentTranscodes: 33 }, { maintenanceDrain: "yes" }
  ]) assert.throws(() => fixture.service.updateNodeControls("node_basement_001", input));
  fixture.service.revokeNode("node_basement_001");
  assert.throws(() => fixture.service.updateNodeControls("node_basement_001", { priority: 1 }), { code: "node_not_found" });
  fixture.database.close();
});
