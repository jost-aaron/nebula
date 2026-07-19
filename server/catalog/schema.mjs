export const CATALOG_SCHEMA_VERSION = 3;

const externalIdsTableSql = `
  CREATE TABLE media_external_ids (
    media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_item_id TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (media_item_id, provider)
  ) STRICT;
`;

const catalogSchemaSql = `
  CREATE TABLE IF NOT EXISTS media_libraries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    media_kind TEXT NOT NULL CHECK (media_kind IN ('mixed', 'video', 'audio')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS media_library_roots (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES media_libraries(id) ON DELETE CASCADE,
    root_type TEXT NOT NULL DEFAULT 'local',
    root_key TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    media_kind TEXT NOT NULL CHECK (media_kind IN ('mixed', 'video', 'audio')),
    scan_status TEXT NOT NULL DEFAULT 'never' CHECK (scan_status IN ('never', 'scanning', 'ready', 'failed')),
    last_scan_id TEXT,
    last_scan_started_at TEXT,
    last_scan_completed_at TEXT,
    last_scan_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS media_items (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES media_libraries(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL,
    media_kind TEXT NOT NULL CHECK (media_kind IN ('video', 'audio')),
    title TEXT NOT NULL,
    sort_title TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    locked_fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS media_sources (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    root_id TEXT NOT NULL REFERENCES media_library_roots(id) ON DELETE CASCADE,
    content_path TEXT NOT NULL,
    previous_path TEXT,
    source_type TEXT NOT NULL DEFAULT 'local',
    media_kind TEXT NOT NULL CHECK (media_kind IN ('video', 'audio')),
    file_key TEXT,
    size_bytes INTEGER NOT NULL,
    modified_ms INTEGER NOT NULL,
    availability TEXT NOT NULL DEFAULT 'available' CHECK (availability IN ('available', 'missing', 'superseded')),
    content_revision INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    missing_since TEXT,
    missing_scan_count INTEGER NOT NULL DEFAULT 0,
    cleanup_eligible_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS media_sources_active_path
    ON media_sources(root_id, content_path)
    WHERE availability != 'superseded';
  CREATE INDEX IF NOT EXISTS media_sources_file_key
    ON media_sources(root_id, file_key)
    WHERE file_key IS NOT NULL AND availability != 'superseded';
  CREATE INDEX IF NOT EXISTS media_sources_item ON media_sources(item_id);

  ${externalIdsTableSql.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS")}

  CREATE TABLE IF NOT EXISTS media_artwork (
    id TEXT PRIMARY KEY,
    media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    artwork_type TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    remote_url TEXT NOT NULL DEFAULT '',
    local_path TEXT NOT NULL DEFAULT '',
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (media_item_id, artwork_type, provider, remote_url, local_path)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS media_scan_runs (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL REFERENCES media_library_roots(id) ON DELETE CASCADE,
    scan_type TEXT NOT NULL CHECK (scan_type IN ('full', 'incremental')),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    discovered_count INTEGER NOT NULL DEFAULT 0,
    new_count INTEGER NOT NULL DEFAULT 0,
    changed_count INTEGER NOT NULL DEFAULT 0,
    renamed_count INTEGER NOT NULL DEFAULT 0,
    missing_count INTEGER NOT NULL DEFAULT 0,
    restored_count INTEGER NOT NULL DEFAULT 0,
    unchanged_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
  ) STRICT;
`;

export const catalogMigration = Object.freeze({
  domain: "catalog",
  version: CATALOG_SCHEMA_VERSION,
  apply(database) {
    database.exec(catalogSchemaSql);
    const externalIdsDefinition = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_external_ids'").get()?.sql ?? "";
    if (/UNIQUE\s*\(\s*provider\s*,\s*provider_item_id\s*,\s*media_type\s*\)/i.test(externalIdsDefinition)) {
      database.exec(`
        ALTER TABLE media_external_ids RENAME TO media_external_ids_v1;
        ${externalIdsTableSql}
        INSERT INTO media_external_ids (media_item_id, provider, provider_item_id, media_type, created_at, updated_at)
          SELECT media_item_id, provider, provider_item_id, media_type, created_at, updated_at FROM media_external_ids_v1;
        DROP TABLE media_external_ids_v1;
      `);
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS media_source_fingerprints (
        source_id TEXT PRIMARY KEY REFERENCES media_sources(id) ON DELETE CASCADE,
        algorithm TEXT NOT NULL DEFAULT 'sha256' CHECK (algorithm IN ('sha256')),
        algorithm_version INTEGER NOT NULL DEFAULT 1 CHECK (algorithm_version = 1),
        digest TEXT CHECK (digest IS NULL OR (length(digest) = 64 AND digest GLOB '[0-9a-f]*')),
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        source_revision INTEGER NOT NULL CHECK (source_revision > 0),
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'failed')),
        fingerprinted_at TEXT,
        error_code TEXT,
        updated_at TEXT NOT NULL,
        CHECK ((state = 'ready' AND digest IS NOT NULL AND fingerprinted_at IS NOT NULL AND error_code IS NULL)
          OR (state != 'ready' AND digest IS NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS media_source_fingerprints_digest
        ON media_source_fingerprints(algorithm, digest, byte_length)
        WHERE state = 'ready';
      CREATE TRIGGER IF NOT EXISTS media_source_fingerprint_insert
      AFTER INSERT ON media_sources
      BEGIN
        INSERT INTO media_source_fingerprints
          (source_id, byte_length, source_revision, state, updated_at)
          VALUES (NEW.id, NEW.size_bytes, NEW.content_revision, 'pending', NEW.updated_at)
          ON CONFLICT(source_id) DO NOTHING;
      END;
      CREATE TRIGGER IF NOT EXISTS media_source_fingerprint_revision
      AFTER UPDATE OF content_revision, size_bytes ON media_sources
      WHEN OLD.content_revision != NEW.content_revision OR OLD.size_bytes != NEW.size_bytes
      BEGIN
        INSERT INTO media_source_fingerprints
          (source_id, byte_length, source_revision, state, updated_at)
          VALUES (NEW.id, NEW.size_bytes, NEW.content_revision, 'pending', NEW.updated_at)
          ON CONFLICT(source_id) DO UPDATE SET
            algorithm = 'sha256', algorithm_version = 1, digest = NULL,
            byte_length = NEW.size_bytes, source_revision = NEW.content_revision,
            state = 'pending', fingerprinted_at = NULL, error_code = NULL,
            updated_at = NEW.updated_at;
      END;
      INSERT INTO media_source_fingerprints
        (source_id, byte_length, source_revision, state, updated_at)
        SELECT id, size_bytes, content_revision, 'pending', updated_at FROM media_sources WHERE 1
        ON CONFLICT(source_id) DO NOTHING;
    `);
  }
});

export const applyCatalogMigration = (database) => catalogMigration.apply(database);
