const rowPolicy = (row) => row ? ({
  maxBitrate: row.max_bitrate === null ? null : Number(row.max_bitrate),
  maxConcurrentStreams: row.max_concurrent_streams === null ? null : Number(row.max_concurrent_streams)
}) : null;

export const createPlaybackPolicyRepository = (database, { now = () => new Date() } = {}) => {
  const get = (scopeType, scopeId) => rowPolicy(database.prepare(`SELECT max_bitrate, max_concurrent_streams
    FROM playback_policy_config WHERE scope_type = ? AND scope_id = ?`).get(scopeType, scopeId));
  const set = (scopeType, scopeId, policy) => {
    database.prepare(`INSERT INTO playback_policy_config
      (scope_type, scope_id, max_concurrent_streams, max_bitrate, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope_type, scope_id) DO UPDATE SET
        max_concurrent_streams = excluded.max_concurrent_streams,
        max_bitrate = excluded.max_bitrate,
        updated_at = excluded.updated_at`)
      .run(scopeType, scopeId, policy.maxConcurrentStreams, policy.maxBitrate, now().toISOString());
    return get(scopeType, scopeId);
  };
  return {
    getGlobal: () => get("global", "global") ?? { maxBitrate: null, maxConcurrentStreams: null },
    getUser: (userId) => get("user", userId),
    listUsers: () => database.prepare(`SELECT u.id, u.username, u.display_name, u.disabled,
        p.scope_id AS policy_scope_id, p.max_bitrate, p.max_concurrent_streams
      FROM users u LEFT JOIN playback_policy_config p ON p.scope_type = 'user' AND p.scope_id = u.id
      ORDER BY CASE u.role WHEN 'owner' THEN 0 ELSE 1 END, lower(u.display_name), lower(u.username)`).all().map((row) => ({
        disabled: Boolean(row.disabled), displayName: row.display_name, id: row.id,
        policy: row.policy_scope_id ? rowPolicy(row) : null, username: row.username
      })),
    setGlobal: (policy) => set("global", "global", policy),
    setUser: (userId, policy) => {
      if (!database.prepare("SELECT 1 FROM users WHERE id = ?").get(userId)) return null;
      return set("user", userId, policy);
    }
  };
};
