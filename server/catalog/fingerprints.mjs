import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolveProbePath } from "../probe/path.mjs";

const error = (code, message, retryable = false) => Object.assign(new Error(message), { code, retryable });

export const createFingerprintRepository = (database, { now = () => new Date().toISOString() } = {}) => {
  const get = (sourceId) => {
    const row = database.prepare("SELECT * FROM media_source_fingerprints WHERE source_id = ?").get(sourceId);
    return row ? {
      algorithm: row.algorithm, algorithmVersion: row.algorithm_version, byteLength: row.byte_length,
      digest: row.digest, errorCode: row.error_code, fingerprintedAt: row.fingerprinted_at,
      sourceId: row.source_id, sourceRevision: row.source_revision, state: row.state, updatedAt: row.updated_at
    } : null;
  };
  const write = ({ byteLength, digest, sourceId, sourceRevision }) => {
    const timestamp = now();
    const result = database.prepare(`UPDATE media_source_fingerprints SET digest = ?, byte_length = ?, state = 'ready',
      fingerprinted_at = ?, error_code = NULL, updated_at = ? WHERE source_id = ? AND source_revision = ?
      AND EXISTS (SELECT 1 FROM media_sources WHERE id = ? AND content_revision = ? AND size_bytes = ?)`)
      .run(digest, byteLength, timestamp, timestamp, sourceId, sourceRevision, sourceId, sourceRevision, byteLength);
    if (result.changes !== 1) throw error("stale_source_revision", "The source changed while its fingerprint was being calculated.", true);
    return get(sourceId);
  };
  const fail = ({ errorCode, sourceId, sourceRevision }) => {
    database.prepare(`UPDATE media_source_fingerprints SET digest = NULL, state = 'failed', fingerprinted_at = NULL,
      error_code = ?, updated_at = ? WHERE source_id = ? AND source_revision = ?`)
      .run(String(errorCode).slice(0, 64), now(), sourceId, sourceRevision);
    return get(sourceId);
  };
  const pending = () => database.prepare(`SELECT f.source_id AS sourceId, f.source_revision AS sourceRevision
    FROM media_source_fingerprints f JOIN media_sources s ON s.id = f.source_id
    WHERE f.state != 'ready' AND s.availability = 'available' ORDER BY f.updated_at, f.source_id`).all();
  return { fail, get, pending, write };
};

export const createFingerprintService = ({
  contentRoot, repository, resolveSource, createStream = createReadStream,
  resolvePath = resolveProbePath, statFile = stat
} = {}) => {
  if (!contentRoot) throw new TypeError("contentRoot is required.");
  if (typeof resolveSource !== "function") throw new TypeError("resolveSource must be a function.");
  if (typeof repository?.write !== "function") throw new TypeError("A fingerprint repository is required.");

  return {
    async fingerprintSource(sourceId, context = {}) {
      const source = await resolveSource(sourceId);
      if (!source || source.availability !== "available") throw error("missing", "The catalog source is unavailable.", true);
      const sourceRevision = source.contentRevision;
      const absolutePath = await resolvePath(contentRoot, source.path);
      const before = await statFile(absolutePath);
      if (!before.isFile() || before.size !== source.size) throw error("stale_source_revision", "The source changed before fingerprinting began.", true);
      const hash = createHash("sha256");
      let consumed = 0;
      try {
        for await (const chunk of createStream(absolutePath, { highWaterMark: 1024 * 1024 })) {
          context.throwIfCancelled?.();
          consumed += chunk.length;
          hash.update(chunk);
          if (source.size > 0) context.reportProgress?.(Math.min(0.99, consumed / source.size), "fingerprinting");
        }
        const after = await statFile(absolutePath);
        if (consumed !== source.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          throw error("stale_source_revision", "The source changed while fingerprinting.", true);
        }
        const result = repository.write({ byteLength: consumed, digest: hash.digest("hex"), sourceId, sourceRevision });
        context.reportProgress?.(1, "fingerprinted");
        return result;
      } catch (cause) {
        if (cause?.code !== "JOB_CANCELLED") repository.fail({ errorCode: cause?.code ?? "fingerprint_failed", sourceId, sourceRevision });
        throw cause;
      }
    }
  };
};
