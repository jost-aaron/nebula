const parseJson = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const transaction = (database, action) => {
  database.exec("BEGIN IMMEDIATE");
  try { const result = action(); database.exec("COMMIT"); return result; }
  catch (error) { database.exec("ROLLBACK"); throw error; }
};
const publicNode = (row) => row ? ({
  capabilities: parseJson(row.capabilities_json, {}), endpoint: row.endpoint, keyVersion: row.key_version,
  name: row.name, nodeId: row.node_id, publicKey: row.public_key, role: row.role, state: row.state,
  clusterId: row.cluster_id, pairedAt: row.paired_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at
}) : null;

export const createClusterRepository = (database, { now = () => new Date().toISOString() } = {}) => {
  if (!database?.prepare) throw new TypeError("A SQLite database is required.");
  return {
    getIdentity() {
      const row = database.prepare("SELECT * FROM cluster_identity WHERE singleton = 1").get();
      return row ? {
        clusterId: row.cluster_id, createdAt: row.created_at, endpoint: row.endpoint, keyVersion: row.key_version,
        name: row.name, nodeId: row.node_id, privateJwk: parseJson(row.private_jwk_json, null), publicKey: row.public_key,
        role: row.role, updatedAt: row.updated_at
      } : null;
    },
    createIdentity(identity) {
      const timestamp = now();
      database.prepare(`INSERT INTO cluster_identity
        (singleton, cluster_id, node_id, name, role, endpoint, public_key, private_jwk_json, key_version, created_at, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(identity.clusterId, identity.nodeId, identity.name, identity.role, identity.endpoint, identity.publicKey, JSON.stringify(identity.privateJwk), timestamp, timestamp);
      return this.getIdentity();
    },
    updateClusterId(clusterId) {
      database.prepare("UPDATE cluster_identity SET cluster_id = ?, updated_at = ? WHERE singleton = 1").run(clusterId, now());
      return this.getIdentity();
    },
    getNode(nodeId) { return publicNode(database.prepare("SELECT * FROM cluster_nodes WHERE node_id = ?").get(nodeId)); },
    listNodes({ includeRevoked = false } = {}) {
      const rows = includeRevoked
        ? database.prepare("SELECT * FROM cluster_nodes ORDER BY name COLLATE NOCASE, node_id").all()
        : database.prepare("SELECT * FROM cluster_nodes WHERE state != 'revoked' ORDER BY name COLLATE NOCASE, node_id").all();
      return rows.map(publicNode);
    },
    upsertNode(descriptor, clusterId) {
      const timestamp = now();
      database.prepare(`INSERT INTO cluster_nodes
        (node_id, cluster_id, name, role, endpoint, public_key, capabilities_json, state, key_version, paired_at, last_seen_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'online', 1, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET cluster_id = excluded.cluster_id, name = excluded.name, role = excluded.role,
          endpoint = excluded.endpoint, public_key = excluded.public_key, capabilities_json = excluded.capabilities_json,
          state = 'online', last_seen_at = excluded.last_seen_at, revoked_at = NULL, updated_at = excluded.updated_at`)
        .run(descriptor.nodeId, clusterId, descriptor.name, descriptor.role, descriptor.endpoint, descriptor.publicKey,
          JSON.stringify(descriptor.capabilities), timestamp, timestamp, timestamp);
      return this.getNode(descriptor.nodeId);
    },
    revokeNode(nodeId) {
      const timestamp = now();
      const result = database.prepare("UPDATE cluster_nodes SET state = 'revoked', revoked_at = ?, updated_at = ? WHERE node_id = ? AND state != 'revoked'").run(timestamp, timestamp, nodeId);
      database.prepare("DELETE FROM cluster_request_nonces WHERE node_id = ?").run(nodeId);
      return result.changes > 0;
    },
    createPairingCode(codeHash, expiresAt) {
      const timestamp = now();
      database.prepare("DELETE FROM cluster_pairing_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(timestamp);
      database.prepare("INSERT INTO cluster_pairing_codes (code_hash, expires_at, created_at) VALUES (?, ?, ?)").run(codeHash, expiresAt, timestamp);
    },
    consumePairingCode(codeHash) {
      return transaction(database, () => {
        const timestamp = now();
        const row = database.prepare("SELECT * FROM cluster_pairing_codes WHERE code_hash = ?").get(codeHash);
        if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.parse(timestamp)) return false;
        const result = database.prepare("UPDATE cluster_pairing_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL").run(timestamp, codeHash);
        return result.changes === 1;
      });
    },
    consumeNonce(nodeId, nonce, expiresAt) {
      return transaction(database, () => {
        const timestamp = now();
        database.prepare("DELETE FROM cluster_request_nonces WHERE expires_at <= ?").run(timestamp);
        try {
          database.prepare("INSERT INTO cluster_request_nonces (node_id, nonce, expires_at, created_at) VALUES (?, ?, ?, ?)").run(nodeId, nonce, expiresAt, timestamp);
          return true;
        } catch (error) {
          if (String(error?.message).includes("UNIQUE constraint failed")) return false;
          throw error;
        }
      });
    }
  };
};
