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
