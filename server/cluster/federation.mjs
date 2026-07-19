import { randomUUID } from "node:crypto";
import { validateClusterManifestPage } from "./protocol.mjs";

const transaction = (database, action) => {
  database.exec("BEGIN IMMEDIATE");
  try { const result = action(); database.exec("COMMIT"); return result; }
  catch (error) { database.exec("ROLLBACK"); throw error; }
};
const normalize = (value) => String(value ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const candidateSignature = (source) => [source.mediaKind, source.itemKind, normalize(source.title), source.year ?? ""].join(":");
const origin = (nodeId, localItemId) => `${nodeId}:${localItemId}`;
const providerKey = (source) => {
  if (source.itemKind === "episode") return null;
  const external = [...source.externalIds].sort((a, b) => `${a.provider}:${a.mediaType}:${a.providerItemId}`.localeCompare(`${b.provider}:${b.mediaType}:${b.providerItemId}`))[0];
  return external ? `provider:${normalize(external.provider)}:${normalize(external.mediaType)}:${external.providerItemId}:${source.itemKind}` : null;
};
const fingerprintKey = (source) => source.fingerprint.state === "ready"
  ? `${source.fingerprint.algorithm}:${source.fingerprint.digest}:${source.sizeBytes}` : null;

export const createFederatedCatalogRepository = (database, { now = () => new Date().toISOString(), uuid = randomUUID } = {}) => {
  const getItemForSource = (nodeId, source) => {
    const exact = fingerprintKey(source);
    if (exact) {
      const row = database.prepare(`SELECT fs.item_id FROM federated_replicas r JOIN federated_sources fs ON fs.id = r.source_id
        WHERE r.fingerprint_key = ? AND fs.availability = 'available' ORDER BY fs.first_seen_at LIMIT 1`).get(exact);
      if (row) return { automaticKey: null, itemId: row.item_id };
    }
    const existingOrigin = database.prepare("SELECT item_id FROM federated_sources WHERE node_id = ? AND local_item_id = ? ORDER BY first_seen_at LIMIT 1").get(nodeId, source.localItemId);
    if (existingOrigin) return { automaticKey: null, itemId: existingOrigin.item_id };
    const automaticKey = providerKey(source);
    if (automaticKey) {
      const row = database.prepare("SELECT id FROM federated_items WHERE automatic_key = ? AND merged_into_id IS NULL").get(automaticKey);
      if (row) return { automaticKey, itemId: row.id };
    }
    return { automaticKey, itemId: null };
  };

  const ensureItem = (nodeId, source) => {
    const resolved = getItemForSource(nodeId, source);
    if (resolved.itemId) return resolved.itemId;
    const id = `fitem_${uuid().replaceAll("-", "")}`;
    const timestamp = now();
    const signature = candidateSignature(source);
    database.prepare(`INSERT INTO federated_items
      (id, media_kind, item_kind, title, year, automatic_key, candidate_signature, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, source.mediaKind, source.itemKind, source.title, source.year, resolved.automaticKey, signature, timestamp, timestamp);
    const ambiguous = database.prepare(`SELECT id FROM federated_items WHERE candidate_signature = ? AND id != ?
      AND merged_into_id IS NULL ORDER BY id`).all(signature, id);
    for (const other of ambiguous) {
      const [left, right] = [id, other.id].sort();
      database.prepare(`INSERT OR IGNORE INTO federated_dedupe_conflicts
        (id, candidate_signature, left_item_id, right_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(`conflict_${uuid().replaceAll("-", "")}`, signature, left, right, timestamp, timestamp);
    }
    return id;
  };

  const applyManifestPage = ({ nodeId, page, syncGeneration = `sync_${uuid().replaceAll("-", "")}` }) => transaction(database, () => {
    const value = validateClusterManifestPage(page);
    if (value.nodeId !== nodeId) throw Object.assign(new Error("Manifest node identity does not match the trusted peer."), { code: "manifest_node_mismatch", status: 409 });
    const trusted = database.prepare("SELECT state FROM cluster_nodes WHERE node_id = ?").get(nodeId);
    if (!trusted || trusted.state === "revoked") throw Object.assign(new Error("Manifest node is not trusted."), { code: "untrusted_node", status: 401 });
    const timestamp = now();
    for (const source of value.sources) {
      const prior = database.prepare("SELECT id, item_id, edition_id FROM federated_sources WHERE node_id = ? AND local_source_id = ?").get(nodeId, source.localSourceId);
      if (source.availability === "tombstone") {
        if (prior) database.prepare(`UPDATE federated_sources SET availability = 'tombstone', source_revision = ?, manifest_revision = ?,
          sync_generation = ?, last_seen_at = ? WHERE id = ?`).run(source.sourceRevision, value.manifestRevision, syncGeneration, timestamp, prior.id);
        continue;
      }
      const itemId = prior?.item_id ?? ensureItem(nodeId, source);
      let editionId = prior?.edition_id;
      if (!editionId) {
        editionId = `fedition_${uuid().replaceAll("-", "")}`;
        database.prepare(`INSERT INTO federated_editions (id, item_id, edition_key, created_at, updated_at)
          VALUES (?, ?, 'default', ?, ?) ON CONFLICT(item_id, edition_key) DO NOTHING`).run(editionId, itemId, timestamp, timestamp);
        editionId = database.prepare("SELECT id FROM federated_editions WHERE item_id = ? AND edition_key = 'default'").get(itemId).id;
      }
      const id = prior?.id ?? `fsource_${uuid().replaceAll("-", "")}`;
      const metadata = JSON.stringify({
        bitrate: source.bitrate, durationSeconds: source.durationSeconds, externalIds: source.externalIds,
        height: source.height, renditions: source.renditions, width: source.width
      });
      database.prepare(`INSERT INTO federated_sources
        (id, item_id, edition_id, node_id, local_item_id, local_source_id, source_revision, manifest_revision,
          sync_generation, availability, fingerprint_algorithm, fingerprint_digest, fingerprint_state, byte_length,
          metadata_json, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id, local_source_id) DO UPDATE SET item_id = excluded.item_id, edition_id = excluded.edition_id,
          local_item_id = excluded.local_item_id, source_revision = excluded.source_revision,
          manifest_revision = excluded.manifest_revision, sync_generation = excluded.sync_generation,
          availability = 'available', fingerprint_algorithm = excluded.fingerprint_algorithm,
          fingerprint_digest = excluded.fingerprint_digest, fingerprint_state = excluded.fingerprint_state,
          byte_length = excluded.byte_length, metadata_json = excluded.metadata_json, last_seen_at = excluded.last_seen_at`)
        .run(id, itemId, editionId, nodeId, source.localItemId, source.localSourceId, source.sourceRevision,
          value.manifestRevision, syncGeneration, source.fingerprint.algorithm, source.fingerprint.digest,
          source.fingerprint.state, source.sizeBytes, metadata, timestamp, timestamp);
      database.prepare("DELETE FROM federated_replicas WHERE source_id = ?").run(id);
      const exact = fingerprintKey(source);
      if (exact) database.prepare("INSERT INTO federated_replicas (fingerprint_key, source_id, created_at) VALUES (?, ?, ?)").run(exact, id, timestamp);
    }
    if (value.complete) database.prepare(`UPDATE federated_sources SET availability = 'stale'
      WHERE node_id = ? AND sync_generation != ? AND availability = 'available'`).run(nodeId, syncGeneration);
    database.prepare(`INSERT INTO cluster_manifest_cursors
      (node_id, manifest_revision, cursor, sync_generation, last_sync_at, last_complete_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET manifest_revision = excluded.manifest_revision,
      cursor = excluded.cursor, sync_generation = excluded.sync_generation, last_sync_at = excluded.last_sync_at,
      last_complete_at = COALESCE(excluded.last_complete_at, cluster_manifest_cursors.last_complete_at),
      last_error_code = NULL, updated_at = excluded.updated_at`)
      .run(nodeId, value.manifestRevision, value.cursor, syncGeneration, timestamp, value.complete ? timestamp : null, timestamp);
    return { complete: value.complete, cursor: value.cursor, manifestRevision: value.manifestRevision, syncGeneration };
  });

  const listItems = ({ mediaKind } = {}) => {
    const rows = database.prepare(`SELECT i.*, COUNT(s.id) AS source_count, COUNT(DISTINCT s.node_id) AS node_count
      FROM federated_items i JOIN federated_sources s ON s.item_id = i.id AND s.availability = 'available'
      WHERE i.merged_into_id IS NULL AND (? IS NULL OR i.media_kind = ?)
      GROUP BY i.id ORDER BY i.title, i.id`).all(mediaKind ?? null, mediaKind ?? null);
    return rows.map((row) => ({
      id: row.id, itemKind: row.item_kind, mediaKind: row.media_kind, nodeCount: row.node_count,
      sourceCount: row.source_count, title: row.title, year: row.year
    }));
  };
  const listConflicts = () => database.prepare(`SELECT id, candidate_signature AS candidateSignature,
    left_item_id AS leftItemId, right_item_id AS rightItemId, state FROM federated_dedupe_conflicts ORDER BY created_at, id`).all();

  const setOverride = ({ action, leftOrigin, rightOrigin }) => transaction(database, () => {
    if (!new Set(["merge", "split"]).has(action) || typeof leftOrigin !== "string" || typeof rightOrigin !== "string" || leftOrigin === rightOrigin) {
      throw Object.assign(new Error("A merge or split requires two distinct source origins."), { code: "invalid_dedupe_override", status: 400 });
    }
    const resolve = (value) => {
      const separator = value.indexOf(":");
      if (separator < 8) return null;
      return database.prepare("SELECT * FROM federated_sources WHERE node_id = ? AND local_item_id = ? ORDER BY first_seen_at LIMIT 1")
        .get(value.slice(0, separator), value.slice(separator + 1));
    };
    const left = resolve(leftOrigin); const right = resolve(rightOrigin);
    if (!left || !right) throw Object.assign(new Error("The dedupe override references an unknown source origin."), { code: "federated_origin_not_found", status: 404 });
    const timestamp = now();
    let targetItemId = left.item_id;
    if (action === "merge" && left.item_id !== right.item_id) {
      const edition = database.prepare("SELECT id FROM federated_editions WHERE item_id = ? AND edition_key = 'default'").get(left.item_id);
      database.prepare("UPDATE federated_sources SET item_id = ?, edition_id = ? WHERE item_id = ?").run(left.item_id, edition.id, right.item_id);
      database.prepare("UPDATE federated_items SET merged_into_id = ?, updated_at = ? WHERE id = ?").run(left.item_id, timestamp, right.item_id);
      database.prepare(`UPDATE federated_dedupe_conflicts SET state = 'resolved', updated_at = ?
        WHERE (left_item_id = ? AND right_item_id = ?) OR (left_item_id = ? AND right_item_id = ?)`)
        .run(timestamp, left.item_id, right.item_id, right.item_id, left.item_id);
    }
    if (action === "split" && left.item_id === right.item_id) {
      const original = database.prepare("SELECT * FROM federated_items WHERE id = ?").get(left.item_id);
      targetItemId = `fitem_${uuid().replaceAll("-", "")}`;
      database.prepare(`INSERT INTO federated_items
        (id, media_kind, item_kind, title, year, candidate_signature, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(targetItemId, original.media_kind, original.item_kind, original.title, original.year, original.candidate_signature, timestamp, timestamp);
      const editionId = `fedition_${uuid().replaceAll("-", "")}`;
      database.prepare("INSERT INTO federated_editions (id, item_id, edition_key, created_at, updated_at) VALUES (?, ?, 'default', ?, ?)")
        .run(editionId, targetItemId, timestamp, timestamp);
      const separator = rightOrigin.indexOf(":");
      database.prepare("UPDATE federated_sources SET item_id = ?, edition_id = ? WHERE node_id = ? AND local_item_id = ?")
        .run(targetItemId, editionId, rightOrigin.slice(0, separator), rightOrigin.slice(separator + 1));
    }
    const [storedLeft, storedRight] = [leftOrigin, rightOrigin].sort();
    database.prepare(`INSERT INTO federated_dedupe_overrides
      (id, action, left_origin, right_origin, target_item_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(left_origin, right_origin) DO UPDATE SET
      action = excluded.action, target_item_id = excluded.target_item_id, updated_at = excluded.updated_at`)
      .run(`override_${uuid().replaceAll("-", "")}`, action, storedLeft, storedRight, targetItemId, timestamp, timestamp);
    return { action, leftOrigin: storedLeft, rightOrigin: storedRight, targetItemId };
  });

  return { applyManifestPage, listConflicts, listItems, setOverride };
};
