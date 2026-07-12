export const MEDIA_LISTS_SCHEMA_VERSION = 1;

export const MEDIA_LISTS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS media_lists (
    id TEXT PRIMARY KEY,
    list_type TEXT NOT NULL CHECK (list_type IN ('playlist', 'collection')),
    owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    media_kind TEXT NOT NULL CHECK (media_kind IN ('video', 'audio', 'mixed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((list_type = 'playlist' AND owner_user_id IS NOT NULL AND media_kind != 'mixed') OR
      (list_type = 'collection' AND owner_user_id IS NULL))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS media_list_items (
    list_id TEXT NOT NULL REFERENCES media_lists(id) ON DELETE CASCADE,
    media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK (position >= 0),
    added_at TEXT NOT NULL,
    PRIMARY KEY (list_id, media_item_id),
    UNIQUE (list_id, position)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS media_lists_owner_type
    ON media_lists(owner_user_id, list_type, updated_at DESC);
  CREATE INDEX IF NOT EXISTS media_list_items_item
    ON media_list_items(media_item_id);
`;

export const mediaListsMigration = Object.freeze({
  domain: "media-lists",
  version: MEDIA_LISTS_SCHEMA_VERSION,
  id: "media-lists-v1",
  sql: MEDIA_LISTS_SCHEMA_SQL,
  apply(database) { database.exec(MEDIA_LISTS_SCHEMA_SQL); }
});
