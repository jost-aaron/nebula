import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyCatalogMigration, createCatalogRepository, createFingerprintRepository, createFingerprintService
} from "../server/catalog/index.mjs";

const fixture = async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "nebula-fingerprint-"));
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyCatalogMigration(database);
  const catalog = createCatalogRepository(database, { now: () => "2026-07-19T12:00:00.000Z" });
  const library = catalog.ensureLibrary({ id: "library_fixture", name: "Fixture" });
  const catalogRoot = catalog.ensureRoot({ id: "root_fixture", libraryId: library.id, mediaKind: "mixed", path: root, rootKey: "fixture" });
  t.after(async () => { database.close(); await rm(root, { recursive: true }); });
  return { catalog, catalogRoot, database, root };
};

test("fingerprints are full-file SHA-256 values bound to source revision and byte length", async (t) => {
  const { catalog, catalogRoot, database, root } = await fixture(t);
  const bytes = Buffer.from("nebula exact replica fixture\n".repeat(2048));
  await writeFile(path.join(root, "movie.mp4"), bytes);
  catalog.reconcileScan({ rootId: catalogRoot.id, files: [{ fileKey: "dev:1", itemType: "movie", mediaKind: "video", modifiedMs: 1, path: "movie.mp4", size: bytes.length, title: "Movie" }] });
  const source = catalog.listItems()[0].source;
  const fingerprints = createFingerprintRepository(database);
  const progress = [];
  const service = createFingerprintService({ contentRoot: root, repository: fingerprints, resolveSource: catalog.getSource });
  const result = await service.fingerprintSource(source.id, { reportProgress: (value) => progress.push(value) });
  assert.equal(result.digest, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.byteLength, bytes.length);
  assert.equal(result.sourceRevision, 1);
  assert.equal(result.state, "ready");
  assert.equal(progress.at(-1), 1);
});

test("catalog revision changes atomically invalidate old fingerprints", async (t) => {
  const { catalog, catalogRoot, database, root } = await fixture(t);
  await writeFile(path.join(root, "song.flac"), "first");
  const file = { fileKey: "dev:2", itemType: "track", mediaKind: "audio", modifiedMs: 1, path: "song.flac", size: 5, title: "Song" };
  catalog.reconcileScan({ rootId: catalogRoot.id, files: [file] });
  const source = catalog.listItems()[0].source;
  const fingerprints = createFingerprintRepository(database);
  await createFingerprintService({ contentRoot: root, repository: fingerprints, resolveSource: catalog.getSource }).fingerprintSource(source.id);
  catalog.reconcileScan({ rootId: catalogRoot.id, files: [{ ...file, modifiedMs: 2, size: 6 }] });
  assert.deepEqual(fingerprints.get(source.id), {
    algorithm: "sha256", algorithmVersion: 1, byteLength: 6, digest: null, errorCode: null,
    fingerprintedAt: null, sourceId: source.id, sourceRevision: 2, state: "pending", updatedAt: "2026-07-19T12:00:00.000Z"
  });
});

test("stale fingerprint publication fails closed", async (t) => {
  const { catalog, catalogRoot, database, root } = await fixture(t);
  await writeFile(path.join(root, "movie.mp4"), "fixture");
  catalog.reconcileScan({ rootId: catalogRoot.id, files: [{ fileKey: "dev:3", itemType: "movie", mediaKind: "video", modifiedMs: 1, path: "movie.mp4", size: 7, title: "Movie" }] });
  const source = catalog.listItems()[0].source;
  const fingerprints = createFingerprintRepository(database);
  assert.throws(
    () => fingerprints.write({ byteLength: 7, digest: "a".repeat(64), sourceId: source.id, sourceRevision: 2 }),
    (error) => error.code === "stale_source_revision"
  );
});
