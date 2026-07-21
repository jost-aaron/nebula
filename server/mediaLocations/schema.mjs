export const mediaLocationsMigration = Object.freeze({
  domain: "media-locations",
  version: 1,
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS media_locations (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('movies', 'tv', 'music')),
        content_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(category, content_path)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS media_locations_category ON media_locations(category, content_path);
    `);
  }
});
