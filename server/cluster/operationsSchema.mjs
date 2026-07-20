export const CLUSTER_OPERATIONS_SCHEMA_VERSION = 1;

export const clusterOperationsMigration = Object.freeze({
  domain: "cluster-operations",
  version: CLUSTER_OPERATIONS_SCHEMA_VERSION,
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS cluster_node_controls (
        node_id TEXT PRIMARY KEY REFERENCES cluster_nodes(node_id) ON DELETE CASCADE,
        display_name TEXT,
        priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
        max_concurrent_streams INTEGER CHECK (max_concurrent_streams IS NULL OR max_concurrent_streams BETWEEN 1 AND 100),
        max_concurrent_transcodes INTEGER CHECK (max_concurrent_transcodes IS NULL OR max_concurrent_transcodes BETWEEN 0 AND 32),
        maintenance_drain INTEGER NOT NULL DEFAULT 0 CHECK (maintenance_drain IN (0, 1)),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS cluster_node_controls_by_priority
        ON cluster_node_controls(maintenance_drain, priority DESC, node_id);
    `);
  }
});
