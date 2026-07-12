export const RENDITIONS_SCHEMA_VERSION = 1;

export const RENDITIONS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS media_renditions (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    profile_id TEXT NOT NULL,
    profile_version INTEGER NOT NULL CHECK (profile_version > 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'building', 'ready', 'failed', 'stale')),
    retention TEXT NOT NULL DEFAULT 'cache' CHECK (retention IN ('cache', 'pinned')),
    origin TEXT NOT NULL CHECK (origin IN ('interactive', 'scheduled')),
    storage_key TEXT,
    width INTEGER CHECK (width IS NULL OR width > 0),
    height INTEGER CHECK (height IS NULL OR height > 0),
    bitrate INTEGER CHECK (bitrate IS NULL OR bitrate > 0),
    video_bitrate INTEGER CHECK (video_bitrate IS NULL OR video_bitrate > 0),
    audio_bitrate INTEGER CHECK (audio_bitrate IS NULL OR audio_bitrate > 0),
    size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
    checksum TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    last_accessed_at TEXT,
    UNIQUE (source_id, source_revision, profile_id, profile_version)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS media_renditions_source
    ON media_renditions(source_id, source_revision, state);
  CREATE INDEX IF NOT EXISTS media_renditions_cleanup
    ON media_renditions(retention, state, last_accessed_at, updated_at);
`;

export const migrateRenditionsSchema = (database) => {
  if (!database || typeof database.exec !== "function") throw new TypeError("A SQLite database is required.");
  database.exec(RENDITIONS_SCHEMA_SQL);
};

export const renditionsMigration = Object.freeze({
  domain: "renditions",
  version: RENDITIONS_SCHEMA_VERSION,
  apply: migrateRenditionsSchema,
  id: "renditions-v1",
  sql: RENDITIONS_SCHEMA_SQL
});
