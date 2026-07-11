export const JOBS_SCHEMA_VERSION = 1;

export const JOBS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS background_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    payload_json TEXT NOT NULL,
    result_json TEXT,
    dedupe_key TEXT,
    progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
    current_stage TEXT,
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
    available_at TEXT NOT NULL,
    cancel_requested_at TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS background_jobs_active_dedupe
    ON background_jobs(type, dedupe_key)
    WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running');
  CREATE INDEX IF NOT EXISTS background_jobs_claim
    ON background_jobs(state, available_at, created_at);
  CREATE INDEX IF NOT EXISTS background_jobs_recent
    ON background_jobs(updated_at DESC, id);
`;

export const migrateJobsSchema = (db) => {
  if (!db || typeof db.exec !== "function") throw new TypeError("A SQLite database is required.");
  db.exec(JOBS_SCHEMA_SQL);
};

export const jobsMigration = Object.freeze({
  domain: "jobs",
  version: JOBS_SCHEMA_VERSION,
  apply: migrateJobsSchema,
  id: "jobs-v1",
  sql: JOBS_SCHEMA_SQL
});
