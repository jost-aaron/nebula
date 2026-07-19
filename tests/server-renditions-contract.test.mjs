import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";
import { catalogMigration } from "../server/catalog/index.mjs";
import {
  getRenditionProfile,
  listRenditionProfiles,
  normalizeQualityPreference,
  RENDITION_PROFILES,
  renditionsMigration
} from "../server/renditions/index.mjs";

test("built-in rendition profiles are versioned, bounded, and ordered by quality", () => {
  assert.deepEqual(RENDITION_PROFILES.map(({ id }) => id), ["240p", "360p", "480p", "720p", "1080p"]);
  assert.ok(RENDITION_PROFILES.every((entry) => Object.isFrozen(entry)));
  assert.ok(RENDITION_PROFILES.every((entry) => entry.version === 1));
  assert.ok(RENDITION_PROFILES.every((entry) => entry.protocol === "hls" && entry.container === "mpegts"));
  assert.ok(RENDITION_PROFILES.every((entry) => entry.videoCodec === "h264" && entry.audioCodec === "aac"));
  assert.ok(RENDITION_PROFILES.every((entry) => entry.totalBitrate >= entry.videoBitrate + entry.audioBitrate));
  assert.equal(getRenditionProfile("720p")?.maxHeight, 720);
  assert.equal(getRenditionProfile("4k"), null);
});

test("quality preferences fail closed and source dimensions suppress upscaling profiles", () => {
  assert.deepEqual(normalizeQualityPreference(undefined), { mode: "auto" });
  assert.deepEqual(normalizeQualityPreference({ mode: "original" }), { mode: "original" });
  assert.deepEqual(normalizeQualityPreference({ mode: "profile", profileId: "480p" }), { mode: "profile", profileId: "480p" });
  assert.equal(normalizeQualityPreference({ mode: "profile", profileId: "4k" }), null);
  assert.equal(normalizeQualityPreference({ mode: "unsafe", ffmpeg: ["-f", "rawvideo"] }), null);
  assert.deepEqual(listRenditionProfiles({ sourceHeight: 1080, sourceWidth: 1920 }).map(({ id }) => id), ["240p", "360p", "480p", "720p", "1080p"]);
  assert.deepEqual(listRenditionProfiles({ sourceHeight: 720, sourceWidth: 1280 }).map(({ id }) => id), ["240p", "360p", "480p", "720p"]);
  assert.deepEqual(listRenditionProfiles({ sourceHeight: 360, sourceWidth: 640 }).map(({ id }) => id), ["240p", "360p"]);
  assert.deepEqual(listRenditionProfiles({ sourceHeight: 240, sourceWidth: 426 }).map(({ id }) => id), ["240p"]);
});

test("rendition migration composes with catalog identity and enforces revision uniqueness", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyDomainMigrations(database, [catalogMigration, renditionsMigration]);
  applyDomainMigrations(database, [catalogMigration, renditionsMigration]);

  const now = "2026-07-12T20:00:00.000Z";
  database.prepare("INSERT INTO media_libraries (id, name, media_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("library-1", "Movies", "video", now, now);
  database.prepare(`INSERT INTO media_library_roots
    (id, library_id, root_key, path, media_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("root-1", "library-1", "content", "/app/content", "video", now, now);
  database.prepare(`INSERT INTO media_items
    (id, library_id, item_type, media_kind, title, sort_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("item-1", "library-1", "movie", "video", "Fixture", "Fixture", now, now);
  database.prepare(`INSERT INTO media_sources
    (id, item_id, root_id, content_path, media_kind, size_bytes, modified_ms, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("source-1", "item-1", "root-1", "Fixture.mkv", "video", 1024, 1, now, now, now, now);

  const insert = database.prepare(`INSERT INTO media_renditions
    (id, source_id, source_revision, profile_id, profile_version, state, retention, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run("rendition-1", "source-1", 1, "720p", 1, "pending", "cache", "interactive", now, now);
  assert.throws(() => insert.run("rendition-duplicate", "source-1", 1, "720p", 1, "pending", "cache", "scheduled", now, now));
  assert.throws(() => insert.run("rendition-invalid", "source-1", 1, "480p", 1, "unknown", "cache", "interactive", now, now));

  const row = database.prepare("SELECT * FROM media_renditions WHERE id = ?").get("rendition-1");
  assert.equal(row.source_revision, 1);
  assert.equal(row.profile_id, "720p");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM nebula_domain_migrations WHERE migration_id = 'renditions-v1'").get().count, 1);

  database.prepare("DELETE FROM media_sources WHERE id = ?").run("source-1");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM media_renditions").get().count, 0);
  database.close();
});
