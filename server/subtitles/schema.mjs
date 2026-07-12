export const subtitleMigration = {
  id: "subtitles-v1",
  domain: "subtitles",
  version: 1,
  apply(database) {
    database.exec(`CREATE TABLE subtitle_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK(mode IN ('off','forced-only','preferred')),
      languages_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE subtitle_provider_config (
      provider_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      updated_at TEXT NOT NULL
    ) STRICT;`);
  }
};
