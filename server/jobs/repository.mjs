import { randomUUID } from "node:crypto";
import { migrateJobsSchema } from "./schema.mjs";

const stringify = (value) => JSON.stringify(value ?? {});
const parse = (value) => value === null ? null : JSON.parse(value);
const iso = (value) => new Date(value).toISOString();
const JOB_PRIORITY_SQL = `CASE type
  WHEN 'rendition' THEN 0
  WHEN 'probe' THEN 1
  WHEN 'artwork' THEN 2
  WHEN 'metadata' THEN 3
  WHEN 'fingerprint' THEN 4
  WHEN 'scan' THEN 5
  WHEN 'cleanup' THEN 6
  ELSE 7 END`;
const INTERACTIVE_JOB_SQL = "type IN ('rendition')";

const fromRow = (row) => row ? ({
  attempt: row.attempt,
  availableAt: row.available_at,
  cancelRequestedAt: row.cancel_requested_at,
  completedAt: row.completed_at,
  createdAt: row.created_at,
  currentStage: row.current_stage,
  dedupeKey: row.dedupe_key,
  error: row.error_message === null ? null : { code: row.error_code, message: row.error_message },
  id: row.id,
  maxAttempts: row.max_attempts,
  payload: parse(row.payload_json),
  progress: row.progress,
  result: parse(row.result_json),
  startedAt: row.started_at,
  state: row.state,
  type: row.type,
  updatedAt: row.updated_at
}) : null;

export const createJobsRepository = ({ db, migrate = false, now = () => Date.now(), uuid = randomUUID } = {}) => {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A SQLite database is required.");
  if (migrate) migrateJobsSchema(db);
  const timestamp = () => iso(now());
  const get = (id) => fromRow(db.prepare("SELECT * FROM background_jobs WHERE id = ?").get(id));
  const findByDedupe = (type, dedupeKey) => fromRow(db.prepare(`SELECT * FROM background_jobs
    WHERE type = ? AND dedupe_key = ?
    ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, updated_at DESC, rowid DESC LIMIT 1`)
    .get(type, dedupeKey));
  const findByDedupeMany = (type, dedupeKeys) => {
    const keys = [...new Set(dedupeKeys.map(String))].slice(0, 200);
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => "?").join(",");
    const rows = db.prepare(`SELECT * FROM background_jobs
      WHERE type = ? AND dedupe_key IN (${placeholders})
      ORDER BY dedupe_key, CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, updated_at DESC, rowid DESC`)
      .all(type, ...keys);
    const jobs = new Map();
    for (const row of rows) {
      if (!jobs.has(row.dedupe_key)) jobs.set(row.dedupe_key, fromRow(row));
    }
    return [...jobs.values()];
  };
  const activity = (type) => {
    const counts = Object.fromEntries(db.prepare(`SELECT state, COUNT(id) AS count FROM background_jobs
      WHERE type = ? GROUP BY state`).all(type).map((row) => [row.state, Number(row.count)]));
    const running = fromRow(db.prepare(`SELECT * FROM background_jobs WHERE type = ? AND state = 'running'
      ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(type));
    const next = fromRow(db.prepare(`SELECT * FROM background_jobs WHERE type = ? AND state = 'queued'
      ORDER BY available_at, rowid LIMIT 1`).get(type));
    return { counts, next, running };
  };
  const summary = () => {
    const counts = Object.fromEntries(db.prepare(
      "SELECT state, COUNT(id) AS count FROM background_jobs GROUP BY state"
    ).all().map((row) => [row.state, Number(row.count)]));
    const typeCounts = Object.fromEntries(db.prepare(
      "SELECT type, COUNT(id) AS count FROM background_jobs GROUP BY type"
    ).all().map((row) => [row.type, Number(row.count)]));
    return {
      counts,
      total: Object.values(counts).reduce((total, count) => total + count, 0),
      typeCounts
    };
  };

  const enqueue = ({ type, payload = {}, dedupeKey = null, maxAttempts = 3, availableAt = timestamp(), reuseTerminal = false }) => {
    const existing = dedupeKey === null ? null : db.prepare(`SELECT * FROM background_jobs
      WHERE type = ? AND dedupe_key = ? AND state IN ('queued', 'running')`).get(type, dedupeKey);
    if (existing) {
      const requestedAt = iso(availableAt);
      if (existing.state === "queued" && requestedAt < existing.available_at) {
        db.prepare("UPDATE background_jobs SET available_at = ?, updated_at = ? WHERE id = ? AND state = 'queued'")
          .run(requestedAt, timestamp(), existing.id);
        return { created: false, job: get(existing.id) };
      }
      return { created: false, job: fromRow(existing) };
    }
    if (reuseTerminal && dedupeKey !== null) {
      const terminal = db.prepare(`SELECT * FROM background_jobs
        WHERE type = ? AND dedupe_key = ? AND state IN ('failed', 'cancelled')
        ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(type, dedupeKey);
      if (terminal) return { created: false, job: fromRow(terminal) };
    }
    const id = uuid();
    const createdAt = timestamp();
    try {
      db.prepare(`INSERT INTO background_jobs
        (id, type, state, payload_json, dedupe_key, max_attempts, available_at, created_at, updated_at)
        VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`)
        .run(id, type, stringify(payload), dedupeKey, maxAttempts, iso(availableAt), createdAt, createdAt);
      return { created: true, job: get(id) };
    } catch (error) {
      if (dedupeKey !== null && /UNIQUE constraint failed/.test(error.message)) {
        return { created: false, job: fromRow(db.prepare(`SELECT * FROM background_jobs
          WHERE type = ? AND dedupe_key = ? AND state IN ('queued', 'running')`).get(type, dedupeKey)) };
      }
      throw error;
    }
  };

  const claimNext = ({ lane = "any" } = {}) => {
    if (!["any", "interactive", "maintenance"].includes(lane)) throw new TypeError("Unknown job lane.");
    const claimedAt = timestamp();
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare(`SELECT id FROM background_jobs
        WHERE state = 'queued' AND available_at <= ?
          AND (? = 'any' OR (? = 'interactive' AND ${INTERACTIVE_JOB_SQL})
            OR (? = 'maintenance' AND NOT ${INTERACTIVE_JOB_SQL}))
        ORDER BY CASE WHEN julianday(available_at) <= julianday(?) - (10.0 / 1440.0) THEN -1
          ELSE ${JOB_PRIORITY_SQL} END,
          available_at, created_at, rowid LIMIT 1`).get(claimedAt, lane, lane, lane, claimedAt);
      if (!row) {
        db.exec("COMMIT");
        return null;
      }
      db.prepare(`UPDATE background_jobs SET state = 'running', attempt = attempt + 1,
        started_at = ?, updated_at = ?, current_stage = COALESCE(current_stage, 'starting') WHERE id = ?`)
        .run(claimedAt, claimedAt, row.id);
      const job = get(row.id);
      db.exec("COMMIT");
      return job;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const updateProgress = (id, { progress, currentStage }) => {
    const result = db.prepare(`UPDATE background_jobs SET progress = ?, current_stage = ?, updated_at = ?
      WHERE id = ? AND state = 'running'`).run(progress, currentStage, timestamp(), id);
    return result.changes === 1 ? get(id) : null;
  };

  const requestCancellation = (id) => {
    const requestedAt = timestamp();
    db.prepare(`UPDATE background_jobs SET
      state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END,
      cancel_requested_at = CASE WHEN state IN ('queued', 'running') THEN ? ELSE cancel_requested_at END,
      completed_at = CASE WHEN state = 'queued' THEN ? ELSE completed_at END,
      updated_at = CASE WHEN state IN ('queued', 'running') THEN ? ELSE updated_at END
      WHERE id = ?`).run(requestedAt, requestedAt, requestedAt, id);
    return get(id);
  };

  const requestCancellationAll = ({ type = null } = {}) => {
    const requestedAt = timestamp();
    db.exec("BEGIN IMMEDIATE");
    try {
      const queuedCancelled = db.prepare(`UPDATE background_jobs SET state = 'cancelled',
        cancel_requested_at = ?, completed_at = ?, updated_at = ?
        WHERE state = 'queued' AND (? IS NULL OR type = ?)`)
        .run(requestedAt, requestedAt, requestedAt, type, type).changes;
      const runningRequested = db.prepare(`UPDATE background_jobs SET cancel_requested_at = ?, updated_at = ?
        WHERE state = 'running' AND cancel_requested_at IS NULL AND (? IS NULL OR type = ?)`)
        .run(requestedAt, requestedAt, type, type).changes;
      db.exec("COMMIT");
      return { queuedCancelled, runningRequested, total: queuedCancelled + runningRequested };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const isCancellationRequested = (id) => db.prepare(
    "SELECT cancel_requested_at IS NOT NULL AS requested FROM background_jobs WHERE id = ?"
  ).get(id)?.requested === 1;

  const succeed = (id, result = null) => {
    const completedAt = timestamp();
    const changes = db.prepare(`UPDATE background_jobs SET state = 'succeeded', result_json = ?, progress = 1,
      current_stage = 'completed', completed_at = ?, updated_at = ?
      WHERE id = ? AND state = 'running' AND cancel_requested_at IS NULL`)
      .run(result === null ? null : stringify(result), completedAt, completedAt, id).changes;
    return changes === 1 ? get(id) : null;
  };

  const cancelRunning = (id) => {
    const completedAt = timestamp();
    db.prepare(`UPDATE background_jobs SET state = 'cancelled', completed_at = ?, updated_at = ?
      WHERE id = ? AND state = 'running'`).run(completedAt, completedAt, id);
    return get(id);
  };

  const failAttempt = (id, { code = "JOB_FAILED", message, retryAt }) => {
    const job = get(id);
    if (!job || job.state !== "running") return job;
    if (job.cancelRequestedAt) return cancelRunning(id);
    const terminal = job.attempt >= job.maxAttempts;
    const updatedAt = timestamp();
    db.prepare(`UPDATE background_jobs SET state = ?, available_at = ?, error_code = ?, error_message = ?,
      current_stage = ?, completed_at = ?, updated_at = ? WHERE id = ? AND state = 'running'`)
      .run(terminal ? "failed" : "queued", terminal ? job.availableAt : iso(retryAt), code, message,
        terminal ? "failed" : "retrying", terminal ? updatedAt : null, updatedAt, id);
    return get(id);
  };

  const recoverInterrupted = () => {
    const recoveredAt = timestamp();
    const cancelled = db.prepare(`UPDATE background_jobs SET state = 'cancelled', completed_at = ?, updated_at = ?
      WHERE state = 'running' AND cancel_requested_at IS NOT NULL`).run(recoveredAt, recoveredAt).changes;
    const requeued = db.prepare(`UPDATE background_jobs SET state = 'queued', available_at = ?, started_at = NULL,
      current_stage = 'recovered', error_code = 'INTERRUPTED', error_message = 'Worker stopped before completion.', updated_at = ?
      WHERE state = 'running' AND cancel_requested_at IS NULL AND attempt < max_attempts`).run(recoveredAt, recoveredAt).changes;
    const failed = db.prepare(`UPDATE background_jobs SET state = 'failed', current_stage = 'failed', completed_at = ?,
      error_code = 'INTERRUPTED', error_message = 'Worker stopped after its final attempt.', updated_at = ?
      WHERE state = 'running' AND cancel_requested_at IS NULL`).run(recoveredAt, recoveredAt).changes;
    return { cancelled, failed, requeued };
  };

  const list = ({ limit = 50, offset = 0, query = null, state = null, type = null } = {}) => {
    const search = typeof query === "string" && query.trim() ? `%${query.trim().toLowerCase()}%` : null;
    return db.prepare(`SELECT * FROM background_jobs
      WHERE (? IS NULL OR state = ?) AND (? IS NULL OR type = ?)
        AND (? IS NULL OR lower(id) LIKE ? OR lower(type) LIKE ? OR lower(state) LIKE ?
          OR lower(COALESCE(current_stage, '')) LIKE ? OR lower(COALESCE(dedupe_key, '')) LIKE ?
          OR lower(COALESCE(error_code, '')) LIKE ? OR lower(COALESCE(error_message, '')) LIKE ?
          OR lower(payload_json) LIKE ?)
      ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
        CASE WHEN state = 'queued' THEN available_at END ASC,
        CASE WHEN state = 'running' THEN started_at END DESC,
        CASE WHEN state NOT IN ('queued', 'running') THEN updated_at END DESC,
        id DESC LIMIT ? OFFSET ?`)
      .all(state, state, type, type, search, search, search, search, search, search, search, search, search, limit, offset)
      .map(fromRow);
  };
  const count = ({ query = null, state = null, type = null } = {}) => {
    const search = typeof query === "string" && query.trim() ? `%${query.trim().toLowerCase()}%` : null;
    return Number(db.prepare(`SELECT COUNT(id) AS count FROM background_jobs
      WHERE (? IS NULL OR state = ?) AND (? IS NULL OR type = ?)
        AND (? IS NULL OR lower(id) LIKE ? OR lower(type) LIKE ? OR lower(state) LIKE ?
          OR lower(COALESCE(current_stage, '')) LIKE ? OR lower(COALESCE(dedupe_key, '')) LIKE ?
          OR lower(COALESCE(error_code, '')) LIKE ? OR lower(COALESCE(error_message, '')) LIKE ?
          OR lower(payload_json) LIKE ?)`)
      .get(state, state, type, type, search, search, search, search, search, search, search, search, search).count);
  };

  const pruneTerminal = ({ olderThan, retain = 1_000 } = {}) => {
    if (!Number.isInteger(retain) || retain < 0) throw new TypeError("retain must be a non-negative integer.");
    const cutoff = iso(olderThan);
    const result = db.prepare(`DELETE FROM background_jobs
      WHERE state IN ('succeeded', 'failed', 'cancelled') AND completed_at < ?
        AND id NOT IN (
          SELECT id FROM background_jobs
          WHERE state IN ('succeeded', 'failed', 'cancelled')
          ORDER BY completed_at DESC, id DESC LIMIT ?
        )`).run(cutoff, retain);
    return { deleted: result.changes };
  };

  return { activity, cancelRunning, claimNext, count, enqueue, failAttempt, findByDedupe, findByDedupeMany, get, isCancellationRequested, list,
    pruneTerminal, recoverInterrupted, requestCancellation, requestCancellationAll, succeed, summary, updateProgress };
};
