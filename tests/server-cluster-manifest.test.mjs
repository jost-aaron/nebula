import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";
import { catalogMigration, createCatalogRepository } from "../server/catalog/index.mjs";
import { probeMigrations } from "../server/probe/index.mjs";
import { renditionsMigration } from "../server/renditions/index.mjs";
import {
  clusterFederationMigration, clusterMigration, createClusterManifestService, createFederatedCatalogRepository
} from "../server/cluster/index.mjs";

const now = "2026-07-19T12:00:00.000Z";
const nodeIds = ["node_shard_alpha", "node_shard_bravo"];
const setup = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyDomainMigrations(database, [catalogMigration, ...probeMigrations, renditionsMigration, clusterMigration, clusterFederationMigration]);
  for (const nodeId of nodeIds) database.prepare(`INSERT INTO cluster_nodes
    (node_id, cluster_id, name, role, endpoint, public_key, capabilities_json, paired_at, updated_at)
    VALUES (?, 'cluster_fixture', ?, 'shard', ?, ?, '{}', ?, ?)`)
    .run(nodeId, nodeId, `https://${nodeId}.example-tail.ts.net`, Buffer.alloc(32, 1).toString("base64url"), now, now);
  return database;
};
const source = ({ digest, externalIds = [], localItemId, localSourceId, title = "Fixture", year = 2026 }) => ({
  availability: "available", bitrate: 4_000_000, durationSeconds: 3600, externalIds,
  fingerprint: { algorithm: "sha256", digest, sourceRevision: 1, state: "ready" },
  height: 1080, itemKind: "movie", localItemId, localSourceId, mediaKind: "video", removedAt: null,
  renditions: [], sizeBytes: 10_000, sourceRevision: 1, title, width: 1920, year
});
const page = (nodeId, sources) => ({ complete: true, cursor: null, manifestRevision: 1, nodeId, protocolVersion: 1, sources });

test("manifest pagination is bounded, path-free, and revision pinned", async () => {
  const database = setup();
  const ids = ["scan_fixture_0001", "item_fixture_001", "source_fixture_001", "item_fixture_002", "source_fixture_002"];
  const catalog = createCatalogRepository(database, { now: () => now, uuid: () => ids.shift() });
  const library = catalog.ensureLibrary({ id: "library_fixture", name: "Fixture" });
  const root = catalog.ensureRoot({ id: "root_fixture", libraryId: library.id, path: "/not-exposed", rootKey: "fixture" });
  catalog.reconcileScan({ rootId: root.id, files: [
    { fileKey: "1:1", itemType: "movie", mediaKind: "video", modifiedMs: 1, path: "Secret/A.mp4", size: 10, title: "A" },
    { fileKey: "1:2", itemType: "movie", mediaKind: "video", modifiedMs: 1, path: "Secret/B.mp4", size: 20, title: "B" }
  ] });
  const manifest = createClusterManifestService({ database, nodeId: nodeIds[0] });
  const first = await manifest.page({ limit: 1 });
  assert.equal(first.complete, false);
  assert.equal(first.sources.length, 1);
  assert.doesNotMatch(JSON.stringify(first), /Secret|contentPath|not-exposed/);
  const second = await manifest.page({ cursor: first.cursor, limit: 1 });
  assert.equal(second.complete, true);
  database.prepare("UPDATE media_items SET title = 'Changed' WHERE id = ?").run(first.sources[0].localItemId);
  await assert.rejects(() => manifest.page({ cursor: first.cursor, limit: 1 }), (error) => error.code === "cursor_lost");
  database.close();
});

test("exact replicas collapse while ambiguous alternate encodes remain separate", () => {
  const database = setup();
  let sequence = 0;
  const federated = createFederatedCatalogRepository(database, { now: () => now, uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` });
  federated.applyManifestPage({ nodeId: nodeIds[0], page: page(nodeIds[0], [source({ digest: "a".repeat(64), localItemId: "local_item_alpha", localSourceId: "local_source_alpha" })]), syncGeneration: "sync_alpha_01" });
  federated.applyManifestPage({ nodeId: nodeIds[1], page: page(nodeIds[1], [source({ digest: "a".repeat(64), localItemId: "local_item_bravo", localSourceId: "local_source_bravo" })]), syncGeneration: "sync_bravo_01" });
  assert.deepEqual(federated.listItems().map(({ nodeCount, sourceCount, title }) => ({ nodeCount, sourceCount, title })), [{ nodeCount: 2, sourceCount: 2, title: "Fixture" }]);

  federated.applyManifestPage({ nodeId: nodeIds[1], page: { ...page(nodeIds[1], [
    source({ digest: "a".repeat(64), localItemId: "local_item_bravo", localSourceId: "local_source_bravo" }),
    source({ digest: "b".repeat(64), localItemId: "local_item_cut", localSourceId: "local_source_cut" })
  ]), manifestRevision: 2 }, syncGeneration: "sync_bravo_02" });
  assert.equal(federated.listItems().length, 2);
  assert.equal(federated.listConflicts().length, 1);
  federated.setOverride({ action: "merge", leftOrigin: `${nodeIds[0]}:local_item_alpha`, rightOrigin: `${nodeIds[1]}:local_item_cut` });
  assert.equal(federated.listItems().length, 1);
  federated.setOverride({ action: "split", leftOrigin: `${nodeIds[0]}:local_item_alpha`, rightOrigin: `${nodeIds[1]}:local_item_cut` });
  assert.equal(federated.listItems().length, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM federated_dedupe_overrides").get().count, 1);
  database.close();
});

test("strong provider identity groups alternate encodes without marking them exact replicas", () => {
  const database = setup();
  const federated = createFederatedCatalogRepository(database);
  const externalIds = [{ mediaType: "movie", provider: "tmdb", providerItemId: "123" }];
  federated.applyManifestPage({ nodeId: nodeIds[0], page: page(nodeIds[0], [source({ digest: "c".repeat(64), externalIds, localItemId: "provider_item_a", localSourceId: "provider_source_a" })]), syncGeneration: "sync_provider_a" });
  federated.applyManifestPage({ nodeId: nodeIds[1], page: page(nodeIds[1], [source({ digest: "d".repeat(64), externalIds, localItemId: "provider_item_b", localSourceId: "provider_source_b" })]), syncGeneration: "sync_provider_b" });
  assert.equal(federated.listItems().length, 1);
  assert.equal(federated.listItems()[0].sourceCount, 2);
  assert.equal(database.prepare("SELECT COUNT(DISTINCT fingerprint_key) AS count FROM federated_replicas").get().count, 2);
  database.close();
});
