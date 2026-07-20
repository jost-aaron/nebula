export const CLUSTER_SCHEMA_VERSION = 1;

export const clusterMigration = Object.freeze({
  domain: "cluster",
  version: CLUSTER_SCHEMA_VERSION,
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS cluster_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        cluster_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('coordinator', 'shard', 'hybrid')),
        endpoint TEXT NOT NULL,
        public_key TEXT NOT NULL,
        private_jwk_json TEXT NOT NULL,
        key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS cluster_nodes (
        node_id TEXT PRIMARY KEY,
        cluster_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('coordinator', 'shard', 'hybrid')),
        endpoint TEXT NOT NULL,
        public_key TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'online' CHECK (state IN ('online', 'stale', 'offline', 'draining', 'revoked')),
        key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
        paired_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS cluster_pairing_codes (
        code_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS cluster_request_nonces (
        node_id TEXT NOT NULL REFERENCES cluster_nodes(node_id) ON DELETE CASCADE,
        nonce TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (node_id, nonce)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS cluster_nodes_by_state ON cluster_nodes(state, name);
      CREATE INDEX IF NOT EXISTS cluster_pairing_codes_expiry ON cluster_pairing_codes(expires_at);
      CREATE INDEX IF NOT EXISTS cluster_request_nonces_expiry ON cluster_request_nonces(expires_at);
    `);
  }
});

export const CLUSTER_KEY_ROTATION_SCHEMA_VERSION = 2;

export const clusterKeyRotationMigration = Object.freeze({
  domain: "cluster-key-rotation",
  version: CLUSTER_KEY_ROTATION_SCHEMA_VERSION,
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS cluster_identity_rotations (
        rotation_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        old_key_version INTEGER NOT NULL CHECK (old_key_version > 0),
        new_key_version INTEGER NOT NULL CHECK (new_key_version = old_key_version + 1),
        old_public_key TEXT NOT NULL,
        old_private_jwk_json TEXT,
        new_public_key TEXT NOT NULL,
        new_private_jwk_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('preparing', 'active', 'completed', 'failed')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS cluster_identity_rotation_peers (
        rotation_id TEXT NOT NULL REFERENCES cluster_identity_rotations(rotation_id) ON DELETE CASCADE,
        node_id TEXT NOT NULL REFERENCES cluster_nodes(node_id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('pending', 'prepared', 'committed')),
        prepared_at TEXT,
        committed_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (rotation_id, node_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS cluster_node_key_rotations (
        node_id TEXT NOT NULL REFERENCES cluster_nodes(node_id) ON DELETE CASCADE,
        rotation_id TEXT NOT NULL,
        old_key_version INTEGER NOT NULL CHECK (old_key_version > 0),
        new_key_version INTEGER NOT NULL CHECK (new_key_version = old_key_version + 1),
        old_public_key TEXT NOT NULL,
        new_public_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'committed', 'expired')),
        expires_at TEXT NOT NULL,
        prepared_at TEXT NOT NULL,
        committed_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (node_id, rotation_id)
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS cluster_identity_rotation_open
        ON cluster_identity_rotations(node_id) WHERE state IN ('preparing', 'active');
      CREATE UNIQUE INDEX IF NOT EXISTS cluster_node_key_rotation_open
        ON cluster_node_key_rotations(node_id) WHERE state = 'prepared';
      CREATE INDEX IF NOT EXISTS cluster_identity_rotation_peers_state
        ON cluster_identity_rotation_peers(rotation_id, state);
    `);
  }
});
