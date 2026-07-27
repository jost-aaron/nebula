const transaction = (database, work) => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

const encodeCursor = (updatedAt, id) =>
  Buffer.from(JSON.stringify([updatedAt, id]), "utf8").toString("base64url");

const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2
      || typeof decoded[0] !== "string" || typeof decoded[1] !== "string") throw new Error();
    return decoded;
  } catch {
    throw Object.assign(new Error("Invalid conversation cursor."), {
      code: "invalid_cursor", expose: true, status: 400
    });
  }
};

const attachmentFromRow = (row) => ({
  createdAt: row.created_at,
  displayName: row.display_name,
  id: row.id,
  mimeType: row.mime_type,
  size: row.size_bytes,
  uploaderId: row.uploader_user_id
});

const memberFromRow = (row) => ({
  displayName: row.display_name,
  id: row.user_id,
  role: row.member_role,
  username: row.username
});

const messageFromRow = (row, attachments = []) => ({
  attachments,
  conversationId: row.conversation_id,
  createdAt: row.created_at,
  id: row.id,
  senderId: row.sender_user_id,
  sequence: row.sequence,
  text: row.body_text ?? ""
});

export const createPartyRepository = ({ database } = {}) => {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("A SQLite database is required.");
  }

  const rawConversation = (conversationId) =>
    database.prepare("SELECT * FROM party_conversations WHERE id = ?").get(conversationId) ?? null;

  const rawMember = (conversationId, userId) =>
    database.prepare(`SELECT pcm.*, u.disabled
      FROM party_conversation_members pcm
      JOIN users u ON u.id = pcm.user_id
      WHERE pcm.conversation_id = ? AND pcm.user_id = ?`).get(conversationId, userId) ?? null;

  const isMember = (conversationOrOptions, maybeUserId) => {
    const conversationId = typeof conversationOrOptions === "object"
      ? conversationOrOptions?.conversationId
      : conversationOrOptions;
    const userId = typeof conversationOrOptions === "object"
      ? conversationOrOptions?.userId
      : maybeUserId;
    return Boolean(
    database.prepare(`SELECT 1 FROM party_conversation_members pcm
      JOIN users u ON u.id = pcm.user_id
      WHERE pcm.conversation_id = ? AND pcm.user_id = ? AND u.disabled = 0`)
      .get(conversationId, userId)
    );
  };

  const listMembers = (conversationId) => database.prepare(`SELECT
      pcm.user_id, pcm.role AS member_role, u.username, u.display_name
    FROM party_conversation_members pcm
    JOIN users u ON u.id = pcm.user_id
    WHERE pcm.conversation_id = ?
    ORDER BY
      CASE pcm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
      u.display_name COLLATE NOCASE, u.id`).all(conversationId).map(memberFromRow);

  const attachmentsForMessages = (messageIds) => {
    if (messageIds.length === 0) return new Map();
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = database.prepare(`SELECT * FROM party_attachments
      WHERE message_id IN (${placeholders}) ORDER BY created_at, id`).all(...messageIds);
    const byMessage = new Map();
    for (const row of rows) {
      const items = byMessage.get(row.message_id) ?? [];
      items.push(attachmentFromRow(row));
      byMessage.set(row.message_id, items);
    }
    return byMessage;
  };

  const lastMessage = (conversationId) => {
    const row = database.prepare(`SELECT * FROM party_messages
      WHERE conversation_id = ? ORDER BY sequence DESC LIMIT 1`).get(conversationId);
    if (!row) return null;
    const attachments = attachmentsForMessages([row.id]).get(row.id) ?? [];
    const message = messageFromRow(row, attachments);
    if ([...message.text].length > 240) message.text = [...message.text].slice(0, 240).join("");
    return message;
  };

  const presentConversation = (row, userId, { includeMembers = false } = {}) => {
    const members = listMembers(row.id);
    const ownMember = rawMember(row.id, userId);
    const other = row.kind === "direct" ? members.find((member) => member.id !== userId) : null;
    const unread = ownMember ? database.prepare(`SELECT COUNT(*) AS count
      FROM party_messages
      WHERE conversation_id = ? AND sequence > ? AND sender_user_id != ?`)
      .get(row.id, ownMember.last_read_sequence, userId).count : 0;
    const result = {
      avatarAttachmentId: row.avatar_attachment_id,
      createdAt: row.created_at,
      id: row.id,
      kind: row.kind,
      lastMessage: lastMessage(row.id),
      memberCount: members.length,
      title: row.kind === "direct" ? (other?.displayName ?? "Unavailable account") : row.title,
      unreadCount: unread,
      updatedAt: row.updated_at
    };
    if (includeMembers) result.members = members;
    return result;
  };

  const presentConversationPage = (rows, userId) => {
    if (rows.length === 0) return [];
    const ids = rows.map(({ id }) => id);
    const placeholders = ids.map(() => "?").join(",");
    const memberRows = database.prepare(`SELECT
        pcm.conversation_id, pcm.user_id, pcm.role AS member_role, pcm.last_read_sequence,
        u.username, u.display_name
      FROM party_conversation_members pcm
      JOIN users u ON u.id = pcm.user_id
      WHERE pcm.conversation_id IN (${placeholders})
      ORDER BY pcm.conversation_id,
        CASE pcm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
        u.display_name COLLATE NOCASE, u.id`).all(...ids);
    const membersByConversation = new Map();
    const ownMemberByConversation = new Map();
    for (const memberRow of memberRows) {
      const members = membersByConversation.get(memberRow.conversation_id) ?? [];
      members.push(memberFromRow(memberRow));
      membersByConversation.set(memberRow.conversation_id, members);
      if (memberRow.user_id === userId) ownMemberByConversation.set(memberRow.conversation_id, memberRow);
    }
    const unreadByConversation = new Map(database.prepare(`SELECT m.conversation_id, COUNT(*) AS count
      FROM party_messages m
      JOIN party_conversation_members mine
        ON mine.conversation_id = m.conversation_id AND mine.user_id = ?
      WHERE m.conversation_id IN (${placeholders})
        AND m.sequence > mine.last_read_sequence AND m.sender_user_id != ?
      GROUP BY m.conversation_id`).all(userId, ...ids, userId)
      .map((item) => [item.conversation_id, Number(item.count)]));
    const lastRows = database.prepare(`SELECT m.* FROM party_messages m
      JOIN (
        SELECT conversation_id, MAX(sequence) AS sequence
        FROM party_messages WHERE conversation_id IN (${placeholders})
        GROUP BY conversation_id
      ) latest ON latest.conversation_id = m.conversation_id AND latest.sequence = m.sequence`)
      .all(...ids);
    const attachments = attachmentsForMessages(lastRows.map(({ id }) => id));
    const lastByConversation = new Map(lastRows.map((messageRow) => {
      const message = messageFromRow(messageRow, attachments.get(messageRow.id) ?? []);
      if ([...message.text].length > 240) message.text = [...message.text].slice(0, 240).join("");
      return [messageRow.conversation_id, message];
    }));
    return rows.map((row) => {
      const members = membersByConversation.get(row.id) ?? [];
      const other = row.kind === "direct" ? members.find((member) => member.id !== userId) : null;
      return {
        avatarAttachmentId: row.avatar_attachment_id,
        createdAt: row.created_at,
        id: row.id,
        kind: row.kind,
        lastMessage: lastByConversation.get(row.id) ?? null,
        memberCount: members.length,
        title: row.kind === "direct" ? (other?.displayName ?? "Unavailable account") : row.title,
        unreadCount: ownMemberByConversation.has(row.id) ? (unreadByConversation.get(row.id) ?? 0) : 0,
        updatedAt: row.updated_at
      };
    });
  };

  const getConversation = (conversationId, userId, options) => {
    const row = rawConversation(conversationId);
    return row && isMember(conversationId, userId)
      ? presentConversation(row, userId, options)
      : null;
  };

  const listConversations = ({ cursor = null, limit, query = "" }, userId) => {
    const decoded = decodeCursor(cursor);
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = database.prepare(`SELECT DISTINCT c.*
      FROM party_conversations c
      JOIN party_conversation_members mine
        ON mine.conversation_id = c.id AND mine.user_id = ?
      WHERE
        (? IS NULL OR c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))
        AND (
          ? = ''
          OR (c.kind = 'group' AND c.title LIKE ? ESCAPE '\\' COLLATE NOCASE)
          OR EXISTS (
            SELECT 1 FROM party_conversation_members search_member
            JOIN users search_user ON search_user.id = search_member.user_id
            WHERE search_member.conversation_id = c.id
              AND search_member.user_id != ?
              AND (search_user.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR search_user.username LIKE ? ESCAPE '\\' COLLATE NOCASE)
          )
        )
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT ?`).all(
        userId,
        decoded?.[0] ?? null, decoded?.[0] ?? null, decoded?.[0] ?? null, decoded?.[1] ?? null,
        query, pattern, userId, pattern, pattern,
        limit + 1
      );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      conversations: presentConversationPage(page, userId),
      nextCursor: hasMore ? encodeCursor(page.at(-1).updated_at, page.at(-1).id) : null
    };
  };

  const createDirect = ({ conversationId, creatorId, directKey, otherUserId, timestamp }) =>
    transaction(database, () => {
      const existing = database.prepare(
        "SELECT * FROM party_conversations WHERE kind = 'direct' AND direct_key = ?"
      ).get(directKey);
      if (existing) return { conversation: presentConversation(existing, creatorId, { includeMembers: true }), created: false };
      database.prepare(`INSERT INTO party_conversations
        (id, kind, direct_key, title, avatar_attachment_id, created_by_user_id, created_at, updated_at)
        VALUES (?, 'direct', ?, NULL, NULL, ?, ?, ?)`)
        .run(conversationId, directKey, creatorId, timestamp, timestamp);
      const insertMember = database.prepare(`INSERT INTO party_conversation_members
        (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`);
      insertMember.run(conversationId, creatorId, timestamp);
      insertMember.run(conversationId, otherUserId, timestamp);
      return {
        conversation: presentConversation(rawConversation(conversationId), creatorId, { includeMembers: true }),
        created: true
      };
    });

  const createGroup = ({ conversationId, creatorId, memberIds, timestamp, title, avatarAttachmentId = null }) =>
    transaction(database, () => {
      database.prepare(`INSERT INTO party_conversations
        (id, kind, direct_key, title, avatar_attachment_id, created_by_user_id, created_at, updated_at)
        VALUES (?, 'group', NULL, ?, ?, ?, ?, ?)`)
        .run(conversationId, title, avatarAttachmentId, creatorId, timestamp, timestamp);
      const insert = database.prepare(`INSERT INTO party_conversation_members
        (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`);
      insert.run(conversationId, creatorId, "owner", timestamp);
      for (const memberId of memberIds) insert.run(conversationId, memberId, "member", timestamp);
      return presentConversation(rawConversation(conversationId), creatorId, { includeMembers: true });
    });

  const updateGroup = ({ avatarAttachmentId, conversationId, timestamp, title }) => {
    database.prepare(`UPDATE party_conversations SET
      title = COALESCE(?, title),
      avatar_attachment_id = CASE WHEN ? THEN ? ELSE avatar_attachment_id END,
      updated_at = ?
      WHERE id = ? AND kind = 'group'`)
      .run(title ?? null, avatarAttachmentId !== undefined ? 1 : 0, avatarAttachmentId ?? null, timestamp, conversationId);
  };

  const addMember = ({ conversationId, role, timestamp, userId }) => {
    database.prepare(`INSERT INTO party_conversation_members
      (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`)
      .run(conversationId, userId, role, timestamp);
    database.prepare("UPDATE party_conversations SET updated_at = ? WHERE id = ?")
      .run(timestamp, conversationId);
  };

  const updateMemberRole = ({ conversationId, role, timestamp, userId }) => {
    database.prepare(`UPDATE party_conversation_members SET role = ?
      WHERE conversation_id = ? AND user_id = ?`).run(role, conversationId, userId);
    database.prepare("UPDATE party_conversations SET updated_at = ? WHERE id = ?")
      .run(timestamp, conversationId);
  };

  const removeMember = ({ conversationId, timestamp, userId }) => {
    database.prepare("DELETE FROM party_conversation_members WHERE conversation_id = ? AND user_id = ?")
      .run(conversationId, userId);
    database.prepare("UPDATE party_conversations SET updated_at = ? WHERE id = ?")
      .run(timestamp, conversationId);
  };

  const queueAttachmentCleanup = (storageKeys, timestamp) => {
    const insert = database.prepare(`INSERT INTO party_attachment_cleanup
      (storage_key, queued_at) VALUES (?, ?) ON CONFLICT(storage_key) DO NOTHING`);
    for (const storageKey of storageKeys) insert.run(storageKey, timestamp);
  };

  const deleteConversation = ({ conversationId, timestamp }) => transaction(database, () => {
    const storageKeys = database.prepare(
      "SELECT storage_key FROM party_attachments WHERE conversation_id = ? ORDER BY id"
    ).all(conversationId).map(({ storage_key: storageKey }) => storageKey);
    queueAttachmentCleanup(storageKeys, timestamp);
    const deleted = database.prepare("DELETE FROM party_conversations WHERE id = ?")
      .run(conversationId).changes;
    return { deleted: deleted === 1, storageKeys };
  });

  const pruneMessages = ({ before, limit, timestamp }) => transaction(database, () => {
    const rows = database.prepare(`SELECT m.id, m.conversation_id,
        a.id AS attachment_id, a.storage_key
      FROM party_messages m
      LEFT JOIN party_attachments a ON a.message_id = m.id
      WHERE m.created_at < ?
      ORDER BY m.created_at, m.id
      LIMIT ?`).all(before, limit);
    const messageIds = [...new Set(rows.map(({ id }) => id))];
    if (messageIds.length === 0) return { deleted: 0, hasMore: false, storageKeys: [] };
    const placeholders = messageIds.map(() => "?").join(",");
    const storageKeys = rows.map(({ storage_key: storageKey }) => storageKey).filter(Boolean);
    queueAttachmentCleanup(storageKeys, timestamp);
    const attachmentIds = rows.map(({ attachment_id: attachmentId }) => attachmentId).filter(Boolean);
    if (attachmentIds.length > 0) {
      const attachmentPlaceholders = attachmentIds.map(() => "?").join(",");
      database.prepare(`UPDATE party_conversations SET avatar_attachment_id = NULL
        WHERE avatar_attachment_id IN (${attachmentPlaceholders})`).run(...attachmentIds);
    }
    database.prepare(`DELETE FROM party_messages WHERE id IN (${placeholders})`).run(...messageIds);
    const conversationIds = [...new Set(rows.map(({ conversation_id: id }) => id))];
    const update = database.prepare(`UPDATE party_conversations SET updated_at = COALESCE(
      (SELECT MAX(created_at) FROM party_messages WHERE conversation_id = ?), created_at
    ) WHERE id = ?`);
    for (const conversationId of conversationIds) update.run(conversationId, conversationId);
    return {
      deleted: messageIds.length,
      hasMore: messageIds.length === limit,
      storageKeys
    };
  });

  const listAttachmentCleanup = ({ limit }) => database.prepare(`SELECT storage_key
    FROM party_attachment_cleanup ORDER BY queued_at, storage_key LIMIT ?`)
    .all(limit).map(({ storage_key: storageKey }) => storageKey);

  const completeAttachmentCleanup = (storageKey) =>
    database.prepare("DELETE FROM party_attachment_cleanup WHERE storage_key = ?").run(storageKey).changes === 1;

  const failAttachmentCleanup = (storageKey) =>
    database.prepare(`UPDATE party_attachment_cleanup SET attempts = attempts + 1
      WHERE storage_key = ?`).run(storageKey);

  const insertMessage = ({
    attachment = null, clientId = null, conversationId, maxConversationBytes = null,
    maxGlobalBytes = null, maxUserBytes = null,
    messageId, senderId, text, timestamp
  }) =>
    transaction(database, () => {
      if (clientId) {
        const previous = database.prepare(`SELECT * FROM party_messages
          WHERE conversation_id = ? AND sender_user_id = ? AND client_id = ?`)
          .get(conversationId, senderId, clientId);
        if (previous) {
          const priorAttachment = attachmentsForMessages([previous.id]).get(previous.id) ?? [];
          return { duplicate: true, message: messageFromRow(previous, priorAttachment) };
        }
      }
      const conversation = rawConversation(conversationId);
      const sequence = conversation.next_sequence;
      if (attachment && maxConversationBytes !== null) {
        const currentBytes = database.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS bytes
          FROM party_attachments WHERE conversation_id = ?`).get(conversationId).bytes;
        if (currentBytes + attachment.sizeBytes > maxConversationBytes) {
          throw Object.assign(new Error("This conversation has reached its attachment quota."), {
            code: "attachment_quota_exceeded", expose: true, status: 413
          });
        }
      }
      if (attachment && maxUserBytes !== null) {
        const currentBytes = database.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS bytes
          FROM party_attachments WHERE uploader_user_id = ?`).get(senderId).bytes;
        if (currentBytes + attachment.sizeBytes > maxUserBytes) {
          throw Object.assign(new Error("This account has reached its Party attachment quota."), {
            code: "attachment_user_quota_exceeded", expose: true, status: 413
          });
        }
      }
      if (attachment && maxGlobalBytes !== null) {
        const currentBytes = database.prepare(
          "SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM party_attachments"
        ).get().bytes;
        if (currentBytes + attachment.sizeBytes > maxGlobalBytes) {
          throw Object.assign(new Error("Party attachment storage has reached its server quota."), {
            code: "attachment_global_quota_exceeded", expose: true, status: 507
          });
        }
      }
      database.prepare(`INSERT INTO party_messages
        (id, conversation_id, sequence, sender_user_id, body_text, client_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(messageId, conversationId, sequence, senderId, text, clientId, timestamp);
      let attachmentView = [];
      if (attachment) {
        database.prepare(`INSERT INTO party_attachments
          (id, message_id, conversation_id, uploader_user_id, storage_key, display_name,
            mime_type, size_bytes, sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            attachment.id, messageId, conversationId, senderId, attachment.storageKey,
            attachment.displayName, attachment.mimeType, attachment.sizeBytes, attachment.sha256,
            timestamp
          );
        attachmentView = [attachmentFromRow({
          ...attachment,
          created_at: timestamp,
          display_name: attachment.displayName,
          mime_type: attachment.mimeType,
          size_bytes: attachment.sizeBytes,
          uploader_user_id: senderId
        })];
      }
      database.prepare(`UPDATE party_conversations
        SET next_sequence = next_sequence + 1, updated_at = ? WHERE id = ?`)
        .run(timestamp, conversationId);
      const row = database.prepare("SELECT * FROM party_messages WHERE id = ?").get(messageId);
      return { duplicate: false, message: messageFromRow(row, attachmentView) };
    });

  const listMessages = ({ beforeSequence = null, conversationId, limit }) => {
    const rows = database.prepare(`SELECT * FROM party_messages
      WHERE conversation_id = ? AND (? IS NULL OR sequence < ?)
      ORDER BY sequence DESC LIMIT ?`)
      .all(conversationId, beforeSequence, beforeSequence, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const oldestSequence = page.at(-1)?.sequence ?? null;
    const attachments = attachmentsForMessages(page.map(({ id }) => id));
    return {
      messages: page.reverse().map((row) => messageFromRow(row, attachments.get(row.id) ?? [])),
      nextCursor: hasMore ? oldestSequence : null
    };
  };

  const markRead = ({ conversationId, sequence, userId }) => {
    database.prepare(`UPDATE party_conversation_members
      SET last_read_sequence = MAX(last_read_sequence, ?)
      WHERE conversation_id = ? AND user_id = ?`).run(sequence, conversationId, userId);
    const member = rawMember(conversationId, userId);
    const unreadCount = database.prepare(`SELECT COUNT(*) AS count FROM party_messages
      WHERE conversation_id = ? AND sequence > ? AND sender_user_id != ?`)
      .get(conversationId, member.last_read_sequence, userId).count;
    return { lastReadSequence: member.last_read_sequence, unreadCount };
  };

  const attachmentRecord = (row) => row ? {
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    displayName: row.display_name,
    id: row.id,
    messageId: row.message_id,
    mimeType: row.mime_type,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    storageKey: row.storage_key,
    uploaderUserId: row.uploader_user_id
  } : null;

  const getAttachment = ({ attachmentId }) => attachmentRecord(
    database.prepare("SELECT * FROM party_attachments WHERE id = ?").get(attachmentId)
  );

  const getAuthorizedAttachment = (attachmentId, userId) => {
    const row = database.prepare(`SELECT a.* FROM party_attachments a
      JOIN party_conversation_members member ON member.conversation_id = a.conversation_id
      JOIN users u ON u.id = member.user_id
      WHERE a.id = ? AND member.user_id = ? AND u.disabled = 0`).get(attachmentId, userId);
    return row ? {
      ...attachmentFromRow(row),
      conversationId: row.conversation_id,
      storageKey: row.storage_key,
      uploaderId: row.uploader_user_id
    } : null;
  };

  const getConversationAttachmentBytes = ({ conversationId }) =>
    database.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS bytes
      FROM party_attachments WHERE conversation_id = ?`).get(conversationId).bytes;

  const getAttachmentUsage = ({ conversationId = null, userId = null } = {}) => {
    const row = database.prepare(`SELECT
      COALESCE(SUM(size_bytes), 0) AS global_bytes,
      COALESCE(SUM(CASE WHEN conversation_id = ? THEN size_bytes ELSE 0 END), 0) AS conversation_bytes,
      COALESCE(SUM(CASE WHEN uploader_user_id = ? THEN size_bytes ELSE 0 END), 0) AS user_bytes
      FROM party_attachments`).get(conversationId, userId);
    return {
      conversationBytes: Number(row.conversation_bytes),
      globalBytes: Number(row.global_bytes),
      userBytes: Number(row.user_bytes)
    };
  };

  return {
    addMember,
    createDirect,
    createGroup,
    completeAttachmentCleanup,
    deleteConversation,
    getAttachment,
    getAttachmentUsage,
    getAuthorizedAttachment,
    getConversation,
    getConversationAttachmentBytes,
    failAttachmentCleanup,
    insertMessage,
    isMember,
    listConversations,
    listAttachmentCleanup,
    listMembers,
    listMessages,
    markRead,
    pruneMessages,
    rawConversation,
    rawMember,
    removeMember,
    updateGroup,
    updateMemberRole
  };
};
