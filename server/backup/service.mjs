import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdir, open, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { BackupError, throwIfAborted } from "./errors.mjs";
import {
  BACKUP_FORMAT, BACKUP_FORMAT_VERSION, DATABASE_ENTRY, REQUIRED_TABLES,
  readAndValidateManifest, resolveInside, resolveReferencedCache, sha256File, validateDatabase
} from "./validation.mjs";

const safeId = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) && value !== "." && value !== "..";

const reserve = async (reservationPath) => {
  try { return await open(reservationPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new BackupError("already_exists", "A backup with that id already exists.");
    throw error;
  }
};

const atomicNoClobberFile = async (source, destination) => {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await link(temporary, destination);
  } catch (error) {
    if (error.code === "EEXIST") throw new BackupError("already_exists", "Restore destination already exists.");
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
};

export const createBackupService = ({ database, databasePath, dataRoot, backupRoot, now = () => new Date(), uuid = randomUUID, requiredTables = REQUIRED_TABLES }) => {
  if (!database || typeof database.prepare !== "function") throw new TypeError("An open SQLite database is required.");
  for (const [name, value] of Object.entries({ databasePath, dataRoot, backupRoot })) if (!path.isAbsolute(value ?? "")) throw new TypeError(`${name} must be an absolute path.`);

  const inspect = async ({ backupId, signal } = {}) => {
    throwIfAborted(signal);
    if (!safeId(backupId)) throw new BackupError("invalid_id", "Backup id is invalid.");
    const bundleRoot = path.join(backupRoot, backupId);
    const manifest = await readAndValidateManifest(bundleRoot);
    if (manifest.backupId !== backupId) throw new BackupError("invalid_manifest", "Backup id does not match its manifest.");
    for (const file of manifest.files) {
      throwIfAborted(signal);
      const absolutePath = resolveInside(bundleRoot, file.path);
      const info = await stat(absolutePath).catch(() => null);
      if (!info?.isFile() || info.size !== file.size || await sha256File(absolutePath, signal) !== file.sha256) {
        throw new BackupError("checksum_failed", "Backup file validation failed.");
      }
    }
    const databaseEntry = manifest.files.find((entry) => entry.role === "database" && entry.path === DATABASE_ENTRY);
    if (!databaseEntry) throw new BackupError("invalid_manifest", "Backup database entry is missing.");
    const schema = validateDatabase(resolveInside(bundleRoot, DATABASE_ENTRY), { requiredTables });
    const cacheEntries = manifest.files.filter(({ role }) => role === "metadata-cache");
    const declared = new Set(cacheEntries.map(({ databaseReference }) => databaseReference));
    const snapshot = new DatabaseSync(resolveInside(bundleRoot, DATABASE_ENTRY), { readOnly: true });
    try {
      for (const { local_path: reference } of snapshot.prepare("SELECT local_path FROM media_artwork WHERE local_path != ''").all()) {
        if (!declared.has(reference)) throw new BackupError("cache_incomplete", "Backup omits a referenced cached metadata file.");
      }
    } finally { snapshot.close(); }
    return { manifest, schema };
  };

  const create = async ({ backupId = uuid(), signal } = {}) => {
    throwIfAborted(signal);
    if (!safeId(backupId)) throw new BackupError("invalid_id", "Backup id is invalid.");
    await mkdir(backupRoot, { recursive: true });
    const finalRoot = path.join(backupRoot, backupId);
    const stagingRoot = path.join(backupRoot, `.${backupId}.${uuid()}.tmp`);
    const reservationPath = path.join(backupRoot, `.${backupId}.reserve`);
    const reservation = await reserve(reservationPath);
    try {
      if (await stat(finalRoot).catch(() => null)) throw new BackupError("already_exists", "A backup with that id already exists.");
      await mkdir(path.join(stagingRoot, "database"), { recursive: true });
      const snapshotPath = path.join(stagingRoot, DATABASE_ENTRY);
      await sqliteBackup(database, snapshotPath, { progress: () => { throwIfAborted(signal); } });
      throwIfAborted(signal);
      const schema = validateDatabase(snapshotPath, { requiredTables });
      const files = [{ path: DATABASE_ENTRY, role: "database", size: (await stat(snapshotPath)).size, sha256: await sha256File(snapshotPath, signal) }];
      const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
      try {
        const references = snapshot.prepare("SELECT DISTINCT local_path FROM media_artwork WHERE local_path != '' ORDER BY local_path").all();
        for (const { local_path: reference } of references) {
          throwIfAborted(signal);
          const source = await resolveReferencedCache(dataRoot, reference);
          const bundlePath = `metadata-cache/${source.dataPath}`;
          const destination = resolveInside(stagingRoot, bundlePath);
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(source.absolutePath, destination, constants.COPYFILE_EXCL);
          files.push({ path: bundlePath, role: "metadata-cache", databaseReference: reference, sourceDataPath: source.dataPath, size: source.size, sha256: await sha256File(destination, signal) });
        }
      } finally { snapshot.close(); }
      const manifest = { backupId, createdAt: now().toISOString(), databaseFile: path.basename(databasePath), format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, files, migrations: schema.migrations, includesContentMedia: false };
      await writeFile(path.join(stagingRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      throwIfAborted(signal);
      await rename(stagingRoot, finalRoot);
      return manifest;
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw error;
    } finally {
      await reservation.close();
      await unlink(reservationPath).catch(() => {});
    }
  };

  const list = async ({ signal } = {}) => {
    throwIfAborted(signal);
    const entries = await readdir(backupRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const backups = [];
    for (const entry of entries) {
      throwIfAborted(signal);
      if (!entry.isDirectory() || !safeId(entry.name)) continue;
      try {
        const manifest = await readAndValidateManifest(path.join(backupRoot, entry.name));
        backups.push(manifest);
      } catch {
        backups.push({ backupId: entry.name, createdAt: null, files: [], format: null, formatVersion: null, includesContentMedia: false, invalid: true, migrations: [] });
      }
    }
    return backups.sort((left, right) => {
      const leftCreated = left.createdAt ? Date.parse(left.createdAt) : -Infinity;
      const rightCreated = right.createdAt ? Date.parse(right.createdAt) : -Infinity;
      if (rightCreated !== leftCreated) return rightCreated - leftCreated;
      return String(right.backupId).localeCompare(String(left.backupId));
    });
  };

  const restore = async ({ backupId, destinationDatabasePath, destinationDataRoot = dataRoot, restoreMetadataCache = true, signal } = {}) => {
    if (!path.isAbsolute(destinationDatabasePath ?? "") || !path.isAbsolute(destinationDataRoot ?? "")) throw new TypeError("Restore destinations must be absolute paths.");
    const { manifest } = await inspect({ backupId, signal });
    const bundleRoot = path.join(backupRoot, backupId);
    throwIfAborted(signal);
    const written = [];
    try {
      await atomicNoClobberFile(resolveInside(bundleRoot, DATABASE_ENTRY), destinationDatabasePath);
      written.push(destinationDatabasePath);
      if (restoreMetadataCache) for (const entry of manifest.files.filter(({ role }) => role === "metadata-cache")) {
        throwIfAborted(signal);
        const destination = resolveInside(destinationDataRoot, entry.sourceDataPath);
        await atomicNoClobberFile(resolveInside(bundleRoot, entry.path), destination);
        written.push(destination);
      }
      return { backupId, databasePath: destinationDatabasePath, metadataCacheFiles: written.length - 1 };
    } catch (error) {
      await Promise.all(written.map((file) => rm(file, { force: true })));
      throw error;
    }
  };

  return { create, inspect, list, restore };
};
