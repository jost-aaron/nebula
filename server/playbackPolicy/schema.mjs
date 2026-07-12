export const playbackPolicyMigration = Object.freeze({
  domain: "playback-policy",
  id: "playback-policy-v1",
  version: 1,
  apply(database) {
    database.exec(`CREATE TABLE playback_policy_config (
      scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'user')),
      scope_id TEXT NOT NULL,
      max_concurrent_streams INTEGER CHECK (max_concurrent_streams IS NULL OR max_concurrent_streams BETWEEN 1 AND 100),
      max_bitrate INTEGER CHECK (max_bitrate IS NULL OR max_bitrate BETWEEN 64000 AND 1000000000),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_type, scope_id),
      CHECK ((scope_type = 'global' AND scope_id = 'global') OR (scope_type = 'user' AND length(scope_id) > 0))
    ) STRICT;
    CREATE INDEX playback_policy_users ON playback_policy_config(scope_type, scope_id);`);
  }
});
