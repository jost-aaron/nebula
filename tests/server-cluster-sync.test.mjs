import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";
import { catalogMigration, createCatalogRepository } from "../server/catalog/index.mjs";
import { probeMigrations } from "../server/probe/index.mjs";
import { renditionsMigration } from "../server/renditions/index.mjs";
import {
  clusterFederationMigration, clusterMigration, createClusterManifestService, createClusterRepository,
  createClusterSyncService, createClusterTrustService, createFederatedCatalogRepository
} from "../server/cluster/index.mjs";

const capabilities = { directPlay: true, hls: true, remux: true, renditionProfiles: [], transcode: true };
const fixture = ({ endpoint, name, role }) => {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys = ON");
  applyDomainMigrations(database, [catalogMigration, ...probeMigrations, renditionsMigration, clusterMigration, clusterFederationMigration]);
  const trust = createClusterTrustService({ capabilities, endpoint, name, repository: createClusterRepository(database), role });
  return { database, trust };
};

test("coordinator sync authenticates both directions and applies a bounded manifest", async () => {
  const coordinator = fixture({ endpoint: "https://home.example-tail.ts.net/", name: "Home", role: "hybrid" });
  const shard = fixture({ endpoint: "https://basement.example-tail.ts.net/", name: "Basement", role: "shard" });
  const code = shard.trust.createPairingCode();
  const accepted = shard.trust.acceptPairing({ clusterId: coordinator.trust.identity().clusterId, pairingCode: code.pairingCode, requester: coordinator.trust.identity().descriptor });
  coordinator.trust.registerPairedNode(accepted);

  const catalog = createCatalogRepository(shard.database);
  const library = catalog.ensureLibrary({ id: "library_shard", name: "Shard" });
  const root = catalog.ensureRoot({ id: "root_shard", libraryId: library.id, path: "/private", rootKey: "shard" });
  catalog.reconcileScan({ rootId: root.id, files: [{ fileKey: "1:1", itemType: "movie", mediaKind: "video", modifiedMs: 1, path: "private.mp4", size: 100, title: "Private Fixture" }] });
  const manifest = createClusterManifestService({ database: shard.database, nodeId: shard.trust.identity().descriptor.nodeId });
  const client = { page: async ({ envelope, payload }) => {
    shard.trust.verifyRequest(envelope, payload, { method: "POST", path: "/api/shard/v1/manifest" });
    const response = await manifest.page(payload);
    return { envelope: shard.trust.signRequest({ body: response, method: "POST", path: "/api/shard/v1/manifest" }), payload: response };
  } };
  const federation = createFederatedCatalogRepository(coordinator.database);
  const sync = createClusterSyncService({ client, federation, trust: coordinator.trust });
  const result = await sync.syncNode(shard.trust.identity().descriptor.nodeId);
  assert.equal(result.complete, true);
  assert.deepEqual(federation.listItems().map(({ title }) => title), ["Private Fixture"]);
  assert.doesNotMatch(JSON.stringify(federation.listItems()), /private\.mp4|\/private/);
  coordinator.database.close(); shard.database.close();
});
