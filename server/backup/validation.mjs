import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BackupError, throwIfAborted } from "./errors.mjs";

export const BACKUP_FORMAT = "nebula-backup";
export const BACKUP_FORMAT_VERSION = 1;
export const DATABASE_ENTRY = "database/nebula.sqlite";
export const REQUIRED_TABLES = Object.freeze([
  "users", "sessions", "login_attempts", "cinema_watchlist", "user_migrations", "media_tickets", "server_settings",
  "nebula_domain_migrations", "media_libraries", "media_library_roots", "media_items",
  "media_renditions",
  "media_sources", "media_source_fingerprints", "media_external_ids", "media_artwork", "media_scan_runs",
  "playback_states", "playback_sessions", "playback_events", "background_jobs",
  "cluster_identity", "cluster_nodes", "cluster_pairing_codes", "cluster_request_nonces",
  "cluster_identity_rotations", "cluster_identity_rotation_peers", "cluster_node_key_rotations",
  "cluster_local_manifest_state", "cluster_manifest_cursors", "federated_items", "federated_editions",
  "federated_sources", "federated_replicas", "federated_dedupe_overrides", "federated_dedupe_conflicts",
  "media_probe_results", "media_streams", "media_chapters", "playback_policy_config"
]);

export const sha256File = async (filePath, signal) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    throwIfAborted(signal);
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const isInside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);

export const resolveInside = (root, relativePath) => {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    throw new BackupError("invalid_manifest", "Backup contains an invalid relative path.");
  }
  const resolved = path.resolve(root, relativePath);
  if (!isInside(path.resolve(root), resolved)) throw new BackupError("invalid_manifest", "Backup path escapes its root.");
  return resolved;
};

export const resolveReferencedCache = async (dataRoot, reference) => {
  const root = await realpath(dataRoot);
  const candidate = path.isAbsolute(reference) ? reference : path.resolve(root, reference);
  const resolved = await realpath(candidate);
  if (!isInside(root, resolved)) throw new BackupError("unsafe_cache_reference", "A cached metadata reference escapes the configured data root.");
  const info = await stat(resolved);
  if (!info.isFile()) throw new BackupError("invalid_cache_reference", "A cached metadata reference is not a regular file.");
  return { absolutePath: resolved, dataPath: path.relative(root, resolved).split(path.sep).join("/"), size: info.size };
};

export const validateDatabase = (databasePath, { requiredTables = REQUIRED_TABLES } = {}) => {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const integrity = database.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new BackupError("integrity_failed", "Backup database failed SQLite integrity validation.");
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length) throw new BackupError("foreign_key_failed", "Backup database contains invalid foreign-key references.");
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name));
    const missing = requiredTables.filter((name) => !tables.has(name));
    if (missing.length) throw new BackupError("schema_incomplete", `Backup database is missing required domain tables: ${missing.join(", ")}.`);
    const migrations = database.prepare("SELECT migration_id, applied_at FROM nebula_domain_migrations ORDER BY migration_id").all();
    return { migrations, tables: [...tables].sort() };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("invalid_database", "Backup database could not be opened or validated.", { cause: error });
  } finally {
    database?.close();
  }
};

export const readAndValidateManifest = async (bundleRoot) => {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(bundleRoot, "manifest.json"), "utf8"));
  } catch (error) {
    throw new BackupError("invalid_manifest", "Backup manifest is missing or invalid.", { cause: error });
  }
  if (manifest?.format !== BACKUP_FORMAT || manifest?.formatVersion !== BACKUP_FORMAT_VERSION || !Array.isArray(manifest.files)) {
    throw new BackupError("unsupported_format", "Backup format or version is not supported.");
  }
  return manifest;
};
