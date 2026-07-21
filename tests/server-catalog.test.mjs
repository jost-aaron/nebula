import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyCatalogMigration,
  bootstrapSharedContentRoot,
  catalogMigration,
  createCatalogRepository,
  importLegacyCinemaMetadata,
  projectRepositoryItems,
  scanLocalRoot
} from "../server/catalog/index.mjs";

const setup = async (t, options = {}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nebula-catalog-test-"));
  const contentRoot = path.join(directory, "content");
  await mkdir(contentRoot);
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyCatalogMigration(database);
  const repository = createCatalogRepository(database, options);
  const { library, root } = bootstrapSharedContentRoot(repository, {
    contentRoot,
    libraryId: "10000000-0000-4000-8000-000000000001",
    rootId: "20000000-0000-4000-8000-000000000001"
  });
  t.after(async () => { database.close(); await rm(directory, { force: true, recursive: true }); });
  return { contentRoot, database, directory, library, repository, root };
};

test("catalog migration creates a fresh schema without owning PRAGMA user_version", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA user_version = 73");
  catalogMigration.apply(database);
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'media_%' ORDER BY name").all().map(({ name }) => name);
  assert.deepEqual(tables, ["media_artwork", "media_external_ids", "media_items", "media_libraries", "media_library_roots", "media_scan_runs", "media_source_fingerprints", "media_sources"]);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 73);
  database.close();
});

test("catalog migration upgrades an existing application database idempotently", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY) STRICT;
    INSERT INTO users VALUES ('kept');
    CREATE TABLE media_external_ids (
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_item_id TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (media_item_id, provider),
      UNIQUE (provider, provider_item_id, media_type)
    ) STRICT;
  `);
  applyCatalogMigration(database);
  applyCatalogMigration(database);
  assert.equal(database.prepare("SELECT id FROM users").get().id, "kept");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM media_libraries").get().count, 0);
  const externalIdsSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_external_ids'").get().sql;
  assert.doesNotMatch(externalIdsSql, /UNIQUE\s*\(\s*provider\s*,\s*provider_item_id\s*,\s*media_type\s*\)/i);
  database.close();
});

test("shared content bootstrap supports one mixed root and future typed roots", async (t) => {
  const { contentRoot, database, library, repository, root } = await setup(t);
  assert.equal(library.media_kind, "mixed");
  assert.equal(root.root_key, "shared-content");
  assert.equal(root.path, contentRoot);
  const repeated = bootstrapSharedContentRoot(repository, { contentRoot });
  assert.equal(repeated.library.id, library.id);
  assert.equal(repeated.root.id, root.id);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM media_libraries").get().count, 1);
  const video = repository.ensureLibrary({ id: "10000000-0000-4000-8000-000000000002", mediaKind: "video", name: "Movies" });
  const typed = repository.ensureRoot({ libraryId: video.id, mediaKind: "video", path: "/future/movies", rootKey: "future-movies", rootType: "local" });
  assert.equal(typed.media_kind, "video");
});

test("full scans are idempotent and changed files preserve stable UUID identities", async (t) => {
  const { contentRoot, repository, root } = await setup(t);
  await writeFile(path.join(contentRoot, "Movie.mp4"), "first");
  const first = await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const initial = repository.resolveContentPath("Movie.mp4", root.id);
  const duplicate = await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  assert.deepEqual({ new: first.new, unchanged: duplicate.unchanged }, { new: 1, unchanged: 1 });
  assert.equal(repository.listItems().length, 1);
  await writeFile(path.join(contentRoot, "Movie.mp4"), "changed and larger");
  const changed = await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const current = repository.resolveContentPath("Movie.mp4", root.id);
  assert.equal(changed.changed, 1);
  assert.equal(current.id, initial.id);
  assert.equal(current.itemId, initial.itemId);
  assert.equal(current.contentRevision, 2);
});

test("catalog pages bound menu work and search across unloaded titles", async (t) => {
  const { contentRoot, repository, root } = await setup(t);
  await writeFile(path.join(contentRoot, "Alpha.mp4"), "alpha");
  await writeFile(path.join(contentRoot, "Bravo.mp4"), "bravo");
  await writeFile(path.join(contentRoot, "Charlie.mp4"), "charlie");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const first = repository.listItemsPage({ availability: "available", limit: 2, mediaKind: "video" });
  const second = repository.listItemsPage({ availability: "available", limit: 2, mediaKind: "video", offset: 2 });
  const searched = repository.listItemsPage({ availability: "available", limit: 2, mediaKind: "video", query: "charlie" });
  assert.deepEqual({ first: first.items.map(({ title }) => title), second: second.items.map(({ title }) => title), total: first.total }, {
    first: ["Alpha", "Bravo"], second: ["Charlie"], total: 3
  });
  assert.deepEqual(searched.items.map(({ title }) => title), ["Charlie"]);
});

test("full scans reclassify legacy TV Shows paths without replacing stable identities", async (t) => {
  const { contentRoot, repository, root } = await setup(t);
  await mkdir(path.join(contentRoot, "TV Shows"));
  await writeFile(path.join(contentRoot, "TV Shows", "Pilot.mp4"), "episode");
  repository.reconcileScan({ files: [{ fileKey: null, itemType: "movie", mediaKind: "video", modifiedMs: 1, path: "TV Shows/Pilot.mp4", size: 7, sortTitle: "Pilot", title: "Pilot" }], rootId: root.id, scanType: "full" });
  const before = repository.resolveContentPath("TV Shows/Pilot.mp4", root.id);
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const after = repository.resolveContentPath("TV Shows/Pilot.mp4", root.id);
  assert.equal(repository.getItem(after.itemId).itemType, "episode");
  assert.equal(after.id, before.id);
  assert.equal(after.itemId, before.itemId);
});

test("inode-backed renames preserve source and item UUIDs", async (t) => {
  const { contentRoot, repository, root } = await setup(t);
  await mkdir(path.join(contentRoot, "Movies"));
  await writeFile(path.join(contentRoot, "Movies", "Old.mp4"), "movie");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const before = repository.resolveContentPath("Movies/Old.mp4", root.id);
  await rename(path.join(contentRoot, "Movies", "Old.mp4"), path.join(contentRoot, "Movies", "New.mp4"));
  const scan = await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const after = repository.resolveContentPath("Movies/New.mp4", root.id);
  assert.equal(scan.renamed, 1);
  assert.equal(after.id, before.id);
  assert.equal(after.itemId, before.itemId);
  assert.equal(after.contentRevision, before.contentRevision);
  assert.equal(after.previousPath, "Movies/Old.mp4");
  assert.equal(repository.resolveContentPath("Movies/Old.mp4", root.id), null);
});

test("inode-backed renames increment the source revision when content facts change", async (t) => {
  const { contentRoot, repository, root } = await setup(t);
  const oldPath = path.join(contentRoot, "Old.mp4");
  const newPath = path.join(contentRoot, "New.mp4");
  await writeFile(oldPath, "movie");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const before = repository.resolveContentPath("Old.mp4", root.id);
  await rename(oldPath, newPath);
  await writeFile(newPath, "changed movie bytes");

  const scan = await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const after = repository.resolveContentPath("New.mp4", root.id);
  assert.equal(scan.renamed, 1);
  assert.equal(after.id, before.id);
  assert.equal(after.itemId, before.itemId);
  assert.equal(after.contentRevision, before.contentRevision + 1);
});

test("same-path replacement creates new identities and supersedes the old source", async (t) => {
  const { contentRoot, database, repository, root } = await setup(t);
  const target = path.join(contentRoot, "Replace.mp4");
  await writeFile(target, "old");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const before = repository.resolveContentPath("Replace.mp4", root.id);
  const replacement = path.join(contentRoot, "replacement.tmp");
  await writeFile(replacement, "new replacement bytes");
  await rename(replacement, target);
  const scan = await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const after = repository.resolveContentPath("Replace.mp4", root.id);
  assert.equal(scan.new, 1);
  assert.notEqual(after.id, before.id);
  assert.notEqual(after.itemId, before.itemId);
  assert.equal(after.contentRevision, 1);
  assert.equal(database.prepare("SELECT availability FROM media_sources WHERE id = ?").get(before.id).availability, "superseded");
});

test("incremental scans do not mark omissions missing; full scans mark, restore, then age cleanup", async (t) => {
  let clock = Date.parse("2026-07-01T00:00:00.000Z");
  const { contentRoot, repository, root } = await setup(t, { missingCleanupMs: 1_000, missingCleanupScans: 2, now: () => new Date(clock).toISOString() });
  const mediaPath = path.join(contentRoot, "Return.mp4");
  const parkedPath = path.join(path.dirname(contentRoot), "Return.parked");
  await writeFile(mediaPath, "returns");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const initial = repository.resolveContentPath("Return.mp4", root.id);
  await rename(mediaPath, parkedPath);
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id, scanType: "incremental" });
  assert.equal(repository.getSource(initial.id).availability, "available");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  assert.equal(repository.getSource(initial.id).availability, "missing");
  assert.equal(repository.listCleanupCandidates().length, 0);
  clock += 2_000;
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  assert.equal(repository.listCleanupCandidates()[0].id, initial.id);
  await rename(parkedPath, mediaPath);
  const restored = await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const current = repository.resolveContentPath("Return.mp4", root.id);
  assert.equal(restored.restored, 1);
  assert.equal(current.id, initial.id);
  assert.equal(current.cleanupEligibleAt, null);
});

test("restoring changed content preserves source identity and increments its revision", async (t) => {
  const { contentRoot, repository, root } = await setup(t);
  const mediaPath = path.join(contentRoot, "Return.mp4");
  const parkedPath = path.join(path.dirname(contentRoot), "Return.changed");
  await writeFile(mediaPath, "original");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const before = repository.resolveContentPath("Return.mp4", root.id);
  await rename(mediaPath, parkedPath);
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  await writeFile(parkedPath, "changed while missing");
  await rename(parkedPath, mediaPath);

  const scan = await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const after = repository.resolveContentPath("Return.mp4", root.id);
  assert.equal(scan.restored, 1);
  assert.equal(after.id, before.id);
  assert.equal(after.itemId, before.itemId);
  assert.equal(after.contentRevision, before.contentRevision + 1);
});

test("filesystem discovery failures persist failed scan state", async (t) => {
  const { contentRoot, database, repository, root } = await setup(t);
  await assert.rejects(scanLocalRoot({ absoluteRoot: path.join(contentRoot, "not-there"), repository, rootId: root.id }), /ENOENT/);
  const rootState = database.prepare("SELECT scan_status, last_scan_error FROM media_library_roots WHERE id = ?").get(root.id);
  const run = database.prepare("SELECT status, error FROM media_scan_runs WHERE root_id = ?").get(root.id);
  assert.equal(rootState.scan_status, "failed");
  assert.match(rootState.last_scan_error, /ENOENT/);
  assert.equal(run.status, "failed");
});

test("legacy metadata imports through catalog APIs, stays idempotent, and locks manual fields", async (t) => {
  const { contentRoot, directory, repository, root } = await setup(t);
  await writeFile(path.join(contentRoot, "Legacy.mp4"), "legacy");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const metadataPath = path.join(directory, ".cinema-metadata.json");
  await writeFile(metadataPath, JSON.stringify({
    "Legacy.mp4": { backdropUrl: "https://img/backdrop.jpg", genres: ["Drama"], posterUrl: "https://img/poster.jpg", releaseYear: "2024", title: "Manual title", tmdbId: 42, tmdbMediaType: "movie" },
    "Missing.mp4": { title: "Not imported" }
  }));
  const first = await importLegacyCinemaMetadata({ metadataPath, repository, rootId: root.id });
  const second = await importLegacyCinemaMetadata({ metadataPath, repository, rootId: root.id });
  assert.deepEqual(first, { imported: 1, skipped: 0, unresolved: ["Missing.mp4"] });
  assert.equal(second.imported, 1);
  const source = repository.resolveContentPath("Legacy.mp4", root.id);
  repository.putExternalMetadata(source.itemId, { fields: { summary: "Provider summary", title: "Provider title" }, mode: "provider" });
  const item = repository.getItem(source.itemId);
  assert.equal(item.title, "Manual title");
  assert.equal(item.metadata.summary, "Provider summary");
  assert.ok(item.lockedFields.includes("title"));
  assert.deepEqual(repository.listExternalIds(item.id), [{ id: "42", mediaType: "movie", provider: "tmdb" }]);
  assert.equal(repository.listArtwork(item.id).length, 2);
});

test("episode items can share a provider series external ID", async (t) => {
  const { contentRoot, repository, root } = await setup(t);
  await mkdir(path.join(contentRoot, "TV", "Series"), { recursive: true });
  await writeFile(path.join(contentRoot, "TV", "Series", "Series.S01E01.mp4"), "episode one");
  await writeFile(path.join(contentRoot, "TV", "Series", "Series.S01E02.mp4"), "episode two");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const episodes = repository.listItems({ mediaKind: "video" });
  assert.equal(episodes.length, 2);
  assert.ok(episodes.every((episode) => episode.itemType === "episode"));
  for (const episode of episodes) {
    repository.putExternalMetadata(episode.id, {
      externalIds: [{ id: "98765", mediaType: "tv", provider: "tmdb" }]
    });
  }
  assert.deepEqual(episodes.map((episode) => repository.listExternalIds(episode.id)), [
    [{ id: "98765", mediaType: "tv", provider: "tmdb" }],
    [{ id: "98765", mediaType: "tv", provider: "tmdb" }]
  ]);
});

test("compatibility projection preserves Cinema and Studio fields while adding catalog IDs", async (t) => {
  const { contentRoot, repository, root } = await setup(t);
  await writeFile(path.join(contentRoot, "Film.mp4"), "film");
  await writeFile(path.join(contentRoot, "Song.mp3"), "song");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const entries = projectRepositoryItems(repository);
  const film = entries.find((entry) => entry.path === "Film.mp4");
  const song = entries.find((entry) => entry.path === "Song.mp3");
  const catalogFilm = repository.listItems({ mediaKind: "video" }).find((entry) => entry.id === film.id);
  assert.match(film.id, /^[0-9a-f-]{36}$/);
  assert.match(film.sourceId, /^[0-9a-f-]{36}$/);
  assert.equal(catalogFilm.source.itemId, film.id);
  assert.equal(film.category, "movies");
  assert.equal(film.streamUrl, "/api/cinema/media?path=Film.mp4");
  assert.equal(song.category, "music");
  assert.equal(song.streamUrl, "/api/music/media?path=Song.mp3");
  assert.equal(song.availability, "available");
});
