import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseByteRange } from "../ranges.mjs";

export const DEFAULT_PARTY_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_PARTY_CONVERSATION_QUOTA_BYTES = 250 * 1024 * 1024;

const DEFAULT_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const DEFAULT_MAX_TEMP_CLEANUP_ENTRIES = 1_000;
const HEAD_BYTES = 8 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f-]{36}\.blob$/i;
const TEMP_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.upload$/i;

const ALLOWED_MIME_TYPES = new Set([
  "application/gzip",
  "application/json",
  "application/octet-stream",
  "application/ogg",
  "application/pdf",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/x-tar",
  "application/zip",
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
  "video/mp4",
  "video/mpeg",
  "video/ogg",
  "video/quicktime",
  "video/webm",
  "video/x-matroska"
]);

const ACTIVE_MIME_TYPES = new Set([
  "application/javascript",
  "application/xhtml+xml",
  "application/xml",
  "image/svg+xml",
  "text/html",
  "text/javascript",
  "text/xml"
]);

const INLINE_MIME_TYPES = new Set([
  "application/pdf",
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "video/mp4",
  "video/mpeg",
  "video/ogg",
  "video/quicktime",
  "video/webm",
  "video/x-matroska"
]);

const MAGIC_REQUIRED = new Set([
  "application/gzip",
  "application/pdf",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/zip",
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "video/mp4",
  "video/mpeg",
  "video/ogg",
  "video/quicktime",
  "video/webm",
  "video/x-matroska"
]);

const errorWithStatus = (status, message, code) =>
  Object.assign(new Error(message), { code, status });

const normalizeMimeType = (value) => {
  const normalized = String(value ?? "application/octet-stream")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return normalized || "application/octet-stream";
};

export const sanitizePartyAttachmentName = (value) => {
  const input = String(value ?? "");
  if (/^[.\s/\\]+$/.test(input)) return "attachment";
  const normalized = input
    .normalize("NFKC")
    .replaceAll(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .replaceAll(/[\\/]/g, "_")
    .replaceAll(/[<>:"|?*]/g, "_")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/^\.+|\.+$/g, "")
    .trim();
  const bounded = Array.from(normalized).slice(0, 180).join("");
  return bounded || "attachment";
};

const startsWithBytes = (buffer, bytes, offset = 0) =>
  buffer.length >= offset + bytes.length &&
  bytes.every((value, index) => buffer[offset + index] === value);

const asciiAt = (buffer, offset, length) =>
  buffer.length >= offset + length ? buffer.subarray(offset, offset + length).toString("ascii") : "";

const detectMagic = (buffer) => {
  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mimeType: "image/png" };
  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) return { mimeType: "image/jpeg" };
  if (asciiAt(buffer, 0, 6) === "GIF87a" || asciiAt(buffer, 0, 6) === "GIF89a") return { mimeType: "image/gif" };
  if (asciiAt(buffer, 0, 4) === "RIFF" && asciiAt(buffer, 8, 4) === "WEBP") return { mimeType: "image/webp" };
  if (asciiAt(buffer, 0, 4) === "RIFF" && asciiAt(buffer, 8, 4) === "WAVE") return { mimeType: "audio/wav" };
  if (asciiAt(buffer, 0, 4) === "%PDF") return { mimeType: "application/pdf" };
  if (asciiAt(buffer, 0, 4) === "fLaC") return { mimeType: "audio/flac" };
  if (asciiAt(buffer, 0, 4) === "OggS") return { family: "ogg", mimeType: "application/ogg" };
  if (startsWithBytes(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return { family: "ebml", mimeType: "video/webm" };
  if (startsWithBytes(buffer, [0x1f, 0x8b])) return { mimeType: "application/gzip" };
  if (
    startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWithBytes(buffer, [0x50, 0x4b, 0x07, 0x08])
  ) return { mimeType: "application/zip" };
  if (startsWithBytes(buffer, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { mimeType: "application/x-7z-compressed" };
  if (startsWithBytes(buffer, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return { family: "rar", mimeType: "application/vnd.rar" };
  if (asciiAt(buffer, 0, 3) === "ID3" || (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe6) === 0xe2)) {
    return { mimeType: "audio/mpeg" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0) return { mimeType: "audio/aac" };
  if (startsWithBytes(buffer, [0x00, 0x00, 0x01, 0xba]) || startsWithBytes(buffer, [0x00, 0x00, 0x01, 0xb3])) {
    return { mimeType: "video/mpeg" };
  }
  if (asciiAt(buffer, 0, 2) === "BM") return { mimeType: "image/bmp" };
  if (
    startsWithBytes(buffer, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWithBytes(buffer, [0x4d, 0x4d, 0x00, 0x2a])
  ) return { mimeType: "image/tiff" };
  if (asciiAt(buffer, 4, 4) === "ftyp") {
    const brand = asciiAt(buffer, 8, 4).toLowerCase();
    if (brand === "avif" || brand === "avis") return { mimeType: "image/avif" };
    return { family: "iso-bmff", mimeType: "video/mp4" };
  }

  const trimmed = buffer.toString("utf8").replace(/^\ufeff?\s*/, "").toLowerCase();
  if (
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<script") ||
    trimmed.startsWith("<svg") ||
    trimmed.startsWith("<?xml")
  ) return { active: true, mimeType: "text/html" };
  if (startsWithBytes(buffer, [0x4d, 0x5a]) || startsWithBytes(buffer, [0x7f, 0x45, 0x4c, 0x46])) {
    return { active: true, mimeType: "application/x-executable" };
  }
  return null;
};

const compatibleMagic = (declaredMimeType, detected) => {
  if (!detected) return !MAGIC_REQUIRED.has(declaredMimeType);
  if (detected.active) return false;
  if (declaredMimeType === "application/octet-stream") return true;
  if (detected.family === "iso-bmff") {
    return new Set(["audio/mp4", "video/mp4", "video/quicktime"]).has(declaredMimeType);
  }
  if (detected.family === "ebml") {
    return new Set(["audio/webm", "video/webm", "video/x-matroska"]).has(declaredMimeType);
  }
  if (detected.family === "ogg") {
    return new Set(["application/ogg", "audio/ogg", "video/ogg"]).has(declaredMimeType);
  }
  if (detected.family === "rar") {
    return new Set(["application/vnd.rar", "application/x-rar-compressed"]).has(declaredMimeType);
  }
  return detected.mimeType === declaredMimeType;
};

const validatedMimeType = (declaredMimeType, head) => {
  if (ACTIVE_MIME_TYPES.has(declaredMimeType) || !ALLOWED_MIME_TYPES.has(declaredMimeType)) {
    throw errorWithStatus(415, "This attachment content type is not allowed.", "PARTY_ATTACHMENT_TYPE_DENIED");
  }
  const detected = detectMagic(head);
  if (!compatibleMagic(declaredMimeType, detected)) {
    throw errorWithStatus(415, "Attachment content does not match its declared type.", "PARTY_ATTACHMENT_MIME_MISMATCH");
  }
  if (declaredMimeType.startsWith("text/") && head.includes(0)) {
    throw errorWithStatus(415, "Text attachments must contain valid UTF-8 text.", "PARTY_ATTACHMENT_TEXT_INVALID");
  }
  if (!detected || detected.family) return declaredMimeType;
  return detected.mimeType;
};

const contentLengthFor = (request, maxFileBytes) => {
  const raw = request?.headers?.["content-length"];
  if (Array.isArray(raw) || typeof raw !== "string" || !/^(0|[1-9]\d*)$/.test(raw)) {
    throw errorWithStatus(411, "A valid Content-Length header is required.", "PARTY_ATTACHMENT_LENGTH_REQUIRED");
  }
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw errorWithStatus(400, "Attachment content must not be empty.", "PARTY_ATTACHMENT_EMPTY");
  }
  if (size > maxFileBytes) {
    throw errorWithStatus(413, `Attachments are limited to ${maxFileBytes} bytes.`, "PARTY_ATTACHMENT_TOO_LARGE");
  }
  if (request.headers["transfer-encoding"]) {
    throw errorWithStatus(400, "Chunked attachment uploads are not accepted.", "PARTY_ATTACHMENT_CHUNKED");
  }
  return size;
};

const normalizedAttachment = (row) => row && ({
  conversationId: row.conversationId ?? row.conversation_id,
  createdAt: row.createdAt ?? row.created_at,
  displayName: row.displayName ?? row.display_name,
  id: row.id,
  messageId: row.messageId ?? row.message_id,
  mimeType: row.mimeType ?? row.mime_type,
  sha256: row.sha256,
  sizeBytes: row.sizeBytes ?? row.size_bytes,
  storageKey: row.storageKey ?? row.storage_key,
  uploaderUserId: row.uploaderUserId ?? row.uploader_user_id
});

const safeDisposition = (kind, displayName) => {
  const safeName = sanitizePartyAttachmentName(displayName);
  const fallback = safeName.replaceAll(/[^\x20-\x7e]/g, "_").replaceAll(/["\\]/g, "_");
  const encoded = encodeURIComponent(safeName).replaceAll(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

const isContained = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
};

const createMeter = (declaredBytes, { validateUtf8 = false } = {}) => {
  let size = 0;
  const hash = createHash("sha256");
  const head = [];
  let headBytes = 0;
  const decoder = validateUtf8 ? new TextDecoder("utf-8", { fatal: true }) : null;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > declaredBytes) {
        callback(errorWithStatus(400, "Attachment body exceeds Content-Length.", "PARTY_ATTACHMENT_LENGTH_MISMATCH"));
        return;
      }
      if (decoder) {
        try {
          decoder.decode(bytes, { stream: true });
        } catch {
          callback(errorWithStatus(415, "Text attachments must contain valid UTF-8 text.", "PARTY_ATTACHMENT_TEXT_INVALID"));
          return;
        }
      }
      hash.update(bytes);
      if (headBytes < HEAD_BYTES) {
        const portion = bytes.subarray(0, HEAD_BYTES - headBytes);
        head.push(portion);
        headBytes += portion.length;
      }
      callback(null, bytes);
    },
    flush(callback) {
      if (decoder) {
        try {
          decoder.decode();
        } catch {
          callback(errorWithStatus(415, "Text attachments must contain valid UTF-8 text.", "PARTY_ATTACHMENT_TEXT_INVALID"));
          return;
        }
      }
      callback();
    }
  });
  return {
    digest: () => hash.digest("hex"),
    head: () => Buffer.concat(head),
    size: () => size,
    stream
  };
};

export const createPartyAttachmentService = ({
  dataRoot,
  isConversationMember,
  getConversationAttachmentBytes,
  getAttachment,
  maxFileBytes = DEFAULT_PARTY_ATTACHMENT_MAX_BYTES,
  conversationQuotaBytes = DEFAULT_PARTY_CONVERSATION_QUOTA_BYTES,
  tempMaxAgeMs = DEFAULT_TEMP_MAX_AGE_MS,
  maxTempCleanupEntries = DEFAULT_MAX_TEMP_CLEANUP_ENTRIES,
  now = () => new Date(),
  uuid = randomUUID
} = {}) => {
  if (!path.isAbsolute(dataRoot ?? "")) throw new TypeError("dataRoot must be an absolute path.");
  for (const [name, callback] of Object.entries({
    getAttachment,
    getConversationAttachmentBytes,
    isConversationMember
  })) {
    if (typeof callback !== "function") throw new TypeError(`${name} must be a function.`);
  }
  for (const [name, value] of Object.entries({ conversationQuotaBytes, maxFileBytes, maxTempCleanupEntries, tempMaxAgeMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer.`);
  }

  const attachmentRoot = path.resolve(dataRoot, "party-attachments");
  const tempRoot = path.join(attachmentRoot, ".tmp");
  const conversationLocks = new Map();

  const resolveStorageKey = (storageKey) => {
    if (typeof storageKey !== "string" || !STORAGE_KEY_PATTERN.test(storageKey) || storageKey.includes("\\")) {
      throw errorWithStatus(404, "Attachment not found.", "PARTY_ATTACHMENT_NOT_FOUND");
    }
    const candidate = path.resolve(attachmentRoot, ...storageKey.split("/"));
    if (!isContained(attachmentRoot, candidate)) {
      throw errorWithStatus(404, "Attachment not found.", "PARTY_ATTACHMENT_NOT_FOUND");
    }
    return candidate;
  };

  const ensureMember = async (conversationId, userId, { conceal = false } = {}) => {
    let allowed = false;
    try {
      allowed = await isConversationMember({ conversationId, userId });
    } catch (error) {
      if (!conceal) throw error;
    }
    if (allowed !== true) {
      throw errorWithStatus(
        conceal ? 404 : 403,
        conceal ? "Attachment not found." : "Conversation membership is required.",
        conceal ? "PARTY_ATTACHMENT_NOT_FOUND" : "PARTY_MEMBERSHIP_REQUIRED"
      );
    }
  };

  const withConversationLock = async (conversationId, operation) => {
    const prior = conversationLocks.get(conversationId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = prior.then(() => gate);
    conversationLocks.set(conversationId, queued);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (conversationLocks.get(conversationId) === queued) conversationLocks.delete(conversationId);
    }
  };

  const cleanupTemporaryUploads = async () => {
    await mkdir(tempRoot, { mode: 0o700, recursive: true });
    await chmod(attachmentRoot, 0o700).catch(() => {});
    await chmod(tempRoot, 0o700).catch(() => {});
    const entries = await readdir(tempRoot, { withFileTypes: true });
    let inspected = 0;
    let removed = 0;
    const cutoff = new Date(now()).getTime() - tempMaxAgeMs;
    for (const entry of entries) {
      if (inspected >= maxTempCleanupEntries) break;
      inspected += 1;
      if (!entry.isFile() || !TEMP_NAME_PATTERN.test(entry.name)) continue;
      const candidate = path.join(tempRoot, entry.name);
      const details = await lstat(candidate).catch(() => null);
      if (details?.isFile() && details.mtimeMs <= cutoff) {
        await rm(candidate, { force: true });
        removed += 1;
      }
    }
    return { hasMore: entries.length > inspected, inspected, removed };
  };

  const initialize = async () => {
    const { inspected, removed } = await cleanupTemporaryUploads();
    return { inspected, removed };
  };

  const removeStorageKeys = async (storageKeys = []) => {
    if (!Array.isArray(storageKeys) || storageKeys.length > 10_000) {
      throw new TypeError("storageKeys must be a bounded array.");
    }
    let removed = 0;
    let missing = 0;
    for (const storageKey of storageKeys) {
      const candidate = resolveStorageKey(storageKey);
      const details = await lstat(candidate).catch(() => null);
      if (!details) {
        missing += 1;
        continue;
      }
      if (!details.isFile() || details.isSymbolicLink()) continue;
      await rm(candidate, { force: true });
      removed += 1;
    }
    return { missing, removed };
  };

  const upload = async ({
    request,
    conversationId,
    userId,
    displayName,
    declaredMimeType,
    clientMessageId = null,
    commit
  } = {}) => {
    if (!request || typeof request.pipe !== "function") throw new TypeError("request must be a readable stream.");
    if (typeof conversationId !== "string" || !conversationId || conversationId.length > 128) {
      throw errorWithStatus(400, "Conversation id is invalid.", "PARTY_CONVERSATION_INVALID");
    }
    if (typeof userId !== "string" || !userId || userId.length > 128) {
      throw errorWithStatus(401, "An account identity is required.", "PARTY_IDENTITY_REQUIRED");
    }
    if (typeof commit !== "function") throw new TypeError("commit must be a function.");

    const rejectWithoutReading = (error) => {
      request.resume?.();
      throw error;
    };
    await ensureMember(conversationId, userId).catch(rejectWithoutReading);
    let declaredBytes;
    try {
      declaredBytes = contentLengthFor(request, maxFileBytes);
    } catch (error) {
      rejectWithoutReading(error);
    }
    const normalizedDeclaredMime = normalizeMimeType(declaredMimeType ?? request.headers["content-type"]);
    if (ACTIVE_MIME_TYPES.has(normalizedDeclaredMime) || !ALLOWED_MIME_TYPES.has(normalizedDeclaredMime)) {
      rejectWithoutReading(errorWithStatus(415, "This attachment content type is not allowed.", "PARTY_ATTACHMENT_TYPE_DENIED"));
    }
    const safeName = sanitizePartyAttachmentName(displayName);

    return withConversationLock(conversationId, async () => {
      await ensureMember(conversationId, userId);
      const initialUsage = Number(await getConversationAttachmentBytes({ conversationId }));
      if (!Number.isSafeInteger(initialUsage) || initialUsage < 0) {
        throw errorWithStatus(500, "Attachment quota state is invalid.", "PARTY_ATTACHMENT_QUOTA_INVALID");
      }
      if (initialUsage + declaredBytes > conversationQuotaBytes) {
        request.resume?.();
        throw errorWithStatus(413, "This conversation has reached its attachment quota.", "PARTY_ATTACHMENT_QUOTA_EXCEEDED");
      }

      await mkdir(tempRoot, { mode: 0o700, recursive: true });
      const temporaryName = `${uuid()}.upload`;
      if (!TEMP_NAME_PATTERN.test(temporaryName)) throw new TypeError("uuid must return a UUID.");
      const temporaryPath = path.join(tempRoot, temporaryName);
      const meter = createMeter(declaredBytes, { validateUtf8: normalizedDeclaredMime.startsWith("text/") });
      let publishedPath = null;

      try {
        await pipeline(request, meter.stream, createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }));
        if (meter.size() !== declaredBytes) {
          throw errorWithStatus(400, "Attachment body does not match Content-Length.", "PARTY_ATTACHMENT_LENGTH_MISMATCH");
        }
        const mimeType = validatedMimeType(normalizedDeclaredMime, meter.head());
        await ensureMember(conversationId, userId);
        const currentUsage = Number(await getConversationAttachmentBytes({ conversationId }));
        if (!Number.isSafeInteger(currentUsage) || currentUsage < 0) {
          throw errorWithStatus(500, "Attachment quota state is invalid.", "PARTY_ATTACHMENT_QUOTA_INVALID");
        }
        if (currentUsage + declaredBytes > conversationQuotaBytes) {
          throw errorWithStatus(413, "This conversation has reached its attachment quota.", "PARTY_ATTACHMENT_QUOTA_EXCEEDED");
        }

        const attachmentId = uuid();
        if (!UUID_PATTERN.test(attachmentId)) throw new TypeError("uuid must return a UUID.");
        const lowerId = attachmentId.toLowerCase();
        const storageKey = `${lowerId.slice(0, 2)}/${lowerId.slice(2, 4)}/${lowerId}.blob`;
        const publicationPath = resolveStorageKey(storageKey);
        await mkdir(path.dirname(publicationPath), { mode: 0o700, recursive: true });
        try {
          await link(temporaryPath, publicationPath);
        } catch (error) {
          if (error?.code === "EEXIST") {
            throw errorWithStatus(409, "Attachment storage identity already exists.", "PARTY_ATTACHMENT_ID_CONFLICT");
          }
          throw error;
        }
        publishedPath = publicationPath;
        await rm(temporaryPath, { force: true });
        await chmod(publishedPath, 0o600).catch(() => {});

        await ensureMember(conversationId, userId);
        const timestamp = new Date(now()).toISOString();
        const metadata = {
          id: lowerId,
          conversationId,
          uploaderUserId: userId,
          storageKey,
          displayName: safeName,
          mimeType,
          sizeBytes: declaredBytes,
          sha256: meter.digest(),
          createdAt: timestamp
        };
        const result = await commit(metadata, {
          clientMessageId,
          conversationQuotaBytes
        });
        publishedPath = null;
        return result;
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        if (publishedPath) await rm(publishedPath, { force: true }).catch(() => {});
        if (request.aborted && !error.status) {
          throw errorWithStatus(400, "Attachment upload was cancelled.", "PARTY_ATTACHMENT_ABORTED");
        }
        throw error;
      }
    });
  };

  const serve = async ({
    request,
    response,
    attachmentId,
    userId,
    download = false
  } = {}) => {
    if (!request || !response) throw new TypeError("request and response are required.");
    if (!new Set(["GET", "HEAD"]).has(request.method)) {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }
    if (typeof attachmentId !== "string" || !UUID_PATTERN.test(attachmentId)) {
      throw errorWithStatus(404, "Attachment not found.", "PARTY_ATTACHMENT_NOT_FOUND");
    }
    const attachment = normalizedAttachment(await getAttachment({ attachmentId }));
    if (!attachment?.conversationId) {
      throw errorWithStatus(404, "Attachment not found.", "PARTY_ATTACHMENT_NOT_FOUND");
    }
    await ensureMember(attachment.conversationId, userId, { conceal: true });
    const filePath = resolveStorageKey(attachment.storageKey);
    const details = await lstat(filePath).catch(() => null);
    if (
      !details?.isFile() ||
      details.isSymbolicLink() ||
      !Number.isSafeInteger(attachment.sizeBytes) ||
      attachment.sizeBytes <= 0 ||
      details.size !== attachment.sizeBytes
    ) {
      throw errorWithStatus(404, "Attachment not found.", "PARTY_ATTACHMENT_NOT_FOUND");
    }
    const [realRoot, realFile] = await Promise.all([realpath(attachmentRoot), realpath(filePath)]);
    if (!isContained(realRoot, realFile)) {
      throw errorWithStatus(404, "Attachment not found.", "PARTY_ATTACHMENT_NOT_FOUND");
    }
    const mimeType = normalizeMimeType(attachment.mimeType);
    if (!ALLOWED_MIME_TYPES.has(mimeType) || ACTIVE_MIME_TYPES.has(mimeType)) {
      throw errorWithStatus(404, "Attachment not found.", "PARTY_ATTACHMENT_NOT_FOUND");
    }
    const dispositionKind = download || !INLINE_MIME_TYPES.has(mimeType) ? "attachment" : "inline";
    const headers = {
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-disposition": safeDisposition(dispositionKind, attachment.displayName),
      "content-type": mimeType,
      "x-content-type-options": "nosniff"
    };
    if (mimeType === "application/pdf") headers["content-security-policy"] = "sandbox";

    const rangeHeader = request.headers.range;
    let start = 0;
    let end = details.size - 1;
    let status = 200;
    if (rangeHeader !== undefined) {
      const parsed = parseByteRange(rangeHeader, details.size);
      if (!parsed.ok) {
        response.writeHead(416, { ...headers, "content-range": parsed.contentRange, "content-length": 0 });
        response.end();
        return;
      }
      ({ start, end } = parsed);
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${details.size}`;
    }
    headers["content-length"] = end - start + 1;
    response.writeHead(status, headers);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    try {
      await pipeline(createReadStream(filePath, { start, end }), response);
    } catch (error) {
      if (!response.destroyed) response.destroy(error);
    }
  };

  return {
    attachmentRoot,
    cleanupTemporaryUploads,
    conversationQuotaBytes,
    initialize,
    maxFileBytes,
    removeStorageKeys,
    resolveStorageKey,
    sanitizeDisplayName: sanitizePartyAttachmentName,
    serve,
    tempRoot,
    upload
  };
};
