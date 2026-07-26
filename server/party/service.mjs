import { randomUUID } from "node:crypto";

const fail = (status, code, message) =>
  Object.assign(new Error(message), { code, expose: true, status });
const bad = (message, code = "invalid_party_request") => fail(400, code, message);
const notFound = () => fail(404, "conversation_not_found", "Conversation not found.");

const accountFrom = (context) => {
  if (context?.kind !== "account" || !context.user?.id || context.user.disabled) {
    throw fail(403, "party_account_required", "An enabled Nebula account is required.");
  }
  return { id: context.user.id, role: context.user.role };
};

const cleanTitle = (value) => {
  if (typeof value !== "string") throw bad("title must be a string.");
  const title = value.trim().replace(/\s+/gu, " ");
  if (!title || [...title].length > 100 || Buffer.byteLength(title, "utf8") > 400) {
    throw bad("title must contain 1 to 100 characters.");
  }
  return title;
};

const cleanText = (value) => {
  if (typeof value !== "string") throw bad("text must be a string.");
  const text = value.replace(/\r\n?/gu, "\n").trim();
  if (!text || [...text].length > 8000 || Buffer.byteLength(text, "utf8") > 16 * 1024
    || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw bad("text must contain 1 to 8000 safe characters and be no larger than 16 KiB.");
  }
  return text;
};

const cleanClientId = (value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 100
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)) {
    throw bad("clientId must be a safe identifier no longer than 100 characters.");
  }
  return value;
};

const cleanUserId = (value, label = "userId") => {
  if (typeof value !== "string" || value.length < 1 || value.length > 128
    || /[^A-Za-z0-9_-]/.test(value)) throw bad(`${label} is invalid.`);
  return value;
};

const boundedLimit = (value, fallback, maximum) => {
  if (value === undefined || value === null || value === "") return fallback;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw bad(`limit must be an integer between 1 and ${maximum}.`);
  }
  return limit;
};

const cleanSearch = (value) => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw bad("q must be a string.");
  const query = value.trim();
  if ([...query].length > 80) throw bad("q must be no longer than 80 characters.");
  return query;
};

const cleanAvatar = (value) => {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 128
    || /[^A-Za-z0-9_-]/.test(value)) throw bad("avatarAttachmentId is invalid.");
  return value;
};

const cleanAttachment = (metadata, conversationId, actorId) => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw bad("Attachment metadata is invalid.");
  }
  const id = cleanUserId(metadata.id, "attachment id");
  const storageKey = String(metadata.storageKey ?? "");
  const displayName = String(metadata.displayName ?? "");
  const mimeType = String(metadata.mimeType ?? "");
  const sha256 = String(metadata.sha256 ?? "").toLowerCase();
  const sizeBytes = Number(metadata.sizeBytes);
  if (metadata.conversationId !== conversationId || metadata.uploaderUserId !== actorId) {
    throw fail(403, "attachment_scope_mismatch", "Attachment scope does not match the conversation.");
  }
  if (!storageKey || storageKey.length > 160 || storageKey.includes("\\")
    || storageKey.startsWith("/") || storageKey.split("/").some((part) => !part || part === "." || part === "..")) {
    throw bad("Attachment storage key is invalid.");
  }
  if (!displayName || [...displayName].length > 255 || /[\u0000-\u001f\u007f]/u.test(displayName)) {
    throw bad("Attachment display name is invalid.");
  }
  if (!/^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/i.test(mimeType)) {
    throw bad("Attachment MIME type is invalid.");
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > 25 * 1024 * 1024) {
    throw bad("Attachment size is invalid.");
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw bad("Attachment digest is invalid.");
  return { displayName, id, mimeType: mimeType.toLowerCase(), sha256, sizeBytes, storageKey };
};

const actorForAudit = (context) => ({
  kind: "account",
  principalId: context.user.id,
  role: context.user.role
});

export const createPartyService = ({
  audit = null,
  events = null,
  listUsers,
  maxConversationAttachmentBytes = 250 * 1024 * 1024,
  now = () => new Date().toISOString(),
  repository,
  uuid = randomUUID
} = {}) => {
  if (!repository) throw new TypeError("A Party repository is required.");
  if (typeof listUsers !== "function") throw new TypeError("listUsers must be provided.");

  const enabledUsers = () => listUsers().filter((user) =>
    user && typeof user.id === "string" && !user.disabled
  );
  const enabledUser = (id) => enabledUsers().find((user) => user.id === id) ?? null;
  const publish = (conversationId) => events?.publish?.(conversationId);
  const auditEvent = (context, eventType, conversationId, metadata = undefined) =>
    audit?.recordBestEffort({
      actor: actorForAudit(context),
      eventType,
      outcome: "success",
      target: { id: conversationId, type: "party_conversation" },
      metadata
    });
  const requireConversation = (conversationId, actorId) => {
    const conversation = repository.rawConversation(conversationId);
    const member = repository.rawMember(conversationId, actorId);
    if (!conversation || !member || member.disabled) throw notFound();
    return { conversation, member };
  };
  const requireGroupManager = (conversationId, actorId) => {
    const state = requireConversation(conversationId, actorId);
    if (state.conversation.kind !== "group") throw fail(409, "direct_membership_fixed", "Direct conversation membership cannot be changed.");
    if (!["owner", "admin"].includes(state.member.role)) {
      throw fail(403, "party_permission_denied", "Group administrator access is required.");
    }
    return state;
  };

  const discoverUsers = ({ limit, query }, context) => {
    const actor = accountFrom(context);
    const q = cleanSearch(query).toLocaleLowerCase();
    const count = boundedLimit(limit, 20, 50);
    return enabledUsers()
      .filter((user) => user.id !== actor.id)
      .filter((user) => !q
        || String(user.displayName).toLocaleLowerCase().includes(q)
        || String(user.username).toLocaleLowerCase().includes(q))
      .sort((left, right) =>
        String(left.displayName).localeCompare(String(right.displayName), undefined, { sensitivity: "base" })
        || left.id.localeCompare(right.id))
      .slice(0, count)
      .map((user) => ({ displayName: user.displayName, id: user.id, username: user.username }));
  };

  const createDirect = ({ userId }, context) => {
    const actor = accountFrom(context);
    const targetId = cleanUserId(userId);
    if (targetId === actor.id) throw bad("A direct conversation requires another account.");
    if (!enabledUser(targetId)) throw fail(404, "party_user_not_found", "Account not found.");
    const result = repository.createDirect({
      conversationId: uuid(),
      creatorId: actor.id,
      directKey: [actor.id, targetId].sort().join(":"),
      otherUserId: targetId,
      timestamp: now()
    });
    if (result.created) publish(result.conversation.id);
    return result;
  };

  const createGroup = ({ avatarAttachmentId, memberIds, title }, context) => {
    const actor = accountFrom(context);
    if (avatarAttachmentId !== undefined && avatarAttachmentId !== null) {
      throw bad("Create the group before selecting an avatar.");
    }
    if (!Array.isArray(memberIds)) throw bad("memberIds must be an array.");
    const unique = [...new Set(memberIds.map((value) => cleanUserId(value, "member id")))]
      .filter((id) => id !== actor.id);
    if (unique.length < 1 || unique.length > 99) {
      throw bad("A group must include between 1 and 99 other members.");
    }
    if (unique.some((id) => !enabledUser(id))) {
      throw fail(404, "party_user_not_found", "One or more accounts were not found.");
    }
    const conversation = repository.createGroup({
      avatarAttachmentId: null,
      conversationId: uuid(),
      creatorId: actor.id,
      memberIds: unique,
      timestamp: now(),
      title: cleanTitle(title)
    });
    auditEvent(context, "party.group_created", conversation.id);
    publish(conversation.id);
    return conversation;
  };

  const listConversations = ({ cursor, limit, query }, context) => {
    const actor = accountFrom(context);
    return repository.listConversations({
      cursor: cursor || null,
      limit: boundedLimit(limit, 50, 100),
      query: cleanSearch(query)
    }, actor.id);
  };

  const getConversation = (conversationId, context) => {
    const actor = accountFrom(context);
    return repository.getConversation(conversationId, actor.id, { includeMembers: true }) ?? (() => { throw notFound(); })();
  };

  const updateGroup = (conversationId, changes, context) => {
    const actor = accountFrom(context);
    requireGroupManager(conversationId, actor.id);
    if (!changes || typeof changes !== "object" || Array.isArray(changes)
      || (!Object.hasOwn(changes, "title") && !Object.hasOwn(changes, "avatarAttachmentId"))) {
      throw bad("At least one supported group field is required.");
    }
    const values = {};
    if (Object.hasOwn(changes, "title")) values.title = cleanTitle(changes.title);
    if (Object.hasOwn(changes, "avatarAttachmentId")) {
      values.avatarAttachmentId = cleanAvatar(changes.avatarAttachmentId);
      if (values.avatarAttachmentId) {
        const attachment = repository.getAuthorizedAttachment(values.avatarAttachmentId, actor.id);
        if (!attachment || attachment.conversationId !== conversationId
          || !attachment.mimeType.startsWith("image/")) {
          throw fail(404, "party_attachment_not_found", "Avatar attachment not found.");
        }
      }
    }
    repository.updateGroup({ ...values, conversationId, timestamp: now() });
    auditEvent(context, "party.group_updated", conversationId);
    publish(conversationId);
    return repository.getConversation(conversationId, actor.id, { includeMembers: true });
  };

  const addMember = (conversationId, { role = "member", userId }, context) => {
    const actor = accountFrom(context);
    const { member: actorMember } = requireGroupManager(conversationId, actor.id);
    const targetId = cleanUserId(userId);
    if (!enabledUser(targetId)) throw fail(404, "party_user_not_found", "Account not found.");
    if (repository.rawMember(conversationId, targetId)) throw fail(409, "party_member_exists", "Account is already a group member.");
    if (!["member", "admin"].includes(role)
      || (role === "admin" && actorMember.role !== "owner")) {
      throw fail(403, "party_permission_denied", "Only the group owner can add administrators.");
    }
    if (repository.listMembers(conversationId).length >= 100) {
      throw fail(409, "party_group_full", "Groups support at most 100 members.");
    }
    repository.addMember({ conversationId, role, timestamp: now(), userId: targetId });
    auditEvent(context, "party.member_added", conversationId);
    publish(conversationId);
    return repository.getConversation(conversationId, actor.id, { includeMembers: true });
  };

  const updateMemberRole = (conversationId, userId, { role }, context) => {
    const actor = accountFrom(context);
    const { member: actorMember } = requireGroupManager(conversationId, actor.id);
    if (actorMember.role !== "owner") throw fail(403, "party_permission_denied", "Only the group owner can change roles.");
    const targetId = cleanUserId(userId);
    const target = repository.rawMember(conversationId, targetId);
    if (!target) throw fail(404, "party_member_not_found", "Group member not found.");
    if (target.role === "owner" || !["member", "admin"].includes(role)) {
      throw fail(409, "party_owner_immutable", "The group owner role cannot be changed.");
    }
    repository.updateMemberRole({ conversationId, role, timestamp: now(), userId: targetId });
    auditEvent(context, "party.member_role_changed", conversationId);
    publish(conversationId);
    return repository.getConversation(conversationId, actor.id, { includeMembers: true });
  };

  const removeMember = (conversationId, userId, context) => {
    const actor = accountFrom(context);
    const { member: actorMember } = requireConversation(conversationId, actor.id);
    const targetId = cleanUserId(userId);
    const target = repository.rawMember(conversationId, targetId);
    if (!target) throw fail(404, "party_member_not_found", "Group member not found.");
    const conversation = repository.rawConversation(conversationId);
    if (conversation.kind !== "group") throw fail(409, "direct_membership_fixed", "Direct conversation membership cannot be changed.");
    if (target.role === "owner") throw fail(409, "party_owner_immutable", "The group owner cannot leave or be removed.");
    const self = targetId === actor.id;
    if (!self && !["owner", "admin"].includes(actorMember.role)) {
      throw fail(403, "party_permission_denied", "Group administrator access is required.");
    }
    if (!self && actorMember.role === "admin" && target.role !== "member") {
      throw fail(403, "party_permission_denied", "Administrators can remove members only.");
    }
    repository.removeMember({ conversationId, timestamp: now(), userId: targetId });
    auditEvent(context, "party.member_removed", conversationId);
    publish(conversationId);
    return self ? null : repository.getConversation(conversationId, actor.id, { includeMembers: true });
  };

  const listMessages = (conversationId, { beforeSequence, limit }, context) => {
    const actor = accountFrom(context);
    requireConversation(conversationId, actor.id);
    let before = null;
    if (beforeSequence !== undefined && beforeSequence !== null && beforeSequence !== "") {
      before = Number(beforeSequence);
      if (!Number.isSafeInteger(before) || before < 1) throw bad("beforeSequence must be a positive integer.");
    }
    return repository.listMessages({
      beforeSequence: before,
      conversationId,
      limit: boundedLimit(limit, 50, 100)
    });
  };

  const sendMessage = (conversationId, { clientId, text }, context) => {
    const actor = accountFrom(context);
    requireConversation(conversationId, actor.id);
    const normalizedText = cleanText(text);
    const result = repository.insertMessage({
      clientId: cleanClientId(clientId),
      conversationId,
      messageId: uuid(),
      senderId: actor.id,
      text: normalizedText,
      timestamp: now()
    });
    if (result.duplicate && result.message.text !== normalizedText) {
      throw fail(409, "party_client_id_conflict", "clientId was already used for another message.");
    }
    if (!result.duplicate) publish(conversationId);
    return result;
  };

  const createAttachmentMessage = (
    conversationId, metadata, clientMessageId, context, { conversationQuotaBytes } = {}
  ) => {
    const actor = accountFrom(context);
    requireConversation(conversationId, actor.id);
    const attachment = cleanAttachment(metadata, conversationId, actor.id);
    const result = repository.insertMessage({
      attachment,
      clientId: cleanClientId(clientMessageId),
      conversationId,
      maxConversationBytes: Math.min(
        maxConversationAttachmentBytes,
        Number.isSafeInteger(conversationQuotaBytes) && conversationQuotaBytes >= 0
          ? conversationQuotaBytes
          : maxConversationAttachmentBytes
      ),
      messageId: uuid(),
      senderId: actor.id,
      text: null,
      timestamp: metadata.createdAt ?? now()
    });
    if (result.duplicate) {
      throw fail(409, "party_client_id_conflict", "clientMessageId was already used.");
    }
    publish(conversationId);
    return result;
  };

  const markRead = (conversationId, { sequence }, context) => {
    const actor = accountFrom(context);
    const { conversation, member } = requireConversation(conversationId, actor.id);
    const value = Number(sequence);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw bad("sequence must be a non-negative integer.");
    }
    const read = repository.markRead({
      conversationId,
      sequence: Math.min(value, conversation.next_sequence - 1),
      userId: actor.id
    });
    if (read.lastReadSequence > member.last_read_sequence) publish(conversationId);
    return read;
  };

  const getAttachment = (attachmentId, context) => {
    const actor = accountFrom(context);
    const attachment = repository.getAuthorizedAttachment(attachmentId, actor.id);
    if (!attachment) throw fail(404, "party_attachment_not_found", "Attachment not found.");
    return attachment;
  };

  return {
    addMember,
    createAttachmentMessage,
    createDirect,
    createGroup,
    discoverUsers,
    getAttachment,
    getConversation,
    isConversationMember: ({ conversationId, userId }) => repository.isMember(conversationId, userId),
    listConversations,
    listMessages,
    markRead,
    removeMember,
    sendMessage,
    updateGroup,
    updateMemberRole
  };
};
