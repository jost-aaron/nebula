import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createBackupService } from "../server/backup/index.mjs";
import { migrateAccountSchema } from "../server/accountStore.mjs";
import { applyDomainMigrations, openNebulaDatabase } from "../server/database.mjs";
import { catalogMigration } from "../server/catalog/schema.mjs";
import { PLAYBACK_MIGRATION } from "../server/playback/schema.mjs";
import { jobsMigration } from "../server/jobs/schema.mjs";
import { probeMigration } from "../server/probe/catalogAdapter.mjs";
import { playbackPolicyMigration } from "../server/playbackPolicy/index.mjs";
import { auditMigration } from "../server/audit/schema.mjs";

const fixture = async (t) => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "nebula-backup-")));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const dataRoot = path.join(root, "data");
  const databasePath = path.join(dataRoot, "nebula.sqlite");
  const database = await openNebulaDatabase(databasePath);
  migrateAccountSchema(database);
  applyDomainMigrations(database, [catalogMigration, PLAYBACK_MIGRATION, probeMigration, jobsMigration, playbackPolicyMigration, auditMigration]);
  t.after(() => database.close());
  return { backupRoot: path.join(root, "backups"), dataRoot, database, databasePath, root };
};

test("online backup captures WAL state and restores every persisted domain", async (t) => {
  const scope = await fixture(t);
  const now = "2026-07-11T12:00:00.000Z";
  scope.database.prepare(`INSERT INTO users (id, username, display_name, password_credential, role, created_at, updated_at)
    VALUES ('owner', 'owner', 'Owner', 'secret-hash', 'owner', ?, ?)`).run(now, now);
  scope.database.prepare("INSERT INTO cinema_watchlist (user_id, content_path, created_at) VALUES ('owner', 'Movies/example.mp4', ?)").run(now);
  scope.database.prepare("INSERT INTO media_libraries (id, name, media_kind, created_at, updated_at) VALUES ('lib', 'Media', 'mixed', ?, ?)").run(now, now);
  scope.database.prepare(`INSERT INTO media_library_roots (id, library_id, root_key, path, media_kind, created_at, updated_at)
    VALUES ('root', 'lib', 'shared', '/app/content', 'mixed', ?, ?)`).run(now, now);
  scope.database.prepare(`INSERT INTO media_items (id, library_id, item_type, media_kind, title, sort_title, created_at, updated_at)
    VALUES ('item', 'lib', 'movie', 'video', 'Example', 'Example', ?, ?)`).run(now, now);
  scope.database.prepare(`INSERT INTO media_sources (id, item_id, root_id, content_path, media_kind, size_bytes, modified_ms, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES ('source', 'item', 'root', 'Movies/example.mp4', 'video', 10, 1, ?, ?, ?, ?)`).run(now, now, now, now);
  scope.database.prepare("INSERT INTO playback_states (user_id, item_id, source_id, position_seconds, updated_at) VALUES ('owner', 'item', 'source', 42, ?)").run(now);
  scope.database.prepare(`INSERT INTO background_jobs (id, type, state, payload_json, progress, attempt, max_attempts, available_at, created_at, updated_at)
    VALUES ('job', 'probe', 'queued', '{}', 0, 0, 3, ?, ?, ?)`).run(now, now, now);
  scope.database.prepare("INSERT INTO media_probe_results (source_id, format_name, probed_at) VALUES ('source', 'mp4', ?)").run(now);
  scope.database.prepare(`INSERT INTO audit_events
    (id, event_type, actor_kind, principal_id, actor_role, target_type, target_id, occurred_at, outcome, metadata_json)
    VALUES ('audit', 'job.enqueued', 'account', 'owner', 'owner', 'job', 'job', ?, 'success', '{"jobType":"probe"}')`).run(now);

  const service = createBackupService({ ...scope, now: () => new Date(now) });
  const manifest = await service.create({ backupId: "wave4" });
  assert.equal(manifest.includesContentMedia, false);
  assert.deepEqual(manifest.files.map(({ role }) => role), ["database"]);
  assert.ok(manifest.migrations.some(({ migration_id }) => migration_id === "probe-v1"));
  await service.inspect({ backupId: "wave4" });
  const destination = path.join(scope.root, "restore", "nebula.sqlite");
  const restored = await service.restore({ backupId: "wave4", destinationDatabasePath: destination });
  assert.equal(restored.metadataCacheFiles, 0);
  const db = new DatabaseSync(destination, { readOnly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT position_seconds FROM playback_states WHERE user_id = 'owner'").get().position_seconds, 42);
  assert.equal(db.prepare("SELECT state FROM background_jobs WHERE id = 'job'").get().state, "queued");
  assert.equal(db.prepare("SELECT format_name FROM media_probe_results WHERE source_id = 'source'").get().format_name, "mp4");
  assert.equal(db.prepare("SELECT event_type FROM audit_events WHERE id = 'audit'").get().event_type, "job.enqueued");
});

test("backup includes only safe catalog-referenced metadata cache files", async (t) => {
  const scope = await fixture(t);
  const cachePath = path.join(scope.dataRoot, "metadata-cache", "poster.jpg");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(cachePath), { recursive: true }));
  await writeFile(cachePath, "poster bytes");
  scope.database.exec(`
    INSERT INTO media_libraries VALUES ('lib', 'Media', 'mixed', 'now', 'now');
    INSERT INTO media_items (id, library_id, item_type, media_kind, title, sort_title, created_at, updated_at) VALUES ('item', 'lib', 'movie', 'video', 'Title', 'Title', 'now', 'now');
    INSERT INTO media_artwork (id, media_item_id, artwork_type, local_path, created_at, updated_at) VALUES ('art', 'item', 'poster', 'metadata-cache/poster.jpg', 'now', 'now');
  `);
  const service = createBackupService(scope);
  const manifest = await service.create({ backupId: "with-cache" });
  assert.equal(manifest.files.find(({ role }) => role === "metadata-cache").sourceDataPath, "metadata-cache/poster.jpg");
  const restoreRoot = path.join(scope.root, "restore-data");
  await service.restore({ backupId: "with-cache", destinationDatabasePath: path.join(scope.root, "restore.sqlite"), destinationDataRoot: restoreRoot });
  assert.equal(await readFile(path.join(restoreRoot, "metadata-cache", "poster.jpg"), "utf8"), "poster bytes");
});

test("restore rejects tampering and never clobbers an existing database", async (t) => {
  const scope = await fixture(t);
  const service = createBackupService(scope);
  await service.create({ backupId: "protected" });
  const destination = path.join(scope.root, "existing.sqlite");
  await writeFile(destination, "keep me");
  await assert.rejects(service.restore({ backupId: "protected", destinationDatabasePath: destination }), { code: "already_exists" });
  assert.equal(await readFile(destination, "utf8"), "keep me");
  await writeFile(path.join(scope.backupRoot, "protected", "database", "nebula.sqlite"), "tampered");
  await assert.rejects(service.inspect({ backupId: "protected" }), { code: "checksum_failed" });
});

test("listing summarizes valid backups and marks invalid bundles without leaking filesystem paths", async (t) => {
  const scope = await fixture(t);
  const service = createBackupService(scope);
  await service.create({ backupId: "valid-backup" });
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(scope.backupRoot, "broken-backup"), { recursive: true }));
  await writeFile(path.join(scope.backupRoot, "broken-backup", "manifest.json"), "{");
  const listed = await service.list();
  assert.deepEqual(listed.map((entry) => ({ backupId: entry.backupId, invalid: entry.invalid === true })), [
    { backupId: "valid-backup", invalid: false },
    { backupId: "broken-backup", invalid: true }
  ]);
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(scope.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("cancelled creation removes staging and reservation artifacts", async (t) => {
  const scope = await fixture(t);
  const service = createBackupService(scope);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.create({ backupId: "cancelled", signal: controller.signal }), { code: "cancelled" });
  assert.deepEqual(await readdir(scope.backupRoot).catch(() => []), []);
});
