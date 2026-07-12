export const LIBRARY_PERMISSIONS_SCHEMA_VERSION = 1;

export const libraryPermissionsMigration = Object.freeze({
  domain: "library-permissions",
  version: LIBRARY_PERMISSIONS_SCHEMA_VERSION,
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS user_media_access_policies (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        access_mode TEXT NOT NULL DEFAULT 'all' CHECK (access_mode IN ('all', 'selected')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS user_library_permissions (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        library_id TEXT NOT NULL REFERENCES media_libraries(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, library_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS user_library_permissions_by_library
        ON user_library_permissions(library_id, user_id);
    `);
  }
});

export const applyLibraryPermissionsMigration = (database) => libraryPermissionsMigration.apply(database);
