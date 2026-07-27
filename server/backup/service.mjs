import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { BackupError, throwIfAborted } from "./errors.mjs";
import {
  BACKUP_FORMAT, BACKUP_FORMAT_VERSION, DATABASE_ENTRY, REQUIRED_TABLES,
  readAndValidateManifest, resolveInside, resolveReferencedCache, sha256File, validateDatabase
} from "./validation.mjs";

const safeId = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) && value !== "." && value !== "..";
const OPERATION_STATES = new Set(["cancelled", "failed", "interrupted", "queued", "running", "succeeded"]);
const METADATA_DIRECTORY = ".metadata";
const OPERATIONS_DIRECTORY = ".operations";

const atomicJson = async (filePath, value, uuid) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${uuid()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
};

const publicOperation = (operation) => ({
  operationId: operation.operationId,
  backupId: operation.backupId,
  state: operation.state,
  progress: operation.progress,
  createdAt: operation.createdAt,
  startedAt: operation.startedAt ?? null,
  finishedAt: operation.finishedAt ?? null,
  error: operation.error ?? null
});

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

export const createBackupService = ({
  database,
  databasePath,
  dataRoot,
  backupRoot,
  now = () => new Date(),
  uuid = randomUUID,
  requiredTables = REQUIRED_TABLES,
  retentionMaxBackups = 0,
  maxOperationRecords = 200
}) => {
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
    const partyEntries = manifest.files.filter(({ role }) => role === "party-attachment");
    const declaredPartyAttachments = new Set(partyEntries.map(({ databaseReference }) => databaseReference));
    const snapshot = new DatabaseSync(resolveInside(bundleRoot, DATABASE_ENTRY), { readOnly: true });
    try {
      for (const { local_path: reference } of snapshot.prepare("SELECT local_path FROM media_artwork WHERE local_path != ''").all()) {
        if (!declared.has(reference)) throw new BackupError("cache_incomplete", "Backup omits a referenced cached metadata file.");
      }
      const expectedPartyAttachments = new Map(snapshot.prepare(
        "SELECT storage_key, size_bytes, sha256 FROM party_attachments ORDER BY storage_key"
      ).all().map((row) => [row.storage_key, row]));
      for (const storageKey of expectedPartyAttachments.keys()) {
        if (!declaredPartyAttachments.has(storageKey)) {
          throw new BackupError("party_attachments_incomplete", "Backup omits a referenced Party attachment.");
        }
      }
      if (partyEntries.length !== expectedPartyAttachments.size || partyEntries.some((entry) =>
        !expectedPartyAttachments.has(entry.databaseReference)
        || entry.path !== `party-attachments/${entry.databaseReference}`
        || entry.sourceDataPath !== `party-attachments/${entry.databaseReference}`
        || entry.size !== expectedPartyAttachments.get(entry.databaseReference).size_bytes
        || entry.sha256 !== expectedPartyAttachments.get(entry.databaseReference).sha256
      )) {
        throw new BackupError("invalid_party_attachments", "Backup contains an invalid Party attachment entry.");
      }
    } finally { snapshot.close(); }
    const metadata = await readMetadata(backupId);
    return {
      manifest: { ...manifest, pinned: metadata.pinned, retention: metadata.pinned ? "pinned" : "standard" },
      schema
    };
  };

  if (!Number.isSafeInteger(retentionMaxBackups) || retentionMaxBackups < 0) {
    throw new TypeError("retentionMaxBackups must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(maxOperationRecords) || maxOperationRecords < 10 || maxOperationRecords > 10_000) {
    throw new TypeError("maxOperationRecords must be an integer from 10 through 10000.");
  }

  const metadataPath = (backupId) => path.join(backupRoot, METADATA_DIRECTORY, `${backupId}.json`);
  const operationPath = (operationId) => path.join(backupRoot, OPERATIONS_DIRECTORY, `${operationId}.json`);
  const readMetadata = async (backupId) => {
    try {
      const parsed = JSON.parse(await readFile(metadataPath(backupId), "utf8"));
      return { pinned: parsed?.pinned === true, updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null };
    } catch (error) {
      if (error?.code === "ENOENT") return { pinned: false, updatedAt: null };
      // Fail closed: corrupt retention metadata must never make a possibly
      // pinned backup eligible for automatic deletion.
      if (error instanceof SyntaxError) return { pinned: true, updatedAt: null };
      throw error;
    }
  };
  const writeMetadata = (backupId, metadata) => atomicJson(metadataPath(backupId), {
    backupId,
    pinned: metadata.pinned === true,
    updatedAt: now().toISOString()
  }, uuid);
  const readOperation = async (operationId) => {
    if (!safeId(operationId)) throw new BackupError("invalid_id", "Backup operation id is invalid.");
    let operation;
    try {
      operation = JSON.parse(await readFile(operationPath(operationId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") throw new BackupError("not_found", "Backup operation was not found.");
      if (error instanceof SyntaxError) throw new BackupError("invalid_operation", "Backup operation metadata is invalid.");
      throw error;
    }
    if (operation.operationId !== operationId || !safeId(operation.backupId) || !OPERATION_STATES.has(operation.state)) {
      throw new BackupError("invalid_operation", "Backup operation metadata is invalid.");
    }
    return operation;
  };
  const writeOperation = (operation) => atomicJson(operationPath(operation.operationId), operation, uuid);
  const pruneOperationRecords = async () => {
    const directory = path.join(backupRoot, OPERATIONS_DIRECTORY);
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    if (entries.length <= maxOperationRecords) return;
    const terminal = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const operationId = entry.name.slice(0, -5);
      if (!safeId(operationId)) continue;
      try {
        const operation = await readOperation(operationId);
        if (!["queued", "running"].includes(operation.state)) terminal.push(operation);
      } catch {}
    }
    terminal.sort((left, right) =>
      Date.parse(right.finishedAt ?? right.createdAt) - Date.parse(left.finishedAt ?? left.createdAt)
    );
    const excess = Math.max(0, entries.length - maxOperationRecords);
    await Promise.all(terminal.slice(-excess).map(({ operationId }) => rm(operationPath(operationId), { force: true })));
  };

  const createExclusive = async ({ backupId = uuid(), signal, onProgress = () => {} } = {}) => {
    throwIfAborted(signal);
    if (!safeId(backupId)) throw new BackupError("invalid_id", "Backup id is invalid.");
    await onProgress({ phase: "snapshot", completedFiles: 0, totalFiles: null });
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
      await onProgress({ phase: "collecting", completedFiles: 1, totalFiles: null });
      const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
      try {
        const references = snapshot.prepare("SELECT DISTINCT local_path FROM media_artwork WHERE local_path != '' ORDER BY local_path").all();
        const partyAttachments = snapshot.prepare(
          "SELECT storage_key, size_bytes, sha256 FROM party_attachments ORDER BY storage_key"
        ).all();
        const totalFiles = 1 + references.length + partyAttachments.length;
        await onProgress({ phase: "copying", completedFiles: 1, totalFiles });
        for (const { local_path: reference } of references) {
          throwIfAborted(signal);
          const source = await resolveReferencedCache(dataRoot, reference);
          const bundlePath = `metadata-cache/${source.dataPath}`;
          const destination = resolveInside(stagingRoot, bundlePath);
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(source.absolutePath, destination, constants.COPYFILE_EXCL);
          files.push({ path: bundlePath, role: "metadata-cache", databaseReference: reference, sourceDataPath: source.dataPath, size: source.size, sha256: await sha256File(destination, signal) });
          await onProgress({ phase: "copying", completedFiles: files.length, totalFiles });
        }
        for (const {
          storage_key: storageKey,
          size_bytes: expectedSize,
          sha256: expectedSha256
        } of partyAttachments) {
          throwIfAborted(signal);
          const reference = `party-attachments/${storageKey}`;
          const source = await resolveReferencedCache(dataRoot, reference);
          if (source.dataPath !== reference) {
            throw new BackupError("unsafe_party_attachment", "A Party attachment reference does not match its protected storage path.");
          }
          const bundlePath = `party-attachments/${storageKey}`;
          const destination = resolveInside(stagingRoot, bundlePath);
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(source.absolutePath, destination, constants.COPYFILE_EXCL);
          const checksum = await sha256File(destination, signal);
          if (source.size !== expectedSize || checksum !== expectedSha256) {
            throw new BackupError("party_attachment_corrupt", "A Party attachment does not match its database metadata.");
          }
          files.push({
            path: bundlePath,
            role: "party-attachment",
            databaseReference: storageKey,
            sourceDataPath: source.dataPath,
            size: source.size,
            sha256: checksum
          });
          await onProgress({ phase: "copying", completedFiles: files.length, totalFiles });
        }
      } finally { snapshot.close(); }
      await onProgress({ phase: "finalizing", completedFiles: files.length, totalFiles: files.length });
      const manifest = { backupId, createdAt: now().toISOString(), databaseFile: path.basename(databasePath), format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, files, migrations: schema.migrations, includesContentMedia: false };
      await writeFile(path.join(stagingRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      throwIfAborted(signal);
      await rename(stagingRoot, finalRoot);
      await writeMetadata(backupId, { pinned: false }).catch(() => {});
      await onProgress({ phase: "completed", completedFiles: files.length, totalFiles: files.length });
      return manifest;
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw error;
    } finally {
      await reservation.close();
      await unlink(reservationPath).catch(() => {});
    }
  };
  let activeCreate = null;
  const backgroundOperationToken = Symbol("backup-background-operation");
  const create = async (options = {}) => {
    if (activeCreate || (activeOperation && options.backgroundOperationToken !== backgroundOperationToken)) {
      throw new BackupError("busy", "Another backup is already running.");
    }
    const operation = createExclusive(options);
    activeCreate = operation;
    try {
      const manifest = await operation;
      // Publication is the creation transaction boundary. A later retention
      // cleanup failure must not report the already-published bundle as failed
      // or cancelled and tempt an operator to retry with the same id.
      if (retentionMaxBackups > 0) await prune({ maxBackups: retentionMaxBackups }).catch(() => {});
      return manifest;
    } finally {
      if (activeCreate === operation) activeCreate = null;
    }
  };

  const setPinned = async ({ backupId, pinned, signal } = {}) => {
    throwIfAborted(signal);
    if (!safeId(backupId)) throw new BackupError("invalid_id", "Backup id is invalid.");
    if (typeof pinned !== "boolean") throw new BackupError("invalid_pinned", "Pinned must be a boolean.");
    const bundle = await stat(path.join(backupRoot, backupId)).catch(() => null);
    if (!bundle?.isDirectory()) throw new BackupError("not_found", "Backup was not found.");
    await writeMetadata(backupId, { pinned });
    return { backupId, pinned, retention: pinned ? "pinned" : "standard" };
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
        const metadata = await readMetadata(entry.name);
        backups.push({ ...manifest, pinned: metadata.pinned, retention: metadata.pinned ? "pinned" : "standard" });
      } catch {
        const metadata = await readMetadata(entry.name);
        backups.push({ backupId: entry.name, createdAt: null, files: [], format: null, formatVersion: null, includesContentMedia: false, invalid: true, migrations: [], pinned: metadata.pinned, retention: metadata.pinned ? "pinned" : "standard" });
      }
    }
    return backups.sort((left, right) => {
      const leftCreated = left.createdAt ? Date.parse(left.createdAt) : -Infinity;
      const rightCreated = right.createdAt ? Date.parse(right.createdAt) : -Infinity;
      if (rightCreated !== leftCreated) return rightCreated - leftCreated;
      return String(right.backupId).localeCompare(String(left.backupId));
    });
  };

  const prune = async ({ maxBackups = retentionMaxBackups, signal } = {}) => {
    throwIfAborted(signal);
    if (!Number.isSafeInteger(maxBackups) || maxBackups < 0) throw new BackupError("invalid_retention", "Backup retention limit is invalid.");
    if (maxBackups === 0) return { deletedBackupIds: [], maxBackups };
    const backups = [];
    for (const candidate of await list({ signal })) {
      if (candidate.invalid === true) continue;
      try {
        const { manifest } = await inspect({ backupId: candidate.backupId, signal });
        backups.push(manifest);
      } catch (error) {
        if (error?.code === "cancelled") throw error;
        // Corrupt or incomplete bundles are retained for operator diagnosis.
      }
    }
    const latestGoodId = backups[0]?.backupId ?? null;
    const deletable = backups
      .filter(({ backupId, pinned }) => backupId !== latestGoodId && pinned !== true)
      .reverse();
    const deletedBackupIds = [];
    let remaining = backups.length;
    for (const backup of deletable) {
      if (remaining <= maxBackups) break;
      throwIfAborted(signal);
      if ((await readMetadata(backup.backupId)).pinned) continue;
      await rm(path.join(backupRoot, backup.backupId), { recursive: true, force: true });
      await rm(metadataPath(backup.backupId), { force: true });
      deletedBackupIds.push(backup.backupId);
      remaining -= 1;
    }
    return { deletedBackupIds, maxBackups };
  };

  let activeOperation = null;
  const operationPromises = new Map();
  const startCreate = async ({ backupId = uuid() } = {}) => {
    if (!safeId(backupId)) throw new BackupError("invalid_id", "Backup id is invalid.");
    if (activeCreate || activeOperation) throw new BackupError("busy", "Another backup is already running.");
    const operationId = uuid();
    if (!safeId(operationId)) throw new BackupError("invalid_id", "Generated backup operation id is invalid.");
    const controller = new AbortController();
    const operation = {
      operationId,
      backupId,
      state: "queued",
      progress: { phase: "queued", completedFiles: 0, totalFiles: null },
      createdAt: now().toISOString()
    };
    activeOperation = { controller, operationId };
    try {
      await writeOperation(operation);
    } catch (error) {
      activeOperation = null;
      throw error;
    }
    const run = (async () => {
      let lastProgressPhase = "queued";
      let lastProgressWrite = 0;
      try {
        operation.state = "running";
        operation.startedAt = now().toISOString();
        await writeOperation(operation);
        const manifest = await create({
          backupId,
          backgroundOperationToken,
          signal: controller.signal,
          onProgress: async (progress) => {
            operation.progress = progress;
            const timestamp = Date.now();
            if (
              progress.phase !== lastProgressPhase
              || progress.completedFiles === progress.totalFiles
              || timestamp - lastProgressWrite >= 250
            ) {
              await writeOperation(operation);
              lastProgressPhase = progress.phase;
              lastProgressWrite = timestamp;
            }
          }
        });
        operation.state = "succeeded";
        operation.finishedAt = now().toISOString();
        operation.progress = { phase: "completed", completedFiles: manifest.files.length, totalFiles: manifest.files.length };
      } catch (error) {
        operation.state = error?.code === "cancelled" ? "cancelled" : "failed";
        operation.finishedAt = now().toISOString();
        operation.error = {
          code: typeof error?.code === "string" ? error.code : "backup_failed",
          message: error instanceof BackupError ? error.message : "Backup creation failed."
        };
      } finally {
        try {
          await writeOperation(operation);
        } finally {
          if (activeOperation?.operationId === operationId) activeOperation = null;
        }
        await pruneOperationRecords().catch(() => {});
      }
      return publicOperation(operation);
    })();
    operationPromises.set(operationId, run);
    void run.then(
      () => operationPromises.delete(operationId),
      () => operationPromises.delete(operationId)
    );
    return publicOperation(operation);
  };

  const getOperation = async ({ operationId } = {}) => {
    const operation = await readOperation(operationId);
    if ((operation.state === "queued" || operation.state === "running") && activeOperation?.operationId !== operationId) {
      operation.state = "interrupted";
      operation.finishedAt = now().toISOString();
      operation.error = { code: "interrupted", message: "Backup creation was interrupted before completion." };
      await writeOperation(operation);
    }
    return publicOperation(operation);
  };

  const waitOperation = async ({ operationId } = {}) => {
    if (!safeId(operationId)) throw new BackupError("invalid_id", "Backup operation id is invalid.");
    const pending = operationPromises.get(operationId);
    return pending ? await pending : getOperation({ operationId });
  };

  const cancelOperation = async ({ operationId } = {}) => {
    const operation = await getOperation({ operationId });
    if (operation.state !== "queued" && operation.state !== "running") {
      throw new BackupError("not_cancellable", "Backup operation is not running.");
    }
    if (activeOperation?.operationId !== operationId) {
      throw new BackupError("not_cancellable", "Backup operation is not running.");
    }
    activeOperation.controller.abort();
    return { ...operation, state: "cancelling" };
  };
  const listPage = async ({ cursor = null, limit = 50, signal } = {}) => {
    let offset = 0;
    if (cursor) {
      try {
        offset = Number.parseInt(Buffer.from(String(cursor), "base64url").toString("utf8"), 10);
      } catch {
        offset = Number.NaN;
      }
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new BackupError("invalid_cursor", "Backup cursor is invalid.");
      }
    }
    const pageSize = Math.max(1, Math.min(100, Number(limit) || 50));
    const backups = await list({ signal });
    const page = backups.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      backups: page,
      nextCursor: nextOffset < backups.length
        ? Buffer.from(String(nextOffset), "utf8").toString("base64url")
        : null
    };
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
      const restoredMetadata = [];
      const restoredPartyAttachments = [];
      const restorable = manifest.files.filter(({ role }) =>
        (restoreMetadataCache && role === "metadata-cache") || role === "party-attachment"
      );
      for (const entry of restorable) {
        throwIfAborted(signal);
        const destination = resolveInside(destinationDataRoot, entry.sourceDataPath);
        await atomicNoClobberFile(resolveInside(bundleRoot, entry.path), destination);
        written.push(destination);
        if (entry.role === "metadata-cache") restoredMetadata.push(destination);
        else restoredPartyAttachments.push(destination);
      }
      return {
        backupId,
        databasePath: destinationDatabasePath,
        metadataCacheFiles: restoredMetadata.length,
        partyAttachmentFiles: restoredPartyAttachments.length
      };
    } catch (error) {
      await Promise.all(written.map((file) => rm(file, { force: true })));
      throw error;
    }
  };

  return {
    cancelOperation,
    create,
    getOperation,
    inspect,
    list,
    listPage,
    prune,
    restore,
    setPinned,
    startCreate,
    waitOperation
  };
};
