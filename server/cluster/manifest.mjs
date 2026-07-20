import { CLUSTER_MANIFEST_PAGE_LIMIT, CLUSTER_PROTOCOL_VERSION, validateClusterManifestPage } from "./protocol.mjs";

const error = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });
const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decodeCursor = (value) => {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || Object.keys(parsed).sort().join(",") !== "after,revision" || typeof parsed.after !== "string" || !Number.isSafeInteger(parsed.revision)) throw new Error();
    if (encodeCursor(parsed) !== value) throw new Error();
    return parsed;
  } catch {
    throw error(400, "invalid_cursor", "The manifest cursor is invalid.");
  }
};

const metadataYear = (value) => {
  try {
    const metadata = JSON.parse(value);
    const candidate = Number(metadata.year ?? String(metadata.releaseDate ?? "").slice(0, 4));
    return Number.isSafeInteger(candidate) && candidate >= 1800 && candidate <= 3000 ? candidate : null;
  } catch { return null; }
};

export const createClusterManifestService = ({ database, nodeId, listSubtitles = null } = {}) => {
  if (!database?.prepare) throw new TypeError("A SQLite database is required.");
  if (typeof nodeId !== "string") throw new TypeError("nodeId is required.");
  const externalIds = database.prepare(`SELECT provider, provider_item_id AS providerItemId, media_type AS mediaType
    FROM media_external_ids WHERE media_item_id = ? ORDER BY provider`);
  const renditions = database.prepare(`SELECT profile_id AS profileId, source_revision AS revision, state
    FROM media_renditions WHERE source_id = ? AND state IN ('pending', 'ready', 'failed') ORDER BY profile_id`);

  return {
    async page({ cursor = null, limit = CLUSTER_MANIFEST_PAGE_LIMIT } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > CLUSTER_MANIFEST_PAGE_LIMIT) throw error(400, "manifest_limit", `Manifest page limit must be between 1 and ${CLUSTER_MANIFEST_PAGE_LIMIT}.`);
      const state = database.prepare("SELECT revision FROM cluster_local_manifest_state WHERE singleton = 1").get();
      const decoded = decodeCursor(cursor);
      if (decoded && decoded.revision !== state.revision) throw error(409, "cursor_lost", "The local catalog changed during manifest synchronization; restart a full reconcile.");
      const after = decoded?.after ?? "";
      const rows = database.prepare(`SELECT s.*, i.item_type, i.title, i.metadata_json,
          f.algorithm, f.digest, f.source_revision AS fingerprint_revision, f.state AS fingerprint_state,
          p.duration_seconds, p.bitrate,
          (SELECT MAX(width) FROM media_streams WHERE source_id = s.id AND stream_type = 'video') AS width,
          (SELECT MAX(height) FROM media_streams WHERE source_id = s.id AND stream_type = 'video') AS height
        FROM media_sources s JOIN media_items i ON i.id = s.item_id
        JOIN media_source_fingerprints f ON f.source_id = s.id
        LEFT JOIN media_probe_results p ON p.source_id = s.id AND p.source_content_revision = s.content_revision
        WHERE s.id > ? ORDER BY s.id LIMIT ?`).all(after, limit + 1);
      const pageRows = rows.slice(0, limit);
      const complete = rows.length <= limit;
      const sources = await Promise.all(pageRows.map(async (row) => ({
        availability: row.availability === "available" ? "available" : "tombstone",
        bitrate: row.bitrate ?? null,
        durationSeconds: row.duration_seconds ?? null,
        externalIds: externalIds.all(row.item_id).map((entry) => ({ ...entry })),
        fingerprint: {
          algorithm: row.algorithm, digest: row.fingerprint_state === "ready" ? row.digest : null,
          sourceRevision: row.content_revision, state: row.fingerprint_revision === row.content_revision ? row.fingerprint_state : "pending"
        },
        height: row.height ?? null,
        itemKind: row.item_type,
        localItemId: row.item_id,
        localSourceId: row.id,
        mediaKind: row.media_kind,
        removedAt: row.availability === "available" ? null : row.updated_at,
        renditions: renditions.all(row.id).map((entry) => ({ ...entry })),
        sizeBytes: row.size_bytes,
        sourceRevision: row.content_revision,
        subtitles: row.media_kind === "video" && listSubtitles
          ? await listSubtitles({ itemId: row.item_id, sourceId: row.id }, row.content_revision)
          : [],
        title: row.title,
        width: row.width ?? null,
        year: metadataYear(row.metadata_json)
      })));
      return validateClusterManifestPage({
        complete,
        cursor: complete ? null : encodeCursor({ after: pageRows.at(-1).id, revision: state.revision }),
        manifestRevision: state.revision,
        nodeId,
        protocolVersion: CLUSTER_PROTOCOL_VERSION,
        sources
      });
    }
  };
};
