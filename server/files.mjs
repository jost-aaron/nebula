import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { json, readBody } from "./http.mjs";
import { mimeType, safeFileName } from "./storage.mjs";

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;
const DEFAULT_MAX_UPLOAD_BYTES = 100 * GIBIBYTE;
const DEFAULT_MINIMUM_FREE_BYTES = 256 * MEBIBYTE;
const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 200;
const STAT_CONCURRENCY = 8;
const ACTIVE_PREVIEW_EXTENSIONS = new Set([".css", ".htm", ".html", ".js", ".mjs", ".svg", ".xml"]);

const fileError = (message, { code, status }) => Object.assign(new Error(message), {
  code,
  expose: true,
  status
});

const boundedInteger = (value, fallback, maximum) => {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw fileError("Pagination value is invalid.", { code: "invalid_pagination", status: 400 });
  }
  return Math.min(parsed, maximum);
};

const mapLimit = async (values, limit, mapper) => {
  const results = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

const byteLimitTransform = (limit, message = "Upload exceeds the configured size limit.") => {
  let received = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > limit) {
        callback(fileError(message, { code: "upload_too_large", status: 413 }));
        return;
      }
      callback(null, chunk);
    }
  });
};

export const createFilesRoutes = (storage, {
  filesystemStats = () => statfs(storage.contentRoot),
  maxUploadBytes = Number(process.env.NEBULA_FILES_MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES),
  minimumFreeBytes = Number(process.env.NEBULA_FILES_MINIMUM_FREE_BYTES ?? DEFAULT_MINIMUM_FREE_BYTES),
  uploadTtlMs = Number(process.env.NEBULA_FILES_UPLOAD_TTL_MS ?? DEFAULT_UPLOAD_TTL_MS)
} = {}) => {
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES;
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0) minimumFreeBytes = DEFAULT_MINIMUM_FREE_BYTES;
  if (!Number.isSafeInteger(uploadTtlMs) || uploadTtlMs < 60_000) uploadTtlMs = DEFAULT_UPLOAD_TTL_MS;

  const reservationPathFor = (targetPath) =>
    path.join(storage.uploadReservationRoot, createHash("sha256").update(targetPath).digest("hex"));
  let reservationMutation = Promise.resolve();
  const serializeReservationMutation = (operation) => {
    const result = reservationMutation.then(operation, operation);
    reservationMutation = result.catch(() => {});
    return result;
  };

  const assertSafeName = (name, kind = "file") => {
    if (!safeFileName(name) || name === "." || name === "..") {
      throw fileError(`A valid ${kind} name is required.`, { code: "invalid_file_name", status: 400 });
    }
    return name;
  };

  const assertPublicPath = (value = "") => {
    const relative = storage.relativePath(value);
    if (relative === ".uploads" || relative.startsWith(`.uploads${path.sep}`)) {
      throw fileError("Internal upload storage is not available through Files.", {
        code: "content_not_found",
        status: 404
      });
    }
    return relative;
  };

  const safeExistingPath = async (value) => {
    try {
      return await storage.resolveExistingContentPath(assertPublicPath(value));
    } catch (error) {
      if (error.code === "ENOENT") {
        throw fileError("File or folder not found.", { code: "content_not_found", status: 404 });
      }
      throw error;
    }
  };

  const safeDestinationPath = (value) => storage.resolveContentDestination(assertPublicPath(value));

  const readCapacityReservations = async () => {
    const entries = await readdir(storage.uploadReservationRoot, { withFileTypes: true }).catch(() => []);
    const reservations = await mapLimit(
      entries.filter((entry) => entry.isDirectory()),
      8,
      async (entry) => readFile(path.join(storage.uploadReservationRoot, entry.name, "reservation.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null)
    );
    return reservations.filter((reservation) =>
      Number.isSafeInteger(reservation?.bytes) && reservation.bytes >= 0
    );
  };

  const assertUploadAdmission = async (size) => {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw fileError("Upload size is invalid.", { code: "invalid_upload_size", status: 400 });
    }
    if (size > maxUploadBytes) {
      throw fileError(`Upload exceeds the ${maxUploadBytes} byte limit.`, {
        code: "upload_too_large",
        status: 413
      });
    }
    const filesystem = await filesystemStats();
    const available = Number(filesystem.bavail) * Number(filesystem.bsize);
    const reserved = (await readCapacityReservations())
      .reduce((total, reservation) => total + reservation.bytes, 0);
    if (!Number.isFinite(available) || available - reserved - size < minimumFreeBytes) {
      throw fileError("There is not enough free storage for this upload.", {
        code: "insufficient_storage",
        status: 507
      });
    }
  };

  const reserveUpload = async ({ bytes, id, kind, targetPath }) =>
    serializeReservationMutation(async () => {
      await assertUploadAdmission(bytes);
      const reservationPath = reservationPathFor(targetPath);
      try {
        await mkdir(reservationPath);
      } catch (error) {
        if (error.code === "EEXIST") {
          throw fileError("An upload for that destination is already in progress.", {
            code: "upload_in_progress",
            status: 409
          });
        }
        throw error;
      }
      const reservation = {
        bytes,
        createdAt: new Date().toISOString(),
        id,
        kind,
        target: storage.toContentPath(targetPath)
      };
      try {
        await writeFile(
          path.join(reservationPath, "reservation.json"),
          JSON.stringify(reservation),
          { flag: "wx" }
        );
        await writeFile(path.join(reservationPath, "session-id"), id, { flag: "wx" });
      } catch (error) {
        await rm(reservationPath, { force: true, recursive: true }).catch(() => {});
        throw error;
      }
      return { name: path.basename(reservationPath), path: reservationPath };
    });

  const releaseUpload = (reservationPath) =>
    serializeReservationMutation(() => rm(reservationPath, { force: true, recursive: true }));

  const openRevalidatedFile = async (absolutePath, flags, mode) => {
    await storage.assertNoSymlinkSegments(
      flags & constants.O_CREAT ? path.dirname(absolutePath) : absolutePath
    );
    const handle = await open(absolutePath, flags | (constants.O_NOFOLLOW ?? 0), mode);
    try {
      await storage.assertNoSymlinkSegments(absolutePath);
      const [handleStats, pathStats] = await Promise.all([handle.stat(), lstat(absolutePath)]);
      if (handleStats.dev !== pathStats.dev || handleStats.ino !== pathStats.ino) {
        throw fileError("The content path changed during the operation.", {
          code: "unsafe_content_path",
          status: 409
        });
      }
      return { handle, stats: handleStats };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  };

  const writeAll = async (handle, chunk, position = null) => {
    let offset = 0;
    while (offset < chunk.length) {
      const result = await handle.write(
        chunk,
        offset,
        chunk.length - offset,
        position === null ? null : position + offset
      );
      if (result.bytesWritten <= 0) throw new Error("File write made no progress.");
      offset += result.bytesWritten;
    }
  };

  let cleanupPromise = null;
  let lastCleanupAt = 0;
  const cleanupStaleUploads = async ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && now - lastCleanupAt < Math.min(uploadTtlMs / 4, 60 * 60 * 1000)) return;
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const names = await readdir(storage.uploadRoot, { withFileTypes: true }).catch(() => []);
      await mapLimit(
        names.filter((entry) => entry.isDirectory() && entry.name !== ".reservations" && /^[a-f0-9-]{36}$/i.test(entry.name)),
        4,
        async (entry) => {
          const sessionPath = path.join(storage.uploadRoot, entry.name);
          const metadataPath = path.join(sessionPath, "metadata.json");
          const metadata = await readFile(metadataPath, "utf8").then(JSON.parse).catch(() => null);
          const updatedAt = Date.parse(metadata?.updatedAt ?? metadata?.createdAt ?? "");
          const sessionStats = await lstat(sessionPath).catch(() => null);
          const observedAt = Number.isFinite(updatedAt) ? updatedAt : sessionStats?.mtimeMs;
          if (!Number.isFinite(observedAt) || now - observedAt <= uploadTtlMs) return;
          await rm(sessionPath, { force: true, recursive: true });
          if (typeof metadata?.reservation === "string" && /^[a-f0-9]{64}$/i.test(metadata.reservation)) {
            await rm(path.join(storage.uploadReservationRoot, metadata.reservation), {
              force: true,
              recursive: true
            }).catch(() => {});
          }
        }
      );
      const reservations = await readdir(storage.uploadReservationRoot, { withFileTypes: true }).catch(() => []);
      await mapLimit(
        reservations.filter((entry) => entry.isDirectory()),
        4,
        async (entry) => {
          const reservationPath = path.join(storage.uploadReservationRoot, entry.name);
          const reservation = await readFile(path.join(reservationPath, "reservation.json"), "utf8")
            .then(JSON.parse)
            .catch(() => null);
          const createdAt = Date.parse(reservation?.createdAt ?? "");
          if (!Number.isFinite(createdAt) || now - createdAt <= uploadTtlMs) return;
          if (reservation?.kind === "resumable") {
            const sessionExists = await lstat(uploadSessionPath(reservation.id)).catch(() => null);
            if (sessionExists) return;
          }
          await rm(reservationPath, { force: true, recursive: true });
        }
      );
      lastCleanupAt = now;
    })().finally(() => { cleanupPromise = null; });
    return cleanupPromise;
  };

  const uploadSessionPath = (id) => {
    if (!/^[a-f0-9-]{36}$/i.test(id)) {
      throw fileError("Upload session not found.", { code: "upload_not_found", status: 404 });
    }

    return path.join(storage.uploadRoot, id);
  };

  const readUploadSession = async (id) => {
    const sessionPath = uploadSessionPath(id);
    const metadata = await readFile(path.join(sessionPath, "metadata.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT" || error instanceof SyntaxError) {
          throw fileError("Upload session not found.", { code: "upload_not_found", status: 404 });
        }
        throw error;
      });
    if (metadata?.id !== id || !safeFileName(metadata?.name) || !Number.isSafeInteger(metadata?.size)) {
      throw fileError("Upload session metadata is invalid.", { code: "invalid_upload_session", status: 409 });
    }
    return { metadata, sessionPath };
  };

  const uploadedParts = async (sessionPath) => {
    const chunksPath = path.join(sessionPath, "chunks");
    const names = await readdir(chunksPath).catch(() => []);
    const parts = await Promise.all(
      names
        .filter((name) => /^part-\d+$/.test(name))
        .map(async (name) => {
          const index = Number(name.replace("part-", ""));
          const partStats = await stat(path.join(chunksPath, name));
          return { index, size: partStats.size };
        })
    );

    return parts.sort((a, b) => a.index - b.index);
  };

  const entryType = (stats) => {
    if (stats.isDirectory()) {
      return "folder";
    }

    return "file";
  };

  const listDirectory = async (request, response, url) => {
    const requestedPath = url.searchParams.get("path") ?? "";
    const absolutePath = await safeExistingPath(requestedPath);
    const stats = await stat(absolutePath).catch(() => null);

    if (!stats || !stats.isDirectory()) {
      json(response, 404, { error: "Folder not found." });
      return;
    }

    const limit = Math.max(1, boundedInteger(url.searchParams.get("limit"), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
    const cursor = boundedInteger(url.searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER);
    const directoryEntries = (await readdir(absolutePath, { withFileTypes: true }))
      .filter((entry) =>
        entry.name !== ".uploads"
        && !entry.isSymbolicLink()
        && (entry.isDirectory() || entry.isFile())
      )
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    const page = directoryEntries.slice(cursor, cursor + limit);
    const entries = await mapLimit(page, STAT_CONCURRENCY, async (entry) => {
      const entryPath = path.join(absolutePath, entry.name);
      await storage.assertNoSymlinkSegments(entryPath);
      const entryStats = await lstat(entryPath);
      return {
        modifiedAt: entryStats.mtime.toISOString(),
        name: entry.name,
        path: storage.toContentPath(entryPath),
        size: entryStats.size,
        type: entryType(entryStats)
      };
    });
    const nextOffset = cursor + page.length;

    json(response, 200, {
      entries,
      ...(nextOffset < directoryEntries.length ? { nextCursor: String(nextOffset) } : {}),
      path: storage.toContentPath(absolutePath),
      total: directoryEntries.length
    });
  };

  const readContentFile = async (request, response, url) => {
    const requestedPath = url.searchParams.get("path") ?? "";
    const absolutePath = await safeExistingPath(requestedPath);
    const opened = await openRevalidatedFile(absolutePath, constants.O_RDONLY).catch((error) => {
      if (["ENOENT", "EISDIR"].includes(error.code)) return null;
      throw error;
    });
    const stats = opened?.stats;

    if (!stats || !stats.isFile()) {
      await opened?.handle.close().catch(() => {});
      json(response, 404, { error: "File not found." });
      return;
    }

    if (stats.size > 1024 * 1024) {
      await opened.handle.close();
      json(response, 413, { error: "Preview supports files up to 1 MB." });
      return;
    }

    const active = ACTIVE_PREVIEW_EXTENSIONS.has(path.extname(absolutePath).toLowerCase());
    response.writeHead(200, {
      "content-disposition": `inline; filename="${path.basename(absolutePath).replaceAll('"', "")}"`,
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": active ? "text/plain; charset=utf-8" : mimeType(absolutePath),
      "x-content-type-options": "nosniff"
    });
    try {
      response.end(await opened.handle.readFile());
    } finally {
      await opened.handle.close();
    }
  };

  const downloadContentFile = async (request, response, url) => {
    const requestedPath = url.searchParams.get("path") ?? "";
    const absolutePath = await safeExistingPath(requestedPath);
    const opened = await openRevalidatedFile(absolutePath, constants.O_RDONLY).catch((error) => {
      if (["ENOENT", "EISDIR"].includes(error.code)) return null;
      throw error;
    });
    const stats = opened?.stats;

    if (!stats || !stats.isFile()) {
      await opened?.handle.close().catch(() => {});
      json(response, 404, { error: "File not found." });
      return;
    }

    response.writeHead(200, {
      "content-disposition": `attachment; filename="${path.basename(absolutePath).replaceAll('"', "")}"`,
      "content-length": stats.size,
      "content-type": mimeType(absolutePath),
      "x-content-type-options": "nosniff"
    });
    try {
      await pipeline(opened.handle.createReadStream({ autoClose: false }), response);
    } finally {
      await opened.handle.close().catch(() => {});
    }
  };

  const createFolder = async (request, response) => {
    const body = await readBody(request);
    const name = assertSafeName(body.name ?? "", "folder");
    const absolutePath = await safeDestinationPath(path.join(body.path ?? "", name));
    await mkdir(absolutePath, { recursive: false });
    json(response, 201, { ok: true, path: storage.toContentPath(absolutePath) });
  };

  const createTextFile = async (request, response) => {
    const body = await readBody(request);
    const name = assertSafeName(body.name ?? "");
    const absolutePath = await safeDestinationPath(path.join(body.path ?? "", name));
    await writeFile(absolutePath, body.content ?? "", { flag: "wx" });
    json(response, 201, { ok: true, path: storage.toContentPath(absolutePath) });
  };

  const uploadFile = async (request, response) => {
    const body = await readBody(request);
    const name = assertSafeName(body.name ?? "");
    const content = Buffer.from(body.contentBase64 ?? "", "base64");
    const absolutePath = await safeDestinationPath(path.join(body.path ?? "", name));
    const id = randomUUID();
    const reservation = await reserveUpload({
      bytes: content.length,
      id,
      kind: "raw",
      targetPath: absolutePath
    });
    let handle;
    let created = false;
    let reservationReleased = false;
    try {
      ({ handle } = await openRevalidatedFile(
        absolutePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600
      ));
      created = true;
      await handle.writeFile(content);
      await handle.close();
      handle = null;
      await releaseUpload(reservation.path);
      reservationReleased = true;
      json(response, 201, { ok: true, path: storage.toContentPath(absolutePath) });
    } catch (error) {
      if (created) await rm(absolutePath, { force: true }).catch(() => {});
      throw error;
    } finally {
      await handle?.close().catch(() => {});
      if (!reservationReleased) await releaseUpload(reservation.path).catch(() => {});
    }
  };

  const uploadFileStream = async (request, response, url) => {
    const requestedPath = url.searchParams.get("path") ?? "";
    const name = url.searchParams.get("name") ?? "";

    assertSafeName(name);

    const absolutePath = await safeDestinationPath(path.join(requestedPath, name));
    const declaredLength = Number(request.headers["content-length"] ?? -1);
    const reservationBytes = Number.isSafeInteger(declaredLength) && declaredLength >= 0
      ? declaredLength
      : maxUploadBytes;
    const reservation = await reserveUpload({
      bytes: reservationBytes,
      id: randomUUID(),
      kind: "raw",
      targetPath: absolutePath
    });
    let opened;
    let created = false;
    let reservationReleased = false;

    try {
      opened = await openRevalidatedFile(
        absolutePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600
      );
      created = true;
      const uploadLimit = Math.min(maxUploadBytes, reservationBytes);
      let received = 0;
      for await (const chunk of request) {
        received += chunk.length;
        if (received > uploadLimit) {
          throw fileError("Upload exceeds the configured size limit.", {
            code: "upload_too_large",
            status: 413
          });
        }
        await writeAll(opened.handle, chunk);
      }
      await storage.assertNoSymlinkSegments(absolutePath);
      await opened.handle.close();
      opened = null;
      await releaseUpload(reservation.path);
      reservationReleased = true;

      json(response, 201, { ok: true, path: storage.toContentPath(absolutePath) });
    } catch (error) {
      await opened?.handle.close().catch(() => {});
      if (created) await rm(absolutePath, { force: true }).catch(() => {});

      if (request.aborted) {
        return;
      }

      throw error;
    } finally {
      await opened?.handle.close().catch(() => {});
      if (!reservationReleased) await releaseUpload(reservation.path).catch(() => {});
    }
  };

  const createUploadSession = async (request, response) => {
    await cleanupStaleUploads();
    const body = await readBody(request);
    const name = body.name ?? "";
    const requestedPath = body.path ?? "";
    const size = Number(body.size ?? 0);
    const chunkSize = Number(body.chunkSize ?? 0);

    assertSafeName(name);

    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      json(response, 400, { error: "Upload size and chunk size are required." });
      return;
    }
    const targetPath = await safeDestinationPath(path.join(requestedPath, name));
    const existing = await lstat(targetPath).catch(() => null);

    if (existing) {
      json(response, 409, { error: "A file with that name already exists." });
      return;
    }

    const id = randomUUID();
    const sessionPath = uploadSessionPath(id);
    const now = new Date().toISOString();
    let reservation;
    try {
      reservation = await reserveUpload({ bytes: size, id, kind: "resumable", targetPath });
    } catch (error) {
      if (error.code === "upload_in_progress") {
        json(response, 409, { error: error.message, code: error.code });
        return;
      }
      throw error;
    }
    const metadata = {
      chunkSize,
      createdAt: now,
      id,
      name,
      path: storage.relativePath(requestedPath),
      reservation: reservation.name,
      size,
      target: storage.toContentPath(targetPath),
      type: body.type ?? "",
      updatedAt: now
    };

    try {
      await mkdir(path.join(sessionPath, "chunks"), { recursive: true });
      await writeFile(path.join(sessionPath, "metadata.json"), JSON.stringify(metadata, null, 2));
    } catch (error) {
      await rm(sessionPath, { force: true, recursive: true }).catch(() => {});
      await releaseUpload(reservation.path).catch(() => {});
      throw error;
    }
    json(response, 201, { ...metadata, uploadedParts: [] });
  };

  const getUploadSession = async (request, response, id) => {
    const { metadata, sessionPath } = await readUploadSession(id);
    json(response, 200, { ...metadata, uploadedParts: await uploadedParts(sessionPath) });
  };

  const uploadChunk = async (request, response, id, partIndex) => {
    const index = Number(partIndex);

    if (!Number.isSafeInteger(index) || index < 0) {
      json(response, 400, { error: "Chunk index is invalid." });
      return;
    }

    const { metadata, sessionPath } = await readUploadSession(id);
    const partCount = Math.ceil(metadata.size / metadata.chunkSize);

    if (index >= partCount) {
      json(response, 400, { error: `Chunk index must be less than ${partCount}.` });
      return;
    }

    const chunksPath = path.join(sessionPath, "chunks");
    const partPath = path.join(chunksPath, `part-${String(index).padStart(8, "0")}`);
    const tempPath = `${partPath}.tmp-${randomUUID()}`;
    const expectedSize =
      index === Math.ceil(metadata.size / metadata.chunkSize) - 1
        ? metadata.size - metadata.chunkSize * index
        : metadata.chunkSize;

    try {
      await pipeline(
        request,
        byteLimitTransform(expectedSize, "Chunk exceeds the expected size."),
        createWriteStream(tempPath, { flags: "wx" })
      );
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }

    const partStats = await stat(tempPath);

    if (expectedSize > maxUploadBytes) {
      await rm(tempPath, { force: true });
      throw fileError("Upload chunk exceeds the configured size limit.", {
        code: "upload_too_large",
        status: 413
      });
    }

    if (partStats.size !== expectedSize) {
      await rm(tempPath, { force: true });
      json(response, 400, { error: "Chunk size does not match upload metadata." });
      return;
    }

    await rename(tempPath, partPath);
    metadata.updatedAt = new Date().toISOString();
    await writeFile(path.join(sessionPath, "metadata.json"), JSON.stringify(metadata, null, 2));
    json(response, 200, { ok: true, part: { index, size: partStats.size } });
  };

  const completeUploadSession = async (request, response, id) => {
    const { metadata, sessionPath } = await readUploadSession(id);
    const chunksPath = path.join(sessionPath, "chunks");
    await assertUploadAdmission(0);
    const targetPath = await safeDestinationPath(metadata.target);
    const partCount = Math.ceil(metadata.size / metadata.chunkSize);
    const tempTarget = `${targetPath}.uploading-${id}-${randomUUID()}`;
    let outputHandle;
    let outputPosition = 0;
    let targetLinked = false;

    try {
      ({ handle: outputHandle } = await openRevalidatedFile(
        tempTarget,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600
      ));
      for (let index = 0; index < partCount; index += 1) {
        const partPath = path.join(chunksPath, `part-${String(index).padStart(8, "0")}`);
        const partStats = await stat(partPath).catch(() => null);

        if (!partStats) {
          throw Object.assign(new Error(`Missing chunk ${index + 1} of ${partCount}.`), { status: 409 });
        }

        for await (const chunk of createReadStream(partPath)) {
          await writeAll(outputHandle, chunk, outputPosition);
          outputPosition += chunk.length;
        }
      }

      const finalStats = await outputHandle.stat();

      if (finalStats.size !== metadata.size) {
        throw Object.assign(new Error("Completed file size does not match upload metadata."), { status: 409 });
      }

      await outputHandle.close();
      outputHandle = null;
      await storage.assertNoSymlinkSegments(path.dirname(targetPath));
      try {
        await link(tempTarget, targetPath);
        targetLinked = true;
      } catch (error) {
        if (error.code === "EEXIST") {
          throw Object.assign(new Error("A file with that name now exists."), { status: 409 });
        }
        throw error;
      }
      await storage.assertNoSymlinkSegments(targetPath);
      const [tempStats, targetStats] = await Promise.all([lstat(tempTarget), lstat(targetPath)]);
      if (
        targetStats.isSymbolicLink()
        || tempStats.dev !== targetStats.dev
        || tempStats.ino !== targetStats.ino
      ) {
        throw fileError("The content path changed during upload completion.", {
          code: "unsafe_content_path",
          status: 409
        });
      }

      await rm(tempTarget, { force: true });
      await rm(sessionPath, { force: true, recursive: true });
      await releaseUpload(path.join(storage.uploadReservationRoot, metadata.reservation));
      json(response, 201, { ok: true, path: storage.toContentPath(targetPath) });
    } catch (error) {
      await outputHandle?.close().catch(() => {});
      if (targetLinked) {
        const [tempStats, targetStats] = await Promise.all([
          lstat(tempTarget).catch(() => null),
          lstat(targetPath).catch(() => null)
        ]);
        if (
          tempStats
          && targetStats
          && !targetStats.isSymbolicLink()
          && tempStats.dev === targetStats.dev
          && tempStats.ino === targetStats.ino
        ) {
          await rm(targetPath, { force: true }).catch(() => {});
        }
      }
      await rm(tempTarget, { force: true }).catch(() => {});
      throw error;
    }
  };

  const cancelUploadSession = async (request, response, id) => {
    const { metadata, sessionPath } = await readUploadSession(id);
    await rm(sessionPath, { force: true, recursive: true });
    if (metadata.reservation) {
      await releaseUpload(path.join(storage.uploadReservationRoot, metadata.reservation));
    }
    json(response, 200, { ok: true });
  };

  const renameEntry = async (request, response) => {
    const body = await readBody(request);
    const name = assertSafeName(body.name ?? "");
    const from = await safeExistingPath(body.path ?? "");
    if (from === storage.contentRoot) {
      throw fileError("Cannot rename content root.", { code: "content_root_protected", status: 400 });
    }
    const to = await safeDestinationPath(path.join(path.dirname(body.path ?? ""), name));
    await rename(from, to);
    await storage.assertNoSymlinkSegments(to);
    json(response, 200, { ok: true, path: storage.toContentPath(to) });
  };

  const deleteEntry = async (request, response, url) => {
    const absolutePath = await safeExistingPath(url.searchParams.get("path") ?? "");

    if (absolutePath === storage.contentRoot) {
      throw fileError("Cannot delete content root.", { code: "content_root_protected", status: 400 });
    }

    await rm(absolutePath, { force: false, recursive: true });
    json(response, 200, { ok: true });
  };

  const handle = async (request, response, url) => {
    if (request.method === "GET" && url.pathname === "/api/files") {
      await listDirectory(request, response, url);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/files/read") {
      await readContentFile(request, response, url);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/files/download") {
      await downloadContentFile(request, response, url);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/files/folder") {
      await createFolder(request, response);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/files/text") {
      await createTextFile(request, response);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/files/upload") {
      await uploadFile(request, response);
      return true;
    }

    if (request.method === "PUT" && url.pathname === "/api/files/upload") {
      await uploadFileStream(request, response, url);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/files/uploads") {
      await createUploadSession(request, response);
      return true;
    }

    const uploadMatch = url.pathname.match(/^\/api\/files\/uploads\/([^/]+)(?:\/chunks\/([^/]+)|\/complete)?$/);

    if (uploadMatch) {
      const [, id, partIndex] = uploadMatch;

      if (request.method === "GET" && partIndex === undefined && !url.pathname.endsWith("/complete")) {
        await getUploadSession(request, response, id);
        return true;
      }

      if (request.method === "PUT" && partIndex !== undefined) {
        await uploadChunk(request, response, id, partIndex);
        return true;
      }

      if (request.method === "POST" && url.pathname.endsWith("/complete")) {
        await completeUploadSession(request, response, id);
        return true;
      }

      if (request.method === "DELETE" && partIndex === undefined && !url.pathname.endsWith("/complete")) {
        await cancelUploadSession(request, response, id);
        return true;
      }
    }

    if (request.method === "POST" && url.pathname === "/api/files/rename") {
      await renameEntry(request, response);
      return true;
    }

    if (request.method === "DELETE" && url.pathname === "/api/files") {
      await deleteEntry(request, response, url);
      return true;
    }

    return false;
  };

  return async (request, response, url) => {
    try {
      return await handle(request, response, url);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw fileError("File or folder not found.", { code: "content_not_found", status: 404 });
      }
      if (error?.code === "EEXIST") {
        throw fileError("A file or folder with that name already exists.", {
          code: "content_exists",
          status: 409
        });
      }
      if (["EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(error?.code)) {
        throw fileError("The requested file operation is not permitted.", {
          code: "content_operation_denied",
          status: 400
        });
      }
      throw error;
    }
  };
};
