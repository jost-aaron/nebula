import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";

const ASSET_NAME = /^(?:master\.m3u8|media\.m3u8|segment-\d{5}\.ts)$/;
const SEGMENT_NAME = /^segment-\d{5}\.ts$/;
const contained = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const timestamp = () => new Date().toISOString();
const publicRow = (row) => row ? ({
  audioBitrate: row.audio_bitrate, bitrate: row.bitrate, completedAt: row.completed_at,
  createdAt: row.created_at, error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
  height: row.height, id: row.id, itemId: row.item_id, lastAccessedAt: row.last_accessed_at,
  origin: row.origin, profileId: row.profile_id, profileVersion: row.profile_version,
  retention: row.retention, sizeBytes: row.size_bytes, sourceId: row.source_id,
  sourceRevision: row.source_revision, state: row.state, updatedAt: row.updated_at,
  videoBitrate: row.video_bitrate, width: row.width
}) : null;

const safeStoragePath = async (root, storageKey) => {
  if (typeof storageKey !== "string" || !storageKey || path.isAbsolute(storageKey)) return null;
  const normalized = path.normalize(storageKey);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return null;
  const candidate = path.resolve(root, normalized);
  if (!contained(root, candidate)) return null;
  const resolved = await realpath(candidate).catch(() => null);
  return resolved && contained(root, resolved) ? resolved : null;
};

const verifyHlsDirectory = async (directory, expectedChecksum = null) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (!names.includes("master.m3u8") || !names.includes("media.m3u8") || names.some((name) => !ASSET_NAME.test(name))) {
    throw new Error("Rendition contains an unexpected asset.");
  }
  for (const entry of entries) {
    if (!entry.isFile() || (await lstat(path.join(directory, entry.name))).isSymbolicLink()) {
      throw new Error("Rendition assets must be regular files.");
    }
  }
  const master = await readFile(path.join(directory, "master.m3u8"), "utf8");
  const media = await readFile(path.join(directory, "media.m3u8"), "utf8");
  if (!master.split(/\r?\n/).includes("media.m3u8") || !media.includes("#EXT-X-ENDLIST")) {
    throw new Error("Rendition playlists are incomplete.");
  }
  const referencedSegments = media.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
  if (referencedSegments.length < 1 || referencedSegments.some((name) => !SEGMENT_NAME.test(name) || !names.includes(name))) {
    throw new Error("Rendition playlist references invalid segments.");
  }
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for (const name of names) {
    const bytes = await readFile(path.join(directory, name));
    hash.update(name); hash.update("\0"); hash.update(bytes);
    sizeBytes += bytes.byteLength;
  }
  const checksum = `sha256:${hash.digest("hex")}`;
  if (expectedChecksum && checksum !== expectedChecksum) throw new Error("Rendition checksum does not match.");
  return { checksum, sizeBytes };
};

export const createRenditionStore = ({ database, dataRoot, now = timestamp, uuid = randomUUID } = {}) => {
  if (!database || typeof database.prepare !== "function") throw new TypeError("A SQLite database is required.");
  if (!dataRoot) throw new TypeError("dataRoot is required.");
  const root = path.join(path.resolve(dataRoot), "renditions");
  const initialize = async () => {
    await mkdir(root, { recursive: true });
    database.prepare("UPDATE media_renditions SET state = 'stale', error_code = 'build_interrupted', error_message = 'Rendition build was interrupted.', updated_at = ? WHERE state IN ('pending', 'building')")
      .run(now());
  };
  const initialized = initialize();
  const keyValues = ({ sourceId, sourceRevision, profile }) => [sourceId, sourceRevision, profile.id, profile.version];
  const rowFor = (key) => database.prepare(`SELECT * FROM media_renditions
    WHERE source_id = ? AND source_revision = ? AND profile_id = ? AND profile_version = ?`).get(...keyValues(key)) ?? null;
  const get = (id) => publicRow(database.prepare(`SELECT r.*, s.item_id FROM media_renditions r
    JOIN media_sources s ON s.id = r.source_id WHERE r.id = ?`).get(id));
  const listForItem = (itemId) => database.prepare(`SELECT r.*, s.item_id FROM media_renditions r
    JOIN media_sources s ON s.id = r.source_id WHERE s.item_id = ? ORDER BY r.profile_id, r.updated_at DESC`)
    .all(itemId).map(publicRow);
  const setRetention = (id, retention) => {
    if (!["cache", "pinned"].includes(retention)) throw Object.assign(new Error("Invalid rendition retention."), { status: 400, expose: true });
    database.prepare("UPDATE media_renditions SET retention = ?, updated_at = ? WHERE id = ?").run(retention, now(), id);
    return get(id);
  };
  const remove = async (id) => {
    await initialized;
    const row = database.prepare("SELECT * FROM media_renditions WHERE id = ?").get(id);
    if (!row) return false;
    const directory = row.storage_key ? await safeStoragePath(root, row.storage_key) : null;
    if (directory) await rm(directory, { recursive: true, force: true });
    database.prepare("DELETE FROM media_renditions WHERE id = ?").run(id);
    return true;
  };
  const invalidate = async (row, code = "asset_invalid") => {
    database.prepare("UPDATE media_renditions SET state = 'stale', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?")
      .run(code, "Persisted rendition failed verification.", now(), row.id);
    const directory = await safeStoragePath(root, row.storage_key);
    if (directory) await rm(directory, { recursive: true, force: true });
  };
  const findReady = async (key) => {
    await initialized;
    const row = rowFor(key);
    if (!row || row.state !== "ready" || !row.storage_key || !row.checksum) return null;
    const directory = await safeStoragePath(root, row.storage_key);
    if (!directory) { await invalidate(row); return null; }
    try {
      const verified = await verifyHlsDirectory(directory, row.checksum);
      if (verified.sizeBytes !== row.size_bytes) throw new Error("Rendition size does not match.");
      database.prepare("UPDATE media_renditions SET last_accessed_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), row.id);
      return { directory, id: row.id, storageKey: row.storage_key };
    } catch {
      await invalidate(row);
      return null;
    }
  };
  const begin = async (key, { origin = "interactive", retention = "cache" } = {}) => {
    await initialized;
    const existing = rowFor(key);
    const id = existing?.id ?? uuid();
    const current = now();
    database.prepare(`INSERT INTO media_renditions
      (id, source_id, source_revision, profile_id, profile_version, state, retention, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'building', ?, ?, ?, ?)
      ON CONFLICT(source_id, source_revision, profile_id, profile_version) DO UPDATE SET
        state = 'building', retention = excluded.retention, origin = excluded.origin, storage_key = NULL,
        width = NULL, height = NULL, bitrate = NULL, video_bitrate = NULL, audio_bitrate = NULL,
        size_bytes = NULL, checksum = NULL, error_code = NULL, error_message = NULL,
        completed_at = NULL, updated_at = excluded.updated_at`)
      .run(id, ...keyValues(key), retention, origin, current, current);
    return { id };
  };
  const publish = async (key, temporaryDirectory, metadata = {}) => {
    await initialized;
    const row = rowFor(key);
    if (!row || row.state !== "building") throw new Error("Rendition build is not active.");
    const verified = await verifyHlsDirectory(temporaryDirectory);
    const storageKey = row.id;
    const destination = path.join(root, storageKey);
    await rm(destination, { recursive: true, force: true });
    await rename(temporaryDirectory, destination);
    try {
      const current = now();
      database.prepare(`UPDATE media_renditions SET state = 'ready', storage_key = ?, width = ?, height = ?,
        bitrate = ?, video_bitrate = ?, audio_bitrate = ?, size_bytes = ?, checksum = ?, error_code = NULL,
        error_message = NULL, completed_at = ?, last_accessed_at = ?, updated_at = ? WHERE id = ?`)
        .run(storageKey, metadata.width ?? null, metadata.height ?? null, metadata.bitrate ?? null,
          metadata.videoBitrate ?? null, metadata.audioBitrate ?? null, verified.sizeBytes, verified.checksum,
          current, current, current, row.id);
      return { directory: destination, id: row.id, storageKey };
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  };
  const fail = async (key, error) => {
    await initialized;
    const row = rowFor(key);
    if (!row || row.state !== "building") return;
    database.prepare("UPDATE media_renditions SET state = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?")
      .run(String(error?.code ?? "build_failed").slice(0, 64), "Rendition generation failed.", now(), row.id);
  };
  return { begin, fail, findReady, get, initialize: () => initialized, listForItem, publish, remove, root, setRetention };
};

export { verifyHlsDirectory };
