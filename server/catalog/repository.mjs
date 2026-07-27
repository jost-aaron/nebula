import { randomUUID } from "node:crypto";
import { CACHED_ARTWORK_PROVIDER, GENERATED_ARTWORK_PROVIDER } from "../artwork/paths.mjs";

const parseJson = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const rowToSource = (row) => row ? {
  id: row.id,
  itemId: row.item_id,
  rootId: row.root_id,
  path: row.content_path,
  previousPath: row.previous_path,
  sourceType: row.source_type,
  mediaKind: row.media_kind,
  fileKey: row.file_key,
  size: row.size_bytes,
  modifiedMs: row.modified_ms,
  availability: row.availability,
  contentRevision: row.content_revision,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
  missingSince: row.missing_since,
  missingScanCount: row.missing_scan_count,
  cleanupEligibleAt: row.cleanup_eligible_at,
  durationSeconds: Number.isFinite(Number(row.duration_seconds)) ? Number(row.duration_seconds) : null
} : null;

const rowToItem = (row) => row ? {
  id: row.id,
  libraryId: row.library_id,
  itemType: row.item_type,
  mediaKind: row.media_kind,
  title: row.title,
  sortTitle: row.sort_title,
  metadata: parseJson(row.metadata_json, {}),
  lockedFields: parseJson(row.locked_fields_json, []),
  createdAt: row.created_at,
  updatedAt: row.updated_at
} : null;

const transaction = (database, action) => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

const defaultClock = () => new Date().toISOString();
const sourceContentChanged = (source, file) => source.size_bytes !== file.size || source.modified_ms !== file.modifiedMs;
const sourceTitle = (contentPath) => {
  const fileName = String(contentPath).split("/").pop() ?? "";
  return fileName.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[._-]+/g, " ").trim() || fileName;
};

export const createCatalogRepository = (database, {
  now = defaultClock,
  uuid = randomUUID,
  missingCleanupScans = 2,
  missingCleanupMs = 7 * 24 * 60 * 60 * 1000,
  scanBatchSize = 250
} = {}) => {
  if (!Number.isInteger(scanBatchSize) || scanBatchSize < 10 || scanBatchSize > 5_000) {
    throw new TypeError("scanBatchSize must be an integer between 10 and 5000.");
  }
  const hasProbeResults = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_probe_results'").get());
  const probeJoin = hasProbeResults
    ? "LEFT JOIN media_probe_results p ON p.source_id = s.id AND p.source_content_revision = s.content_revision"
    : "";
  const probeDurationSelect = hasProbeResults ? "p.duration_seconds" : "NULL";
  const televisionTitleSql = `COALESCE(
    NULLIF(TRIM(json_extract(i.metadata_json, '$.episode.seriesTitle')), ''),
    CASE
      WHEN instr(s.content_path, '/') > 0 THEN CASE
        WHEN instr(substr(s.content_path, instr(s.content_path, '/') + 1), '/') > 0
          THEN substr(substr(s.content_path, instr(s.content_path, '/') + 1), 1, instr(substr(s.content_path, instr(s.content_path, '/') + 1), '/') - 1)
        ELSE substr(s.content_path, instr(s.content_path, '/') + 1)
      END
      ELSE i.title
    END
  )`;
  const televisionKeySql = `CASE
    WHEN x.provider_item_id IS NOT NULL THEN 'tmdb:' || x.provider_item_id
    ELSE 'title:' || LOWER(${televisionTitleSql})
  END`;
  const getLibrary = (id) => database.prepare("SELECT * FROM media_libraries WHERE id = ?").get(id) ?? null;
  const getRootByKey = (rootKey) => database.prepare("SELECT * FROM media_library_roots WHERE root_key = ?").get(rootKey) ?? null;
  const getItem = (id) => rowToItem(database.prepare("SELECT * FROM media_items WHERE id = ?").get(id));
  const getSource = (id) => rowToSource(database.prepare(hasProbeResults
    ? `SELECT s.*, p.duration_seconds FROM media_sources s
      LEFT JOIN media_probe_results p ON p.source_id = s.id AND p.source_content_revision = s.content_revision
      WHERE s.id = ?`
    : "SELECT * FROM media_sources WHERE id = ?").get(id));
  const resolveContentPath = (contentPath, rootId) => {
    const row = rootId
      ? database.prepare("SELECT * FROM media_sources WHERE root_id = ? AND content_path = ? AND availability != 'superseded'").get(rootId, contentPath)
      : database.prepare("SELECT * FROM media_sources WHERE content_path = ? AND availability != 'superseded' ORDER BY created_at LIMIT 1").get(contentPath);
    if (!row) return null;
    const source = rowToSource(row);
    return { ...source, item: getItem(row.item_id), source };
  };

  const listItems = ({ availability, libraryId, mediaKind } = {}) => {
    const clauses = [];
    const values = [];
    if (libraryId) { clauses.push("i.library_id = ?"); values.push(libraryId); }
    if (mediaKind) { clauses.push("i.media_kind = ?"); values.push(mediaKind); }
    if (availability) { clauses.push("s.availability = ?"); values.push(availability); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = database.prepare(`
      SELECT i.*, s.id AS source_id, s.item_id AS source_item_id, s.root_id AS source_root_id, s.content_path AS source_content_path,
        s.previous_path AS source_previous_path, s.source_type AS source_source_type,
        s.media_kind AS source_media_kind, s.file_key AS source_file_key, s.size_bytes AS source_size_bytes,
        s.modified_ms AS source_modified_ms, s.availability AS source_availability,
        s.content_revision AS source_content_revision, s.first_seen_at AS source_first_seen_at,
        s.last_seen_at AS source_last_seen_at, s.missing_since AS source_missing_since,
        s.missing_scan_count AS source_missing_scan_count, s.cleanup_eligible_at AS source_cleanup_eligible_at,
        ${probeDurationSelect} AS source_duration_seconds
      FROM media_items i JOIN media_sources s ON s.item_id = i.id AND s.availability != 'superseded'
      ${probeJoin}
      ${where} ORDER BY i.sort_title, i.id
    `).all(...values);
    return rows.map((row) => ({
      ...rowToItem(row),
      source: rowToSource(Object.fromEntries(Object.entries(row).filter(([key]) => key.startsWith("source_")).map(([key, value]) => [key.slice(7), value])))
    }));
  };

  const listItemsPage = ({ availability, itemType, limit = 60, mediaKind, offset = 0, query = "" } = {}) => {
    const clauses = [];
    const values = [];
    if (mediaKind) { clauses.push("i.media_kind = ?"); values.push(mediaKind); }
    if (itemType) { clauses.push("i.item_type = ?"); values.push(itemType); }
    if (availability) { clauses.push("s.availability = ?"); values.push(availability); }
    const normalizedQuery = String(query).trim().toLowerCase();
    if (normalizedQuery) {
      clauses.push("(LOWER(i.title) LIKE ? OR LOWER(i.sort_title) LIKE ? OR LOWER(s.content_path) LIKE ?)");
      const pattern = `%${normalizedQuery}%`;
      values.push(pattern, pattern, pattern);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 60));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const from = `FROM media_items i JOIN media_sources s ON s.item_id = i.id AND s.availability != 'superseded'
      ${probeJoin} ${where}`;
    const total = Number(database.prepare(`SELECT COUNT(*) AS count ${from}`).get(...values)?.count ?? 0);
    const rows = database.prepare(`
      SELECT i.*, s.id AS source_id, s.item_id AS source_item_id, s.root_id AS source_root_id, s.content_path AS source_content_path,
        s.previous_path AS source_previous_path, s.source_type AS source_source_type,
        s.media_kind AS source_media_kind, s.file_key AS source_file_key, s.size_bytes AS source_size_bytes,
        s.modified_ms AS source_modified_ms, s.availability AS source_availability,
        s.content_revision AS source_content_revision, s.first_seen_at AS source_first_seen_at,
        s.last_seen_at AS source_last_seen_at, s.missing_since AS source_missing_since,
        s.missing_scan_count AS source_missing_scan_count, s.cleanup_eligible_at AS source_cleanup_eligible_at,
        ${probeDurationSelect} AS source_duration_seconds
      ${from} ORDER BY i.sort_title, i.id LIMIT ? OFFSET ?
    `).all(...values, boundedLimit, boundedOffset);
    const items = rows.map((row) => ({
      ...rowToItem(row),
      source: rowToSource(Object.fromEntries(Object.entries(row).filter(([key]) => key.startsWith("source_")).map(([key, value]) => [key.slice(7), value])))
    }));
    return { items, limit: boundedLimit, offset: boundedOffset, total };
  };

  const televisionEpisodesCte = `WITH television_episodes AS (
    SELECT i.id, i.sort_title, s.content_path, ${televisionTitleSql} AS series_title,
      ${televisionKeySql} AS series_key,
      COALESCE(CAST(json_extract(i.metadata_json, '$.episode.seasonNumber') AS INTEGER), 0) AS season_number,
      COALESCE(p.duration_seconds, 0) AS duration_seconds,
      CASE WHEN EXISTS (
        SELECT 1 FROM media_artwork a WHERE a.media_item_id = i.id
          AND a.artwork_type = 'poster' AND (a.local_path != '' OR a.remote_url != '')
      ) THEN 1 ELSE 0 END AS has_poster,
      CASE WHEN x.provider_item_id IS NOT NULL THEN 1 ELSE 0 END AS has_tmdb
    FROM media_items i
    JOIN media_sources s ON s.item_id = i.id AND s.availability = 'available'
    LEFT JOIN media_external_ids x ON x.media_item_id = i.id AND x.provider = 'tmdb'
    ${hasProbeResults ? "LEFT JOIN media_probe_results p ON p.source_id = s.id AND p.source_content_revision = s.content_revision" : "LEFT JOIN (SELECT NULL AS source_id, NULL AS duration_seconds) p ON 0"}
    WHERE i.media_kind = 'video' AND i.item_type = 'episode'
  )`;

  const listTelevisionSeriesPage = ({ limit = 60, offset = 0, query = "" } = {}) => {
    const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 60));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const normalizedQuery = String(query).trim().toLowerCase();
    const filter = normalizedQuery ? "WHERE LOWER(series_title) LIKE ? OR LOWER(content_path) LIKE ?" : "";
    const values = normalizedQuery ? [`%${normalizedQuery}%`, `%${normalizedQuery}%`] : [];
    const grouped = `SELECT series_key, MIN(series_title) AS title, COUNT(*) AS episode_count,
      COUNT(DISTINCT season_number) AS season_count, GROUP_CONCAT(DISTINCT season_number) AS seasons,
      CAST(SUM(duration_seconds) AS REAL) AS runtime_seconds
      FROM television_episodes ${filter} GROUP BY series_key`;
    const total = Number(database.prepare(`${televisionEpisodesCte} SELECT COUNT(*) AS count FROM (${grouped})`).get(...values)?.count ?? 0);
    const rows = database.prepare(`${televisionEpisodesCte},
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY series_key ORDER BY has_poster DESC, has_tmdb DESC, sort_title, id
        ) AS representative_rank
        FROM television_episodes ${filter}
      ),
      aggregates AS (${grouped})
      SELECT aggregates.*, ranked.id AS representative_item_id
      FROM aggregates JOIN ranked USING (series_key)
      WHERE ranked.representative_rank = 1
      ORDER BY LOWER(aggregates.title), aggregates.series_key LIMIT ? OFFSET ?`)
      .all(...values, ...values, boundedLimit, boundedOffset);
    return {
      groups: rows.map((row) => ({
        episodeCount: Number(row.episode_count),
        key: row.series_key,
        representativeItemId: row.representative_item_id,
        runtimeSeconds: Number(row.runtime_seconds) || null,
        seasonCount: Number(row.season_count),
        seasons: String(row.seasons ?? "").split(",").map(Number).filter(Number.isFinite).sort((left, right) => left - right),
        title: row.title
      })),
      limit: boundedLimit,
      offset: boundedOffset,
      total
    };
  };

  const listTelevisionEpisodes = ({ limit = 200, offset = 0, seriesKey }) => {
    const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const from = `FROM media_items i
      JOIN media_sources s ON s.item_id = i.id AND s.availability = 'available'
      LEFT JOIN media_external_ids x ON x.media_item_id = i.id AND x.provider = 'tmdb'
      ${probeJoin}
      WHERE i.media_kind = 'video' AND i.item_type = 'episode' AND ${televisionKeySql} = ?`;
    const total = Number(database.prepare(`SELECT COUNT(*) AS count ${from}`).get(seriesKey)?.count ?? 0);
    const rows = database.prepare(`SELECT i.*,
      s.id AS source_id, s.item_id AS source_item_id, s.root_id AS source_root_id, s.content_path AS source_content_path,
      s.previous_path AS source_previous_path, s.source_type AS source_source_type,
      s.media_kind AS source_media_kind, s.file_key AS source_file_key, s.size_bytes AS source_size_bytes,
      s.modified_ms AS source_modified_ms, s.availability AS source_availability,
      s.content_revision AS source_content_revision, s.first_seen_at AS source_first_seen_at,
      s.last_seen_at AS source_last_seen_at, s.missing_since AS source_missing_since,
      s.missing_scan_count AS source_missing_scan_count, s.cleanup_eligible_at AS source_cleanup_eligible_at,
      ${probeDurationSelect} AS source_duration_seconds
      ${from}
      ORDER BY CAST(json_extract(i.metadata_json, '$.episode.seasonNumber') AS INTEGER),
        CAST(json_extract(i.metadata_json, '$.episode.episodeNumber') AS INTEGER), i.sort_title, i.id
      LIMIT ? OFFSET ?`).all(seriesKey, boundedLimit, boundedOffset);
    return {
      items: rows.map((row) => ({
        ...rowToItem(row),
        source: rowToSource(Object.fromEntries(Object.entries(row).filter(([key]) => key.startsWith("source_")).map(([key, value]) => [key.slice(7), value])))
      })),
      limit: boundedLimit,
      offset: boundedOffset,
      total
    };
  };

  const listItemsByIds = (itemIds) => {
    const ids = [...new Set((itemIds ?? []).map(String))];
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = database.prepare(`SELECT i.*,
      s.id AS source_id, s.item_id AS source_item_id, s.root_id AS source_root_id, s.content_path AS source_content_path,
      s.previous_path AS source_previous_path, s.source_type AS source_source_type,
      s.media_kind AS source_media_kind, s.file_key AS source_file_key, s.size_bytes AS source_size_bytes,
      s.modified_ms AS source_modified_ms, s.availability AS source_availability,
      s.content_revision AS source_content_revision, s.first_seen_at AS source_first_seen_at,
      s.last_seen_at AS source_last_seen_at, s.missing_since AS source_missing_since,
      s.missing_scan_count AS source_missing_scan_count, s.cleanup_eligible_at AS source_cleanup_eligible_at,
      ${probeDurationSelect} AS source_duration_seconds
      FROM media_items i JOIN media_sources s ON s.item_id = i.id AND s.availability != 'superseded'
      ${probeJoin} WHERE i.id IN (${placeholders})`).all(...ids);
    const byId = new Map(rows.map((row) => [row.id, {
      ...rowToItem(row),
      source: rowToSource(Object.fromEntries(Object.entries(row).filter(([key]) => key.startsWith("source_")).map(([key, value]) => [key.slice(7), value])))
    }]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  };

  const countTelevisionSeries = () => listTelevisionSeriesPage({ limit: 1 }).total;

  const ensureLibrary = ({ id = uuid(), name, mediaKind = "mixed" }) => {
    const timestamp = now();
    database.prepare(`INSERT INTO media_libraries (id, name, media_kind, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, media_kind = excluded.media_kind, updated_at = excluded.updated_at`)
      .run(id, name, mediaKind, timestamp, timestamp);
    return database.prepare("SELECT * FROM media_libraries WHERE id = ?").get(id);
  };

  const ensureRoot = ({ id = uuid(), libraryId, rootKey, path, rootType = "local", mediaKind = "mixed" }) => {
    const timestamp = now();
    database.prepare(`INSERT INTO media_library_roots (id, library_id, root_type, root_key, path, media_kind, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(root_key) DO UPDATE SET library_id = excluded.library_id,
      root_type = excluded.root_type, path = excluded.path, media_kind = excluded.media_kind, updated_at = excluded.updated_at`)
      .run(id, libraryId, rootType, rootKey, path, mediaKind, timestamp, timestamp);
    return database.prepare("SELECT * FROM media_library_roots WHERE root_key = ?").get(rootKey);
  };

  const reconcileScan = ({ rootId, scanType = "full", files }) => {
    const paths = new Set();
    for (const file of files) {
      if (paths.has(file.path)) throw new Error(`Scan contains duplicate path: ${file.path}`);
      paths.add(file.path);
    }
    return transaction(database, () => {
    const root = database.prepare("SELECT * FROM media_library_roots WHERE id = ?").get(rootId);
    if (!root) throw new Error(`Unknown catalog root: ${rootId}`);
    const timestamp = now();
    const scanId = uuid();
    const counts = { changed: 0, missing: 0, new: 0, renamed: 0, restored: 0, unchanged: 0 };
    database.prepare("INSERT INTO media_scan_runs (id, root_id, scan_type, status, started_at) VALUES (?, ?, ?, 'running', ?)").run(scanId, rootId, scanType, timestamp);
    database.prepare("UPDATE media_library_roots SET scan_status = 'scanning', last_scan_id = ?, last_scan_started_at = ?, last_scan_error = NULL, updated_at = ? WHERE id = ?")
      .run(scanId, timestamp, timestamp, rootId);

    const seen = new Set();
    const activeByPath = database.prepare("SELECT * FROM media_sources WHERE root_id = ? AND content_path = ? AND availability != 'superseded'");
    const activeByKey = database.prepare("SELECT * FROM media_sources WHERE root_id = ? AND file_key = ? AND availability != 'superseded' ORDER BY availability = 'available' DESC, updated_at DESC LIMIT 1");
    const insertItem = database.prepare("INSERT INTO media_items (id, library_id, item_type, media_kind, title, sort_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const insertSource = database.prepare(`INSERT INTO media_sources
      (id, item_id, root_id, content_path, media_kind, file_key, size_bytes, modified_ms, first_seen_at, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const updateItemClassification = database.prepare("UPDATE media_items SET item_type = ?, media_kind = ?, updated_at = ? WHERE id = ? AND (item_type != ? OR media_kind != ?)");
    const updateSourceKind = database.prepare("UPDATE media_sources SET media_kind = ?, updated_at = ? WHERE id = ? AND media_kind != ?");

    let processedSinceCommit = 0;
    for (const file of files) {
      seen.add(file.path);
      let source = activeByPath.get(rootId, file.path);
      const keyed = file.fileKey ? activeByKey.get(rootId, file.fileKey) : null;

      if (source && file.fileKey && source.file_key && source.file_key !== file.fileKey) {
        database.prepare("UPDATE media_sources SET availability = 'superseded', missing_since = ?, missing_scan_count = 1, cleanup_eligible_at = NULL, updated_at = ? WHERE id = ?")
          .run(timestamp, timestamp, source.id);
        source = null;
      }

      if (!source && keyed) {
        const wasMissing = keyed.availability === "missing";
        const changed = sourceContentChanged(keyed, file);
        database.prepare(`UPDATE media_sources SET previous_path = content_path, content_path = ?, size_bytes = ?, modified_ms = ?,
          availability = 'available', content_revision = content_revision + ?, last_seen_at = ?, missing_since = NULL, missing_scan_count = 0,
          cleanup_eligible_at = NULL, updated_at = ? WHERE id = ?`)
          .run(file.path, file.size, file.modifiedMs, changed ? 1 : 0, timestamp, timestamp, keyed.id);
        source = { ...keyed, content_path: file.path };
        if (keyed.content_path !== file.path) counts.renamed += 1;
        else if (wasMissing) counts.restored += 1;
        else counts.unchanged += 1;
      } else if (!source) {
        const itemId = uuid();
        const sourceId = uuid();
        insertItem.run(itemId, root.library_id, file.itemType, file.mediaKind, file.title, file.sortTitle ?? file.title, timestamp, timestamp);
        insertSource.run(sourceId, itemId, rootId, file.path, file.mediaKind, file.fileKey ?? null, file.size, file.modifiedMs, timestamp, timestamp, timestamp, timestamp);
        source = { id: sourceId };
        counts.new += 1;
      } else {
        const restored = source.availability === "missing";
        const changed = sourceContentChanged(source, file);
        database.prepare(`UPDATE media_sources SET file_key = ?, size_bytes = ?, modified_ms = ?, availability = 'available',
          content_revision = content_revision + ?, last_seen_at = ?, missing_since = NULL, missing_scan_count = 0,
          cleanup_eligible_at = NULL, updated_at = ? WHERE id = ?`)
          .run(file.fileKey ?? source.file_key, file.size, file.modifiedMs, changed ? 1 : 0, timestamp, timestamp, source.id);
        if (restored) counts.restored += 1;
        else if (changed) counts.changed += 1;
        else counts.unchanged += 1;
      }
      if (source.item_id) {
        updateItemClassification.run(file.itemType, file.mediaKind, timestamp, source.item_id, file.itemType, file.mediaKind);
        updateSourceKind.run(file.mediaKind, timestamp, source.id, file.mediaKind);
      }
      processedSinceCommit += 1;
      if (processedSinceCommit >= scanBatchSize) {
        // Keep the scan run in "scanning" state while releasing SQLite's
        // writer lock between bounded batches. Any committed partial work is
        // idempotently reconciled by a retry; missing detection happens only
        // after every discovered file is published.
        database.exec("COMMIT; BEGIN IMMEDIATE");
        processedSinceCommit = 0;
      }
    }

    if (scanType === "full") {
      const candidates = database.prepare("SELECT * FROM media_sources WHERE root_id = ? AND availability != 'superseded'").all(rootId);
      processedSinceCommit = 0;
      for (const source of candidates) {
        if (seen.has(source.content_path)) continue;
        const missingCount = source.missing_scan_count + 1;
        const missingSince = source.missing_since ?? timestamp;
        const oldEnough = Date.parse(timestamp) - Date.parse(missingSince) >= missingCleanupMs;
        const cleanupAt = missingCount >= missingCleanupScans && oldEnough ? timestamp : null;
        database.prepare(`UPDATE media_sources SET availability = 'missing', missing_since = ?, missing_scan_count = ?,
          cleanup_eligible_at = ?, updated_at = ? WHERE id = ?`)
          .run(missingSince, missingCount, cleanupAt, timestamp, source.id);
        counts.missing += 1;
        processedSinceCommit += 1;
        if (processedSinceCommit >= scanBatchSize) {
          database.exec("COMMIT; BEGIN IMMEDIATE");
          processedSinceCommit = 0;
        }
      }
    }

    database.prepare(`UPDATE media_scan_runs SET status = 'completed', completed_at = ?, discovered_count = ?,
      new_count = ?, changed_count = ?, renamed_count = ?, missing_count = ?, restored_count = ?, unchanged_count = ? WHERE id = ?`)
      .run(timestamp, files.length, counts.new, counts.changed, counts.renamed, counts.missing, counts.restored, counts.unchanged, scanId);
    database.prepare("UPDATE media_library_roots SET scan_status = 'ready', last_scan_completed_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, rootId);
    return { id: scanId, rootId, scanType, discovered: files.length, ...counts };
    });
  };

  const recordScanFailure = ({ error, rootId, scanType = "full" }) => transaction(database, () => {
    const root = database.prepare("SELECT id FROM media_library_roots WHERE id = ?").get(rootId);
    if (!root) throw new Error(`Unknown catalog root: ${rootId}`);
    const timestamp = now();
    const scanId = uuid();
    const message = String(error?.message ?? error ?? "Catalog scan failed.");
    database.prepare("INSERT INTO media_scan_runs (id, root_id, scan_type, status, started_at, completed_at, error) VALUES (?, ?, ?, 'failed', ?, ?, ?)")
      .run(scanId, rootId, scanType, timestamp, timestamp, message);
    database.prepare(`UPDATE media_library_roots SET scan_status = 'failed', last_scan_id = ?, last_scan_started_at = ?,
      last_scan_completed_at = ?, last_scan_error = ?, updated_at = ? WHERE id = ?`)
      .run(scanId, timestamp, timestamp, message, timestamp, rootId);
    return { error: message, id: scanId, rootId, scanType, status: "failed" };
  });

  const putExternalMetadata = (itemId, {
    artwork = [],
    expectedContentRevision = null,
    expectedSourceId = null,
    externalIds = [],
    fields = {},
    lockedFields = [],
    mode = "provider"
  }) => transaction(database, () => {
    const item = getItem(itemId);
    if (!item) throw new Error(`Unknown catalog item: ${itemId}`);
    if (expectedSourceId !== null || expectedContentRevision !== null) {
      const source = expectedSourceId === null
        ? null
        : database.prepare("SELECT item_id, availability, content_revision FROM media_sources WHERE id = ?").get(expectedSourceId);
      if (!source || source.item_id !== itemId || source.availability !== "available"
        || source.content_revision !== expectedContentRevision) {
        throw Object.assign(new Error("Media changed before metadata could be published."), {
          code: "METADATA_SOURCE_CHANGED",
          retryable: true
        });
      }
    }
    const timestamp = now();
    const locks = new Set(item.lockedFields);
    if (mode === "manual") lockedFields.forEach((field) => locks.add(field));
    const accepted = Object.fromEntries(Object.entries(fields).filter(([field]) => mode === "manual" || !locks.has(field)));
    const metadata = { ...item.metadata, ...accepted };
    const title = typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : item.title;
    const sortTitle = typeof metadata.sortTitle === "string" && metadata.sortTitle.trim() ? metadata.sortTitle.trim() : title;
    database.prepare("UPDATE media_items SET title = ?, sort_title = ?, metadata_json = ?, locked_fields_json = ?, updated_at = ? WHERE id = ?")
      .run(title, sortTitle, JSON.stringify(metadata), JSON.stringify([...locks].sort()), timestamp, itemId);
    for (const external of externalIds) {
      database.prepare(`INSERT INTO media_external_ids (media_item_id, provider, provider_item_id, media_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(media_item_id, provider) DO UPDATE SET provider_item_id = excluded.provider_item_id,
        media_type = excluded.media_type, updated_at = excluded.updated_at`)
        .run(itemId, external.provider, String(external.id), external.mediaType ?? "", timestamp, timestamp);
    }
    for (const image of artwork) {
      database.prepare(`INSERT INTO media_artwork (id, media_item_id, artwork_type, provider, remote_url, local_path, width, height, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(media_item_id, artwork_type, provider, remote_url, local_path)
        DO UPDATE SET width = excluded.width, height = excluded.height, updated_at = excluded.updated_at`)
        .run(uuid(), itemId, image.type, image.provider ?? "", image.remoteUrl ?? "", image.localPath ?? "", image.width ?? null, image.height ?? null, timestamp, timestamp);
    }
    return getItem(itemId);
  });

  const putGeneratedArtwork = (sourceId, { expectedContentRevision, height, localPath, width }) => transaction(database, () => {
    const source = database.prepare("SELECT * FROM media_sources WHERE id = ?").get(sourceId);
    if (!source || source.availability !== "available") {
      throw Object.assign(new Error(`Unknown or unavailable catalog source: ${sourceId}`), { code: "ARTWORK_SOURCE_MISSING" });
    }
    if (source.content_revision !== expectedContentRevision) {
      throw Object.assign(new Error("Media changed before generated artwork could be published."), { code: "ARTWORK_SOURCE_CHANGED" });
    }
    const timestamp = now();
    database.prepare("DELETE FROM media_artwork WHERE media_item_id = ? AND provider = ?")
      .run(source.item_id, GENERATED_ARTWORK_PROVIDER);
    database.prepare(`INSERT INTO media_artwork
      (id, media_item_id, artwork_type, provider, remote_url, local_path, width, height, created_at, updated_at)
      VALUES (?, ?, 'poster', ?, '', ?, ?, ?, ?, ?)`)
      .run(uuid(), source.item_id, GENERATED_ARTWORK_PROVIDER, localPath, width ?? null, height ?? null, timestamp, timestamp);
    return listArtwork(source.item_id);
  });

  const putCachedArtwork = (sourceId, { expectedContentRevision, height, localPath, remoteUrl, width }) => transaction(database, () => {
    const source = database.prepare("SELECT * FROM media_sources WHERE id = ?").get(sourceId);
    if (!source || source.availability !== "available") {
      throw Object.assign(new Error(`Unknown or unavailable catalog source: ${sourceId}`), { code: "ARTWORK_SOURCE_MISSING" });
    }
    if (source.content_revision !== expectedContentRevision) {
      throw Object.assign(new Error("Media changed before cached artwork could be published."), { code: "ARTWORK_SOURCE_CHANGED" });
    }
    const timestamp = now();
    database.prepare("DELETE FROM media_artwork WHERE media_item_id = ? AND provider IN (?, ?)")
      .run(source.item_id, CACHED_ARTWORK_PROVIDER, GENERATED_ARTWORK_PROVIDER);
    database.prepare(`INSERT INTO media_artwork
      (id, media_item_id, artwork_type, provider, remote_url, local_path, width, height, created_at, updated_at)
      VALUES (?, ?, 'poster', ?, ?, ?, ?, ?, ?, ?)`)
      .run(uuid(), source.item_id, CACHED_ARTWORK_PROVIDER, remoteUrl ?? "", localPath, width ?? null, height ?? null, timestamp, timestamp);
    return listArtwork(source.item_id);
  });

  const resetMetadata = ({ mediaKind = "video" } = {}) => transaction(database, () => {
    const rows = database.prepare(`SELECT i.id, s.content_path
      FROM media_items i JOIN media_sources s ON s.item_id = i.id AND s.availability != 'superseded'
      WHERE i.media_kind = ? ORDER BY i.id`).all(mediaKind);
    const update = database.prepare(`UPDATE media_items SET title = ?, sort_title = ?, metadata_json = '{}',
      locked_fields_json = '[]', updated_at = ? WHERE id = ?`);
    const removeExternalIds = database.prepare("DELETE FROM media_external_ids WHERE media_item_id = ?");
    const removeArtwork = database.prepare("DELETE FROM media_artwork WHERE media_item_id = ?");
    const timestamp = now();
    let externalIds = 0;
    let artwork = 0;
    for (const row of rows) {
      const title = sourceTitle(row.content_path);
      update.run(title, title, timestamp, row.id);
      externalIds += removeExternalIds.run(row.id).changes;
      artwork += removeArtwork.run(row.id).changes;
    }
    return { artwork, externalIds, items: rows.length, mediaKind };
  });

  const putProbeResult = () => { throw new Error("Probe persistence is reserved for the Wave 2 catalog migration."); };
  const listExternalIds = (itemId) => database.prepare("SELECT provider, provider_item_id AS id, media_type AS mediaType FROM media_external_ids WHERE media_item_id = ? ORDER BY provider").all(itemId).map((row) => ({ ...row }));
  const listArtwork = (itemId) => database.prepare("SELECT id, artwork_type AS type, provider, remote_url AS remoteUrl, local_path AS localPath, width, height FROM media_artwork WHERE media_item_id = ? ORDER BY artwork_type, id").all(itemId).map((row) => ({ ...row }));
  const listArtworkMany = (itemIds) => {
    const ids = [...new Set((itemIds ?? []).map(String))];
    const result = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return result;
    for (let offset = 0; offset < ids.length; offset += 200) {
      const batch = ids.slice(offset, offset + 200);
      const placeholders = batch.map(() => "?").join(",");
      for (const row of database.prepare(`SELECT media_item_id, id, artwork_type AS type, provider,
        remote_url AS remoteUrl, local_path AS localPath, width, height
        FROM media_artwork WHERE media_item_id IN (${placeholders})
        ORDER BY media_item_id, artwork_type, id`).all(...batch)) {
        result.get(row.media_item_id)?.push({
          height: row.height,
          id: row.id,
          localPath: row.localPath,
          provider: row.provider,
          remoteUrl: row.remoteUrl,
          type: row.type,
          width: row.width
        });
      }
    }
    return result;
  };
  const listExternalIdsMany = (itemIds) => {
    const ids = [...new Set((itemIds ?? []).map(String))];
    const result = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return result;
    for (let offset = 0; offset < ids.length; offset += 200) {
      const batch = ids.slice(offset, offset + 200);
      const placeholders = batch.map(() => "?").join(",");
      for (const row of database.prepare(`SELECT media_item_id, provider, provider_item_id AS id, media_type AS mediaType
        FROM media_external_ids WHERE media_item_id IN (${placeholders})
        ORDER BY media_item_id, provider`).all(...batch)) {
        result.get(row.media_item_id)?.push({ id: row.id, mediaType: row.mediaType, provider: row.provider });
      }
    }
    return result;
  };
  const listCleanupCandidates = () => database.prepare("SELECT * FROM media_sources WHERE availability = 'missing' AND cleanup_eligible_at IS NOT NULL ORDER BY cleanup_eligible_at").all().map(rowToSource);

  return { countTelevisionSeries, ensureLibrary, ensureRoot, getItem, getLibrary, getRootByKey, getSource, listArtwork, listArtworkMany, listCleanupCandidates, listExternalIds, listExternalIdsMany, listItems, listItemsByIds, listItemsPage, listTelevisionEpisodes, listTelevisionSeriesPage, putCachedArtwork, putExternalMetadata, putGeneratedArtwork, putProbeResult, reconcileScan, recordScanFailure, resetMetadata, resolveContentPath };
};
