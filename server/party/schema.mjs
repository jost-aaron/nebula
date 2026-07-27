export const PARTY_SCHEMA_VERSION = 1;

export const PARTY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS party_conversations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
    direct_key TEXT UNIQUE,
    title TEXT,
    avatar_attachment_id TEXT,
    created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (kind = 'direct' AND direct_key IS NOT NULL AND title IS NULL AND avatar_attachment_id IS NULL)
      OR
      (kind = 'group' AND direct_key IS NULL AND title IS NOT NULL
        AND length(title) BETWEEN 1 AND 100
        AND (avatar_attachment_id IS NULL OR length(avatar_attachment_id) BETWEEN 1 AND 128))
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS party_conversation_members (
    conversation_id TEXT NOT NULL REFERENCES party_conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    joined_at TEXT NOT NULL,
    last_read_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0),
    PRIMARY KEY (conversation_id, user_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS party_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES party_conversations(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    body_text TEXT CHECK (
      body_text IS NULL OR (length(body_text) BETWEEN 1 AND 8000)
    ),
    client_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (conversation_id, sequence),
    UNIQUE (id, conversation_id),
    UNIQUE (conversation_id, sender_user_id, client_id),
    CHECK (client_id IS NULL OR length(client_id) BETWEEN 1 AND 100)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS party_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES party_messages(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES party_conversations(id) ON DELETE CASCADE,
    uploader_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 160),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 255),
    mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 127),
    size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 26214400),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    created_at TEXT NOT NULL,
    FOREIGN KEY (message_id, conversation_id)
      REFERENCES party_messages(id, conversation_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS party_members_by_user
    ON party_conversation_members(user_id, conversation_id);
  CREATE INDEX IF NOT EXISTS party_conversations_activity
    ON party_conversations(updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS party_messages_conversation_sequence
    ON party_messages(conversation_id, sequence DESC);
  CREATE INDEX IF NOT EXISTS party_messages_unread
    ON party_messages(conversation_id, sender_user_id, sequence);
  CREATE INDEX IF NOT EXISTS party_attachments_message
    ON party_attachments(message_id);
  CREATE INDEX IF NOT EXISTS party_attachments_conversation
    ON party_attachments(conversation_id, created_at);
`;

export const partyMigration = Object.freeze({
  domain: "party",
  version: PARTY_SCHEMA_VERSION,
  id: "party-v1",
  sql: PARTY_SCHEMA_SQL,
  apply(database) {
    database.exec(PARTY_SCHEMA_SQL);
  }
});

export const PARTY_LIFECYCLE_SCHEMA_VERSION = 2;
export const PARTY_LIFECYCLE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS party_attachment_cleanup (
    storage_key TEXT PRIMARY KEY CHECK (length(storage_key) BETWEEN 1 AND 160),
    queued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS party_attachment_cleanup_queue
    ON party_attachment_cleanup(queued_at, storage_key);
`;

export const partyLifecycleMigration = Object.freeze({
  domain: "party",
  version: PARTY_LIFECYCLE_SCHEMA_VERSION,
  id: "party-v2-lifecycle",
  sql: PARTY_LIFECYCLE_SCHEMA_SQL,
  apply(database) {
    database.exec(PARTY_LIFECYCLE_SCHEMA_SQL);
  }
});
