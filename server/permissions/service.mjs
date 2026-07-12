const notFound = () => Object.assign(new Error("Member account not found."), { status: 404, expose: true });
const badRequest = (message) => Object.assign(new Error(message), { status: 400, expose: true });

const publicLibrary = (row) => ({
  id: row.id,
  mediaKind: row.media_kind,
  name: row.name
});

const principalIdentity = (database, principal) => {
  if (!principal) return { guest: false, service: false, userId: null, role: null };
  if (principal.kind === "guest" || (principal.kind === "media-ticket" && principal.principalType === "guest")) {
    return { guest: true, service: false, userId: null, role: "guest" };
  }
  if (principal.type === "service" || principal.kind === "service"
    || (principal.kind === "media-ticket" && principal.principalType === "service")) {
    return { guest: false, service: true, userId: null, role: "owner" };
  }
  const userId = principal.userId ?? principal.user?.id
    ?? (principal.kind === "media-ticket" && principal.principalType === "user" ? principal.principalId : null);
  if (!userId) return { service: false, userId: null, role: null };
  const role = principal.role ?? principal.user?.role
    ?? database.prepare("SELECT role FROM users WHERE id = ? AND disabled = 0").get(userId)?.role
    ?? null;
  return { guest: false, service: false, userId, role };
};

export const createLibraryPermissionsService = ({ database, now = () => new Date().toISOString() }) => {
  if (!database || typeof database.prepare !== "function") throw new TypeError("A SQLite database is required.");

  const listLibraries = () => database.prepare("SELECT id, name, media_kind FROM media_libraries ORDER BY name COLLATE NOCASE, id")
    .all().map(publicLibrary);

  const getPolicy = (userId) => {
    const row = database.prepare("SELECT access_mode FROM user_media_access_policies WHERE user_id = ?").get(userId);
    return row?.access_mode ?? "all";
  };

  const canAccessLibrary = (principal, libraryId) => {
    const identity = principalIdentity(database, principal);
    if (identity.guest || identity.service || identity.role === "owner") return true;
    if (identity.role !== "member" || !identity.userId) return false;
    if (getPolicy(identity.userId) === "all") return true;
    return Boolean(database.prepare("SELECT 1 FROM user_library_permissions WHERE user_id = ? AND library_id = ?")
      .get(identity.userId, libraryId));
  };

  const libraryIdForItem = (itemId) => database.prepare("SELECT library_id FROM media_items WHERE id = ?").get(itemId)?.library_id ?? null;
  const sourceForPath = (contentPath, mediaKind) => database.prepare(`
    SELECT s.id, s.item_id, i.library_id
    FROM media_sources s JOIN media_items i ON i.id = s.item_id
    WHERE s.content_path = ? AND s.media_kind = ? AND s.availability = 'available'
    ORDER BY s.created_at LIMIT 1
  `).get(contentPath, mediaKind) ?? null;

  const canAccessItem = (principal, itemId) => {
    const libraryId = libraryIdForItem(itemId);
    return Boolean(libraryId && canAccessLibrary(principal, libraryId));
  };

  const canAccessPath = (principal, contentPath, mediaKind) => {
    const identity = principalIdentity(database, principal);
    if (identity.guest || identity.service || identity.role === "owner") return true;
    if (identity.role !== "member" || !identity.userId) return false;
    if (getPolicy(identity.userId) === "all") return true;
    const sources = database.prepare(`
      SELECT DISTINCT i.library_id
      FROM media_sources s JOIN media_items i ON i.id = s.item_id
      WHERE s.content_path = ? AND s.media_kind = ? AND s.availability = 'available'
    `).all(contentPath, mediaKind);
    return sources.some(({ library_id }) => canAccessLibrary(principal, library_id));
  };

  const filterItems = (principal, items) => items.filter((item) => canAccessLibrary(principal, item.libraryId));

  const listAdministration = () => {
    const libraries = listLibraries();
    const allLibraryIds = libraries.map(({ id }) => id);
    const members = database.prepare("SELECT id, username, display_name, disabled FROM users WHERE role = 'member' ORDER BY display_name COLLATE NOCASE, id")
      .all().map((member) => {
        const mode = getPolicy(member.id);
        const libraryIds = mode === "all" ? allLibraryIds : database.prepare(
          "SELECT library_id FROM user_library_permissions WHERE user_id = ? ORDER BY library_id"
        ).all(member.id).map(({ library_id }) => library_id);
        return {
          disabled: Boolean(member.disabled),
          displayName: member.display_name,
          id: member.id,
          libraryIds,
          mode,
          username: member.username
        };
      });
    return { libraries, members };
  };

  const setMemberAccess = (userId, { libraryIds, mode }) => {
    const member = database.prepare("SELECT id FROM users WHERE id = ? AND role = 'member'").get(userId);
    if (!member) throw notFound();
    if (!new Set(["all", "selected"]).has(mode)) throw badRequest("mode must be all or selected.");
    if (!Array.isArray(libraryIds) || libraryIds.some((id) => typeof id !== "string")) {
      throw badRequest("libraryIds must be an array of library IDs.");
    }
    const selected = [...new Set(libraryIds)];
    const libraries = new Set(listLibraries().map(({ id }) => id));
    if (selected.some((id) => !libraries.has(id))) throw badRequest("One or more media libraries are invalid.");
    const timestamp = now();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`INSERT INTO user_media_access_policies (user_id, access_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET access_mode = excluded.access_mode, updated_at = excluded.updated_at`)
        .run(userId, mode, timestamp, timestamp);
      database.prepare("DELETE FROM user_library_permissions WHERE user_id = ?").run(userId);
      if (mode === "selected") {
        const insert = database.prepare("INSERT INTO user_library_permissions (user_id, library_id, created_at) VALUES (?, ?, ?)");
        for (const libraryId of selected) insert.run(userId, libraryId, timestamp);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return listAdministration().members.find(({ id }) => id === userId);
  };

  return { canAccessItem, canAccessLibrary, canAccessPath, filterItems, listAdministration, listLibraries, setMemberAccess, sourceForPath };
};
