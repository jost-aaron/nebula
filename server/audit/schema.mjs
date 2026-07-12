export const AUDIT_SCHEMA_VERSION = 1;

export const AUDIT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('account', 'service', 'system', 'anonymous')),
    principal_id TEXT,
    actor_role TEXT,
    target_type TEXT,
    target_id TEXT,
    occurred_at TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    CHECK (length(event_type) BETWEEN 3 AND 96),
    CHECK (principal_id IS NULL OR length(principal_id) <= 128),
    CHECK (actor_role IS NULL OR length(actor_role) <= 32),
    CHECK (target_type IS NULL OR length(target_type) <= 64),
    CHECK (target_id IS NULL OR length(target_id) <= 160),
    CHECK (length(metadata_json) <= 4096)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS audit_events_recent
    ON audit_events(occurred_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS audit_events_type_recent
    ON audit_events(event_type, occurred_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS audit_events_actor_recent
    ON audit_events(actor_kind, principal_id, occurred_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS audit_events_outcome_recent
    ON audit_events(outcome, occurred_at DESC, id DESC);
`;

export const migrateAuditSchema = (db) => {
  if (!db || typeof db.exec !== "function") throw new TypeError("A SQLite database is required.");
  db.exec(AUDIT_SCHEMA_SQL);
};

export const auditMigration = Object.freeze({
  domain: "audit",
  version: AUDIT_SCHEMA_VERSION,
  apply: migrateAuditSchema,
  id: "audit-v1",
  sql: AUDIT_SCHEMA_SQL
});
