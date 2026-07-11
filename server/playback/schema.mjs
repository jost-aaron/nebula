export const PLAYBACK_SCHEMA_VERSION = 1;

// Foreign keys to account and catalog rows are intentionally added by the
// integration migration, where those table names and lifecycle are owned.
export const PLAYBACK_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS playback_states (
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    source_id TEXT,
    position_seconds REAL NOT NULL DEFAULT 0 CHECK(position_seconds >= 0),
    duration_seconds REAL CHECK(duration_seconds > 0),
    completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
    play_count INTEGER NOT NULL DEFAULT 0 CHECK(play_count >= 0),
    last_played_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );
  CREATE INDEX IF NOT EXISTS playback_continue_watching
    ON playback_states(user_id, completed, last_played_at DESC);

  CREATE TABLE IF NOT EXISTS playback_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    client_label TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active', 'paused', 'stopped', 'completed')),
    created_at TEXT NOT NULL,
    last_reported_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX IF NOT EXISTS playback_sessions_by_user
    ON playback_sessions(user_id, state, last_reported_at DESC);

  CREATE TABLE IF NOT EXISTS playback_events (
    user_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    event_kind TEXT NOT NULL CHECK(event_kind IN ('start', 'progress', 'pause', 'stop', 'complete')),
    position_seconds REAL NOT NULL,
    duration_seconds REAL,
    recorded_at TEXT NOT NULL,
    applied INTEGER NOT NULL CHECK(applied IN (0, 1)),
    PRIMARY KEY (user_id, event_id)
  );
`;

export const migratePlaybackSchema = (db) => {
  if (!db || typeof db.exec !== "function") throw new TypeError("A SQLite database is required.");
  db.exec(PLAYBACK_SCHEMA_SQL);
};

export const PLAYBACK_MIGRATION = Object.freeze({
  apply: migratePlaybackSchema,
  id: "playback-v1",
  sql: PLAYBACK_SCHEMA_SQL
});
