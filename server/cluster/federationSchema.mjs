export const CLUSTER_FEDERATION_SCHEMA_VERSION = 1;

export const clusterFederationMigration = Object.freeze({
  domain: "cluster-federation",
  version: CLUSTER_FEDERATION_SCHEMA_VERSION,
  id: "cluster-federation-v1",
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS cluster_local_manifest_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision > 0),
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO cluster_local_manifest_state (singleton, revision, updated_at)
        VALUES (1, 1, '1970-01-01T00:00:00.000Z');

      CREATE TABLE IF NOT EXISTS cluster_manifest_cursors (
        node_id TEXT PRIMARY KEY REFERENCES cluster_nodes(node_id) ON DELETE CASCADE,
        manifest_revision INTEGER NOT NULL CHECK (manifest_revision > 0),
        cursor TEXT,
        sync_generation TEXT NOT NULL,
        last_sync_at TEXT,
        last_complete_at TEXT,
        last_error_code TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS federated_items (
        id TEXT PRIMARY KEY,
        media_kind TEXT NOT NULL CHECK (media_kind IN ('video', 'audio')),
        item_kind TEXT NOT NULL,
        title TEXT NOT NULL,
        year INTEGER,
        automatic_key TEXT UNIQUE,
        candidate_signature TEXT NOT NULL,
        merged_into_id TEXT REFERENCES federated_items(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS federated_items_candidate ON federated_items(candidate_signature);

      CREATE TABLE IF NOT EXISTS federated_editions (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES federated_items(id) ON DELETE CASCADE,
        edition_key TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT 'Default',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(item_id, edition_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS federated_sources (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES federated_items(id) ON DELETE CASCADE,
        edition_id TEXT NOT NULL REFERENCES federated_editions(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL REFERENCES cluster_nodes(node_id) ON DELETE CASCADE,
        local_item_id TEXT NOT NULL,
        local_source_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL CHECK (source_revision > 0),
        manifest_revision INTEGER NOT NULL CHECK (manifest_revision > 0),
        sync_generation TEXT NOT NULL,
        availability TEXT NOT NULL CHECK (availability IN ('available', 'tombstone', 'stale')),
        fingerprint_algorithm TEXT,
        fingerprint_digest TEXT,
        fingerprint_state TEXT NOT NULL CHECK (fingerprint_state IN ('pending', 'ready', 'failed')),
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        metadata_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(node_id, local_source_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS federated_sources_item ON federated_sources(item_id, availability);
      CREATE INDEX IF NOT EXISTS federated_sources_fingerprint
        ON federated_sources(fingerprint_algorithm, fingerprint_digest, byte_length)
        WHERE fingerprint_state = 'ready' AND availability = 'available';

      CREATE TABLE IF NOT EXISTS federated_replicas (
        fingerprint_key TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES federated_sources(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (fingerprint_key, source_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS federated_dedupe_overrides (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('merge', 'split')),
        left_origin TEXT NOT NULL,
        right_origin TEXT NOT NULL,
        target_item_id TEXT REFERENCES federated_items(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(left_origin, right_origin)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS federated_dedupe_conflicts (
        id TEXT PRIMARY KEY,
        candidate_signature TEXT NOT NULL,
        left_item_id TEXT NOT NULL REFERENCES federated_items(id) ON DELETE CASCADE,
        right_item_id TEXT NOT NULL REFERENCES federated_items(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(left_item_id, right_item_id)
      ) STRICT;

      CREATE TRIGGER IF NOT EXISTS cluster_manifest_source_insert AFTER INSERT ON media_sources BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS cluster_manifest_source_update AFTER UPDATE ON media_sources BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS cluster_manifest_source_delete AFTER DELETE ON media_sources BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS cluster_manifest_item_update AFTER UPDATE ON media_items BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS cluster_manifest_external_insert AFTER INSERT ON media_external_ids BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS cluster_manifest_external_update AFTER UPDATE ON media_external_ids BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS cluster_manifest_external_delete AFTER DELETE ON media_external_ids BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS cluster_manifest_fingerprint_update AFTER UPDATE ON media_source_fingerprints BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS cluster_manifest_probe_insert AFTER INSERT ON media_probe_results BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS cluster_manifest_probe_update AFTER UPDATE ON media_probe_results BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS cluster_manifest_stream_insert AFTER INSERT ON media_streams BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS cluster_manifest_stream_delete AFTER DELETE ON media_streams BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS cluster_manifest_rendition_insert AFTER INSERT ON media_renditions BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS cluster_manifest_rendition_update AFTER UPDATE ON media_renditions BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS cluster_manifest_rendition_delete AFTER DELETE ON media_renditions BEGIN
        UPDATE cluster_local_manifest_state SET revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE singleton = 1;
      END;
    `);
  }
});
