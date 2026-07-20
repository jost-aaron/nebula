const parseJson = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const transaction = (database, action) => {
  database.exec("BEGIN IMMEDIATE");
  try { const result = action(); database.exec("COMMIT"); return result; }
  catch (error) { database.exec("ROLLBACK"); throw error; }
};
const defaultControls = Object.freeze({ maintenanceDrain: false, maxConcurrentStreams: null, maxConcurrentTranscodes: null, priority: 0, updatedAt: null });
const publicNode = (row) => row ? ({
  capabilities: parseJson(row.capabilities_json, {}), endpoint: row.endpoint, keyVersion: row.key_version,
  advertisedName: row.name, controls: row.controls_node_id ? {
    maintenanceDrain: row.maintenance_drain === 1,
    maxConcurrentStreams: row.max_concurrent_streams,
    maxConcurrentTranscodes: row.max_concurrent_transcodes,
    priority: row.priority,
    updatedAt: row.controls_updated_at
  } : defaultControls,
  name: row.display_name ?? row.name, nodeId: row.node_id, publicKey: row.public_key, role: row.role, state: row.state,
  clusterId: row.cluster_id, pairedAt: row.paired_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at
}) : null;
const identityRotation = (row) => row ? ({
  activatedAt: row.activated_at, completedAt: row.completed_at, createdAt: row.created_at,
  expiresAt: row.expires_at, newKeyVersion: row.new_key_version, newPrivateJwk: parseJson(row.new_private_jwk_json, null),
  newPublicKey: row.new_public_key, nodeId: row.node_id, oldKeyVersion: row.old_key_version,
  oldPrivateJwk: parseJson(row.old_private_jwk_json, null), oldPublicKey: row.old_public_key,
  rotationId: row.rotation_id, state: row.state, updatedAt: row.updated_at
}) : null;
const peerRotation = (row) => row ? ({
  committedAt: row.committed_at, expiresAt: row.expires_at, newKeyVersion: row.new_key_version,
  newPublicKey: row.new_public_key, nodeId: row.node_id, oldKeyVersion: row.old_key_version,
  oldPublicKey: row.old_public_key, preparedAt: row.prepared_at, rotationId: row.rotation_id,
  state: row.state, updatedAt: row.updated_at
}) : null;

export const createClusterRepository = (database, { now = () => new Date().toISOString() } = {}) => {
  if (!database?.prepare) throw new TypeError("A SQLite database is required.");
  const hasOperations = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cluster_node_controls'").get());
  const hasKeyRotation = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cluster_node_key_rotations'").get());
  const nodeSelect = hasOperations ? `SELECT cluster_nodes.*, cluster_node_controls.node_id AS controls_node_id,
    cluster_node_controls.display_name, cluster_node_controls.priority,
    cluster_node_controls.max_concurrent_streams, cluster_node_controls.max_concurrent_transcodes,
    cluster_node_controls.maintenance_drain, cluster_node_controls.updated_at AS controls_updated_at
    FROM cluster_nodes LEFT JOIN cluster_node_controls USING (node_id)`
    : `SELECT cluster_nodes.*, NULL AS controls_node_id, NULL AS display_name FROM cluster_nodes`;
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
    beginIdentityRotation(rotation, peerNodeIds) {
      return transaction(database, () => {
        const timestamp = now();
        database.prepare(`INSERT INTO cluster_identity_rotations
          (rotation_id, node_id, old_key_version, new_key_version, old_public_key, old_private_jwk_json,
           new_public_key, new_private_jwk_json, state, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?)`)
          .run(rotation.rotationId, rotation.nodeId, rotation.oldKeyVersion, rotation.newKeyVersion,
            rotation.oldPublicKey, JSON.stringify(rotation.oldPrivateJwk), rotation.newPublicKey,
            JSON.stringify(rotation.newPrivateJwk), rotation.expiresAt, timestamp, timestamp);
        const insertPeer = database.prepare(`INSERT INTO cluster_identity_rotation_peers
          (rotation_id, node_id, state, updated_at) VALUES (?, ?, 'pending', ?)`);
        for (const nodeId of peerNodeIds) insertPeer.run(rotation.rotationId, nodeId, timestamp);
        return this.getIdentityRotation(rotation.rotationId);
      });
    },
    getIdentityRotation(rotationId) {
      return identityRotation(database.prepare("SELECT * FROM cluster_identity_rotations WHERE rotation_id = ?").get(rotationId));
    },
    getOpenIdentityRotation() {
      return identityRotation(database.prepare("SELECT * FROM cluster_identity_rotations WHERE state IN ('preparing', 'active') ORDER BY created_at DESC LIMIT 1").get());
    },
    listIdentityRotationPeers(rotationId) {
      return database.prepare("SELECT * FROM cluster_identity_rotation_peers WHERE rotation_id = ? ORDER BY node_id").all(rotationId).map((row) => ({
        committedAt: row.committed_at, nodeId: row.node_id, preparedAt: row.prepared_at,
        rotationId: row.rotation_id, state: row.state, updatedAt: row.updated_at
      }));
    },
    markIdentityRotationPeer(rotationId, nodeId, state) {
      const timestamp = now();
      const column = state === "prepared" ? "prepared_at" : state === "committed" ? "committed_at" : null;
      if (!column) throw new TypeError("Unsupported rotation peer state.");
      const result = database.prepare(`UPDATE cluster_identity_rotation_peers SET state = ?, ${column} = ?, updated_at = ?
        WHERE rotation_id = ? AND node_id = ? AND state != 'committed'`).run(state, timestamp, timestamp, rotationId, nodeId);
      return result.changes === 1;
    },
    activateIdentityRotation(rotationId) {
      return transaction(database, () => {
        const timestamp = now();
        const rotation = this.getIdentityRotation(rotationId);
        if (!rotation || rotation.state !== "preparing") return null;
        const pending = database.prepare("SELECT COUNT(*) AS count FROM cluster_identity_rotation_peers WHERE rotation_id = ? AND state != 'prepared'").get(rotationId).count;
        if (pending !== 0) return null;
        const updated = database.prepare(`UPDATE cluster_identity SET public_key = ?, private_jwk_json = ?, key_version = ?, updated_at = ?
          WHERE singleton = 1 AND node_id = ? AND public_key = ? AND key_version = ?`)
          .run(rotation.newPublicKey, JSON.stringify(rotation.newPrivateJwk), rotation.newKeyVersion, timestamp,
            rotation.nodeId, rotation.oldPublicKey, rotation.oldKeyVersion);
        if (updated.changes !== 1) return null;
        const localNode = database.prepare(`UPDATE cluster_nodes SET public_key = ?, key_version = ?, updated_at = ?
          WHERE node_id = ? AND public_key = ? AND key_version = ? AND state != 'revoked'`)
          .run(rotation.newPublicKey, rotation.newKeyVersion, timestamp,
            rotation.nodeId, rotation.oldPublicKey, rotation.oldKeyVersion);
        if (localNode.changes !== 1) throw new Error("The local cluster identity projection could not be rotated atomically.");
        database.prepare("UPDATE cluster_identity_rotations SET state = 'active', activated_at = ?, updated_at = ? WHERE rotation_id = ?")
          .run(timestamp, timestamp, rotationId);
        return this.getIdentityRotation(rotationId);
      });
    },
    completeIdentityRotation(rotationId) {
      return transaction(database, () => {
        const timestamp = now();
        const rotation = this.getIdentityRotation(rotationId);
        if (!rotation || rotation.state !== "active") return false;
        const pending = database.prepare("SELECT COUNT(*) AS count FROM cluster_identity_rotation_peers WHERE rotation_id = ? AND state != 'committed'").get(rotationId).count;
        if (pending !== 0) return false;
        database.prepare(`UPDATE cluster_identity_rotations
          SET state = 'completed', old_private_jwk_json = NULL, new_private_jwk_json = NULL,
              completed_at = ?, updated_at = ? WHERE rotation_id = ?`).run(timestamp, timestamp, rotationId);
        return true;
      });
    },
    prepareNodeKeyRotation(rotation) {
      return transaction(database, () => {
        const timestamp = now();
        const node = this.getNode(rotation.nodeId);
        if (!node || node.state === "revoked") return { code: "untrusted_node" };
        const existing = this.getNodeKeyRotation(rotation.nodeId, rotation.rotationId);
        if (existing) {
          const same = existing.oldKeyVersion === rotation.oldKeyVersion && existing.newKeyVersion === rotation.newKeyVersion
            && existing.oldPublicKey === rotation.oldPublicKey && existing.newPublicKey === rotation.newPublicKey
            && existing.expiresAt === rotation.expiresAt;
          return same && existing.state === "prepared" ? { rotation: existing } : { code: "rotation_replayed" };
        }
        if (node.keyVersion !== rotation.oldKeyVersion || node.publicKey !== rotation.oldPublicKey
          || rotation.newKeyVersion !== node.keyVersion + 1 || rotation.newPublicKey === node.publicKey) {
          return { code: "rotation_key_mismatch" };
        }
        database.prepare("UPDATE cluster_node_key_rotations SET state = 'expired', updated_at = ? WHERE node_id = ? AND state = 'prepared' AND expires_at <= ?")
          .run(timestamp, rotation.nodeId, timestamp);
        const open = database.prepare("SELECT 1 FROM cluster_node_key_rotations WHERE node_id = ? AND state = 'prepared'").get(rotation.nodeId);
        if (open) return { code: "rotation_in_progress" };
        database.prepare(`INSERT INTO cluster_node_key_rotations
          (node_id, rotation_id, old_key_version, new_key_version, old_public_key, new_public_key,
           state, expires_at, prepared_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)`)
          .run(rotation.nodeId, rotation.rotationId, rotation.oldKeyVersion, rotation.newKeyVersion,
            rotation.oldPublicKey, rotation.newPublicKey, rotation.expiresAt, timestamp, timestamp);
        return { rotation: this.getNodeKeyRotation(rotation.nodeId, rotation.rotationId) };
      });
    },
    getNodeKeyRotation(nodeId, rotationId) {
      return peerRotation(database.prepare("SELECT * FROM cluster_node_key_rotations WHERE node_id = ? AND rotation_id = ?").get(nodeId, rotationId));
    },
    getPreparedNodeKeyRotation(nodeId) {
      if (!hasKeyRotation) return null;
      return peerRotation(database.prepare("SELECT * FROM cluster_node_key_rotations WHERE node_id = ? AND state = 'prepared' ORDER BY prepared_at DESC LIMIT 1").get(nodeId));
    },
    commitNodeKeyRotation(nodeId, rotationId) {
      return transaction(database, () => {
        const timestamp = now();
        const rotation = this.getNodeKeyRotation(nodeId, rotationId);
        if (!rotation || rotation.state !== "prepared" || Date.parse(rotation.expiresAt) <= Date.parse(timestamp)) return null;
        const updated = database.prepare(`UPDATE cluster_nodes SET public_key = ?, key_version = ?, updated_at = ?
          WHERE node_id = ? AND public_key = ? AND key_version = ? AND state != 'revoked'`)
          .run(rotation.newPublicKey, rotation.newKeyVersion, timestamp, nodeId, rotation.oldPublicKey, rotation.oldKeyVersion);
        if (updated.changes !== 1) return null;
        database.prepare(`UPDATE cluster_node_key_rotations SET state = 'committed', committed_at = ?, updated_at = ?
          WHERE node_id = ? AND rotation_id = ?`).run(timestamp, timestamp, nodeId, rotationId);
        return this.getNodeKeyRotation(nodeId, rotationId);
      });
    },
    getNode(nodeId) { return publicNode(database.prepare(`${nodeSelect} WHERE cluster_nodes.node_id = ?`).get(nodeId)); },
    listNodes({ includeRevoked = false } = {}) {
      const rows = includeRevoked
        ? database.prepare(`${nodeSelect} ORDER BY COALESCE(display_name, name) COLLATE NOCASE, cluster_nodes.node_id`).all()
        : database.prepare(`${nodeSelect} WHERE state != 'revoked' ORDER BY COALESCE(display_name, name) COLLATE NOCASE, cluster_nodes.node_id`).all();
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
    updateNodeControls(nodeId, controls) {
      if (!hasOperations) throw new Error("Cluster operations migration is required.");
      const timestamp = now();
      database.prepare(`INSERT INTO cluster_node_controls
        (node_id, display_name, priority, max_concurrent_streams, max_concurrent_transcodes, maintenance_drain, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET display_name = excluded.display_name, priority = excluded.priority,
          max_concurrent_streams = excluded.max_concurrent_streams,
          max_concurrent_transcodes = excluded.max_concurrent_transcodes,
          maintenance_drain = excluded.maintenance_drain, updated_at = excluded.updated_at`)
        .run(nodeId, controls.displayName, controls.priority, controls.maxConcurrentStreams,
          controls.maxConcurrentTranscodes, controls.maintenanceDrain ? 1 : 0, timestamp);
      return this.getNode(nodeId);
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
