import { randomUUID } from "node:crypto";

const fail = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });
const bad = (message) => fail(400, "invalid_media_list", message);
const missing = () => fail(404, "media_list_not_found", "Media list not found.");
const identity = (principal) => ({
  isOwner: principal?.kind === "service" || principal?.user?.role === "owner" || principal?.role === "owner",
  userId: principal?.kind === "account" ? principal.principalId
    : principal?.type === "user" ? principal.userId
      : principal?.user?.id ?? null
});
const cleanName = (value) => {
  if (typeof value !== "string") throw bad("name must be a string.");
  const name = value.trim();
  if (!name || [...name].length > 80) throw bad("name must contain 1 to 80 characters.");
  return name;
};
const parseKind = (value, type) => {
  const allowed = type === "playlist" ? ["video", "audio"] : ["video", "audio", "mixed"];
  if (!allowed.includes(value)) throw bad(`mediaKind must be ${allowed.join(", ")}.`);
  return value;
};
const transaction = (db, work) => {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
};

export const createMediaListsService = ({ database, permissions, now = () => new Date().toISOString(), uuid = randomUUID }) => {
  const rawList = (id) => database.prepare("SELECT * FROM media_lists WHERE id = ?").get(id) ?? null;
  const canManage = (row, principal) => {
    const actor = identity(principal);
    return row.list_type === "collection" ? actor.isOwner : Boolean(actor.userId && actor.userId === row.owner_user_id);
  };
  const canRead = (row, principal) => row.list_type === "collection" || canManage(row, principal);
  const itemRows = (listId) => database.prepare(`SELECT i.id, i.library_id, i.media_kind, i.title, li.position,
      CASE WHEN EXISTS (SELECT 1 FROM media_sources s WHERE s.item_id = i.id AND s.availability = 'available') THEN 1 ELSE 0 END AS available
    FROM media_list_items li JOIN media_items i ON i.id = li.media_item_id
    WHERE li.list_id = ? ORDER BY li.position`).all(listId);
  const visibleItems = (row, principal) => itemRows(row.id).filter((item) => permissions.canAccessLibrary(principal, item.library_id));
  const present = (row, principal) => {
    const items = visibleItems(row, principal).map((item) => ({
      available: Boolean(item.available), id: item.id, mediaKind: item.media_kind,
      position: item.position, title: item.title
    }));
    return { createdAt: row.created_at, id: row.id, itemCount: items.length, items,
      mediaKind: row.media_kind, name: row.name, type: row.list_type, updatedAt: row.updated_at };
  };
  const getVisible = (id, principal, expectedType) => {
    const row = rawList(id);
    if (!row || row.list_type !== expectedType || !canRead(row, principal)) throw missing();
    return row;
  };
  const validateItem = (itemId, row, principal) => {
    const item = database.prepare("SELECT id, library_id, media_kind FROM media_items WHERE id = ?").get(itemId);
    if (!item || !permissions.canAccessLibrary(principal, item.library_id)) throw fail(404, "media_item_not_found", "Media item not found.");
    if (row.media_kind !== "mixed" && item.media_kind !== row.media_kind) throw bad("Media item kind does not match this list.");
    return item;
  };

  const list = ({ type, mediaKind }, principal) => {
    const actor = identity(principal);
    const rows = type === "playlist"
      ? (actor.userId ? database.prepare("SELECT * FROM media_lists WHERE list_type = 'playlist' AND owner_user_id = ? AND (? IS NULL OR media_kind = ?) ORDER BY updated_at DESC, name COLLATE NOCASE").all(actor.userId, mediaKind ?? null, mediaKind ?? null) : [])
      : database.prepare("SELECT * FROM media_lists WHERE list_type = 'collection' AND (? IS NULL OR media_kind IN (?, 'mixed')) ORDER BY updated_at DESC, name COLLATE NOCASE").all(mediaKind ?? null, mediaKind ?? null);
    return rows.map((row) => present(row, principal));
  };
  const create = ({ mediaKind, name, type }, principal) => {
    const actor = identity(principal);
    if (type === "playlist" && !actor.userId) throw fail(403, "account_required", "An account is required.");
    if (type === "collection" && !actor.isOwner) throw fail(403, "permission_denied", "Owner access is required.");
    const timestamp = now();
    const row = { id: uuid(), list_type: type, owner_user_id: type === "playlist" ? actor.userId : null,
      name: cleanName(name), media_kind: parseKind(mediaKind, type), created_at: timestamp, updated_at: timestamp };
    database.prepare("INSERT INTO media_lists (id, list_type, owner_user_id, name, media_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.list_type, row.owner_user_id, row.name, row.media_kind, timestamp, timestamp);
    return present(row, principal);
  };
  const rename = (id, type, name, principal) => {
    const row = getVisible(id, principal, type);
    if (!canManage(row, principal)) throw fail(403, "permission_denied", "You cannot change this media list.");
    database.prepare("UPDATE media_lists SET name = ?, updated_at = ? WHERE id = ?").run(cleanName(name), now(), id);
    return present(rawList(id), principal);
  };
  const remove = (id, type, principal) => {
    const row = getVisible(id, principal, type);
    if (!canManage(row, principal)) throw fail(403, "permission_denied", "You cannot change this media list.");
    database.prepare("DELETE FROM media_lists WHERE id = ?").run(id);
  };
  const addItem = (id, type, itemId, principal) => transaction(database, () => {
    const row = getVisible(id, principal, type);
    if (!canManage(row, principal)) throw fail(403, "permission_denied", "You cannot change this media list.");
    validateItem(itemId, row, principal);
    if (database.prepare("SELECT 1 FROM media_list_items WHERE list_id = ? AND media_item_id = ?").get(id, itemId)) throw fail(409, "duplicate_media_item", "The item is already in this list.");
    const position = database.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM media_list_items WHERE list_id = ?").get(id).position;
    const timestamp = now();
    database.prepare("INSERT INTO media_list_items (list_id, media_item_id, position, added_at) VALUES (?, ?, ?, ?)").run(id, itemId, position, timestamp);
    database.prepare("UPDATE media_lists SET updated_at = ? WHERE id = ?").run(timestamp, id);
    return present(rawList(id), principal);
  });
  const removeItem = (id, type, itemId, principal) => transaction(database, () => {
    const row = getVisible(id, principal, type);
    if (!canManage(row, principal)) throw fail(403, "permission_denied", "You cannot change this media list.");
    const result = database.prepare("DELETE FROM media_list_items WHERE list_id = ? AND media_item_id = ?").run(id, itemId);
    if (!result.changes) throw fail(404, "media_item_not_found", "Media item not found.");
    const remaining = database.prepare("SELECT media_item_id FROM media_list_items WHERE list_id = ? ORDER BY position").all(id);
    const update = database.prepare("UPDATE media_list_items SET position = ? WHERE list_id = ? AND media_item_id = ?");
    remaining.forEach((item, position) => update.run(position, id, item.media_item_id));
    database.prepare("UPDATE media_lists SET updated_at = ? WHERE id = ?").run(now(), id);
    return present(rawList(id), principal);
  });
  const reorder = (id, type, itemIds, principal) => transaction(database, () => {
    const row = getVisible(id, principal, type);
    if (!canManage(row, principal)) throw fail(403, "permission_denied", "You cannot change this media list.");
    if (!Array.isArray(itemIds) || new Set(itemIds).size !== itemIds.length || itemIds.some((value) => typeof value !== "string")) throw bad("itemIds must be a duplicate-free array.");
    const current = itemRows(id).map(({ id: itemId }) => itemId);
    if (current.length !== itemIds.length || current.some((itemId) => !itemIds.includes(itemId))) throw bad("itemIds must contain every current list item exactly once.");
    const shift = current.length + 1;
    database.prepare("UPDATE media_list_items SET position = position + ? WHERE list_id = ?").run(shift, id);
    const update = database.prepare("UPDATE media_list_items SET position = ? WHERE list_id = ? AND media_item_id = ?");
    itemIds.forEach((itemId, position) => update.run(position, id, itemId));
    database.prepare("UPDATE media_lists SET updated_at = ? WHERE id = ?").run(now(), id);
    return present(rawList(id), principal);
  });
  return { addItem, create, get: (id, type, principal) => present(getVisible(id, principal, type), principal), list, remove, removeItem, rename, reorder };
};
