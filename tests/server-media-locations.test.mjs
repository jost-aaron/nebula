import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";
import { discoverLocalMedia } from "../server/catalog/scanner.mjs";
import { createMediaLocationsService, mediaLocationsMigration } from "../server/mediaLocations/index.mjs";

const setup = async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nebula-media-locations-"));
  const contentRoot = path.join(directory, "content");
  await Promise.all(["Movies A", "Movies B", "Shows", "Music"].map((folder) => mkdir(path.join(contentRoot, folder), { recursive: true })));
  const database = new DatabaseSync(":memory:");
  applyDomainMigrations(database, [mediaLocationsMigration]);
  let nextId = 1;
  const service = createMediaLocationsService({ contentRoot, database, uuid: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}` });
  t.after(async () => { database.close(); await rm(directory, { force: true, recursive: true }); });
  return { contentRoot, database, service };
};

test("media locations persist multiple folders per category and normalize content-root paths", async (t) => {
  const { database, service } = await setup(t);
  const first = await service.add({ category: "movies", contentPath: "/app/content/Movies A/" });
  const second = await service.add({ category: "movies", contentPath: "Movies B" });
  const music = await service.add({ category: "music", contentPath: "Music" });
  assert.deepEqual(service.list().map(({ category, contentPath }) => [category, contentPath]), [
    ["movies", "Movies A"], ["movies", "Movies B"], ["music", "Music"]
  ]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM media_locations").get().count, 3);
  assert.equal(service.remove(second.id).contentPath, "Movies B");
  assert.deepEqual(service.list().map(({ id }) => id), [first.id, music.id]);
});

test("media locations reject missing, escaping, reserved, and overlapping folders", async (t) => {
  const { service } = await setup(t);
  await service.add({ category: "tv", contentPath: "Shows" });
  await assert.rejects(service.add({ category: "games", contentPath: "Movies A" }), { code: "invalid_media_category", status: 400 });
  await assert.rejects(service.add({ category: "movies", contentPath: "../outside" }), { code: "invalid_media_location", status: 400 });
  await assert.rejects(service.add({ category: "movies", contentPath: "/app/content" }), { code: "invalid_media_location", status: 400 });
  await assert.rejects(service.add({ category: "movies", contentPath: ".uploads/private" }), { code: "invalid_media_location", status: 400 });
  await assert.rejects(service.add({ category: "movies", contentPath: "Missing" }), { code: "media_location_missing", status: 404 });
  await assert.rejects(service.add({ category: "tv", contentPath: "Shows/Season 1" }), { code: "overlapping_media_location", status: 409 });
});

test("configured folders merge into stable category-specific discovery results", async (t) => {
  const { contentRoot } = await setup(t);
  await writeFile(path.join(contentRoot, "Movies A", "Alpha.mkv"), "a");
  await writeFile(path.join(contentRoot, "Movies B", "Bravo.mp4"), "b");
  await writeFile(path.join(contentRoot, "Shows", "Series.S02E03.mkv"), "c");
  await writeFile(path.join(contentRoot, "Music", "Track.flac"), "d");
  const locations = [
    ["Movies A", "movie", "video"], ["Movies B", "movie", "video"],
    ["Shows", "episode", "video"], ["Music", "track", "audio"]
  ];
  const merged = (await Promise.all(locations.map(([folder, itemTypeOverride, mediaKind]) => discoverLocalMedia({
    absoluteRoot: path.join(contentRoot, folder), contentPathPrefix: folder, itemTypeOverride, mediaKind
  })))).flat();
  assert.deepEqual(merged.map(({ itemType, mediaKind, path: contentPath }) => [itemType, mediaKind, contentPath]), [
    ["movie", "video", "Movies A/Alpha.mkv"],
    ["movie", "video", "Movies B/Bravo.mp4"],
    ["episode", "video", "Shows/Series.S02E03.mkv"],
    ["track", "audio", "Music/Track.flac"]
  ]);
});
