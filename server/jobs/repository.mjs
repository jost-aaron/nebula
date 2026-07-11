import { randomUUID } from "node:crypto";
import { migrateJobsSchema } from "./schema.mjs";

const stringify = (value) => JSON.stringify(value ?? {});
const parse = (value) => value === null ? null : JSON.parse(value);
const iso = (value) => new Date(value).toISOString();

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

  const enqueue = ({ type, payload = {}, dedupeKey = null, maxAttempts = 3, availableAt = timestamp() }) => {
    const existing = dedupeKey === null ? null : db.prepare(`SELECT * FROM background_jobs
      WHERE type = ? AND dedupe_key = ? AND state IN ('queued', 'running')`).get(type, dedupeKey);
    if (existing) return { created: false, job: fromRow(existing) };
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

  const claimNext = () => {
    const claimedAt = timestamp();
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare(`SELECT id FROM background_jobs
        WHERE state = 'queued' AND available_at <= ? ORDER BY available_at, created_at, rowid LIMIT 1`).get(claimedAt);
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

  const list = ({ limit = 50, state = null, type = null } = {}) => db.prepare(`SELECT * FROM background_jobs
    WHERE (? IS NULL OR state = ?) AND (? IS NULL OR type = ?)
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(state, state, type, type, limit).map(fromRow);

  return { cancelRunning, claimNext, enqueue, failAttempt, get, isCancellationRequested, list,
    recoverInterrupted, requestCancellation, succeed, updateProgress };
};
