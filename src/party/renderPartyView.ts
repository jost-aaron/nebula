import "./party.css";
import {
  addPartyConversationMember,
  createPartyDirectConversation,
  createPartyGroupConversation,
  downloadPartyAttachment,
  fetchPartyAttachment,
  getPartyConversation,
  listPartyConversations,
  listPartyMessages,
  markPartyConversationRead,
  removePartyConversationMember,
  searchPartyUsers,
  sendPartyMessage,
  streamPartyEvents,
  updatePartyConversation,
  updatePartyConversationMember,
  uploadPartyAttachment,
  type PartyUploadHandle
} from "../api/partyApi";
import type {
  PartyAttachment,
  PartyConversation,
  PartyMember,
  PartyMemberRole,
  PartyMessage,
  PartyUser
} from "../shared/partyTypes";
import { createDialogFocusManager } from "../shared/dialogFocus";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatTime = (value: string, includeDate = false) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay && !includeDate) {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: includeDate ? "numeric" : undefined,
    minute: includeDate ? "2-digit" : undefined,
    month: "short"
  }).format(date);
};

const initials = (value: string) =>
  value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";

const clientId = () => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${crypto.getRandomValues(new Uint32Array(4)).join("-")}`;
};

const conversationTitle = (conversation: PartyConversation, currentUserId: string) => {
  if (conversation.title?.trim()) return conversation.title.trim();
  const other = conversation.members?.find((member) => member.id !== currentUserId);
  return other?.displayName ?? other?.username ?? "Direct conversation";
};

const messagePreview = (message: PartyMessage | null) => {
  if (!message) return "No messages yet";
  const text = message.text.trim();
  if (text) return text;
  const attachment = message.attachments[0];
  return attachment ? `Attachment · ${attachment.displayName}` : "New message";
};

const attachmentKind = (attachment: PartyAttachment) => {
  if (attachment.mimeType.startsWith("image/")) return "image";
  if (attachment.mimeType.startsWith("video/")) return "video";
  if (attachment.mimeType.startsWith("audio/")) return "audio";
  return "file";
};

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

export interface PartyViewOptions {
  currentUserId: string;
  onClose?: () => void;
}

interface UploadState {
  conversationId: string;
  error: string;
  file: File;
  handle: PartyUploadHandle | null;
  id: string;
  progress: number;
  status: "cancelled" | "complete" | "failed" | "uploading";
}

type PartyDialog = "members" | "new" | null;
type ConnectionState = "connected" | "offline" | "reconnecting";

export const renderPartyView = () => `
  <section class="party-app" data-party-app tabindex="-1" aria-label="Nebula Party">
    <header class="party-masthead">
      <div class="party-brand">
        <span class="party-brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>
          <small>Local conversations</small>
          <strong>Nebula Party</strong>
        </span>
      </div>
      <div class="party-masthead-actions">
        <span class="party-connection is-reconnecting" data-party-connection role="status">
          <i aria-hidden="true"></i><span>Connecting</span>
        </span>
        <button type="button" class="party-icon-button" data-party-new aria-label="Start a conversation" title="New conversation">+</button>
        <button type="button" class="party-icon-button" data-party-close aria-label="Close Party" title="Close">×</button>
      </div>
    </header>

    <div class="party-layout">
      <aside class="party-sidebar" aria-label="Conversations">
        <div class="party-sidebar-heading">
          <div>
            <small>Messages</small>
            <h2>Conversations</h2>
          </div>
          <button type="button" data-party-new>New</button>
        </div>
        <label class="party-search">
          <span class="sr-only">Search conversations</span>
          <i aria-hidden="true">⌕</i>
          <input type="search" autocomplete="off" placeholder="Search conversations" data-party-conversation-search />
          <kbd aria-hidden="true">Ctrl K</kbd>
        </label>
        <div class="party-conversation-list" data-party-conversations></div>
      </aside>

      <section class="party-thread" data-party-thread aria-label="Conversation">
        <div class="party-thread-empty" data-party-empty>
          <span class="party-empty-orbit" aria-hidden="true"><i></i></span>
          <h2>Select a conversation</h2>
          <p>Choose a conversation or find another person on this Nebula server.</p>
          <button type="button" data-party-new>Start a conversation</button>
        </div>
        <div class="party-thread-shell" data-party-thread-shell hidden>
          <header class="party-thread-header" data-party-thread-header></header>
          <div class="party-message-region" data-party-message-region>
            <div class="party-messages" data-party-messages role="log" aria-live="off" aria-busy="false"></div>
          </div>
          <div class="party-upload-tray" data-party-upload-tray hidden></div>
          <form class="party-composer" data-party-composer>
            <label class="party-attach-button" title="Attach a file">
              <span aria-hidden="true">＋</span>
              <span class="sr-only">Attach a file</span>
              <input
                type="file"
                multiple
                data-party-file
                accept="image/*,video/*,audio/*,.pdf,.txt,.md,.zip,.tar,.gz,application/octet-stream"
              />
            </label>
            <label class="party-composer-field">
              <span class="sr-only">Message</span>
              <textarea
                rows="1"
                maxlength="8000"
                placeholder="Message"
                data-party-message-input
                aria-describedby="party-composer-hint"
              ></textarea>
            </label>
            <button type="submit" class="party-send" data-party-send aria-label="Send message">
              <span aria-hidden="true">➤</span>
            </button>
            <small id="party-composer-hint">Enter to send · Shift+Enter for a new line</small>
          </form>
        </div>
      </section>
    </div>

    <div class="party-dialog-host" data-party-dialog-host hidden></div>
    <div class="party-live-region sr-only" data-party-live role="status" aria-live="polite"></div>
  </section>
`;

const renderAvatar = (
  conversation: PartyConversation,
  currentUserId: string,
  objectUrls: Map<string, string>,
  className = "party-avatar"
) => {
  const title = conversationTitle(conversation, currentUserId);
  const attachmentId = conversation.avatarAttachmentId;
  const url = attachmentId ? objectUrls.get(attachmentId) : null;
  return `
    <span class="${className}${conversation.kind === "group" ? " is-group" : ""}">
      ${url
        ? `<img src="${escapeHtml(url)}" alt="" />`
        : `<span aria-hidden="true">${escapeHtml(initials(title))}</span>`}
      ${attachmentId && !url ? `<i data-party-attachment-preview="${escapeHtml(attachmentId)}" data-party-preview-kind="avatar"></i>` : ""}
    </span>
  `;
};

const renderConversationItems = (
  conversations: PartyConversation[],
  selectedId: string | null,
  currentUserId: string,
  nextCursor: string | null,
  objectUrls: Map<string, string>
) => {
  if (conversations.length === 0) {
    return `
      <div class="party-list-state">
        <strong>No conversations found</strong>
        <span>Start a direct message or create a group.</span>
        <button type="button" data-party-new>New conversation</button>
      </div>
    `;
  }
  return `
    <div role="list">
      ${conversations.map((conversation) => {
        const title = conversationTitle(conversation, currentUserId);
        const selected = conversation.id === selectedId;
        return `
          <button
            type="button"
            role="listitem"
            class="party-conversation${selected ? " is-active" : ""}"
            data-party-conversation="${escapeHtml(conversation.id)}"
            aria-current="${selected ? "page" : "false"}"
          >
            ${renderAvatar(conversation, currentUserId, objectUrls)}
            <span class="party-conversation-copy">
              <span class="party-conversation-line">
                <strong>${escapeHtml(title)}</strong>
                <time datetime="${escapeHtml(conversation.updatedAt)}">${escapeHtml(formatTime(conversation.updatedAt))}</time>
              </span>
              <span class="party-conversation-line">
                <small>${escapeHtml(messagePreview(conversation.lastMessage))}</small>
                ${conversation.unreadCount > 0
                  ? `<b aria-label="${conversation.unreadCount} unread messages">${conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</b>`
                  : ""}
              </span>
            </span>
          </button>
        `;
      }).join("")}
    </div>
    ${nextCursor ? `<button type="button" class="party-load-more" data-party-more-conversations>Load more</button>` : ""}
  `;
};

const renderThreadHeader = (
  conversation: PartyConversation,
  currentUserId: string,
  objectUrls: Map<string, string>
) => {
  const title = conversationTitle(conversation, currentUserId);
  return `
    <button type="button" class="party-mobile-back" data-party-mobile-back aria-label="Back to conversations">‹</button>
    ${renderAvatar(conversation, currentUserId, objectUrls, "party-thread-avatar")}
    <div class="party-thread-identity">
      <strong>${escapeHtml(title)}</strong>
      <small>${conversation.kind === "group"
        ? `${conversation.memberCount} members · local group`
        : "Private on this Nebula server"}</small>
    </div>
    ${conversation.kind === "group"
      ? `<button type="button" class="party-thread-command" data-party-members aria-label="Manage group" title="Manage group">Group</button>`
      : ""}
  `;
};

const renderAttachment = (attachment: PartyAttachment, objectUrls: Map<string, string>) => {
  const kind = attachmentKind(attachment);
  const url = objectUrls.get(attachment.id);
  const preview = url && kind === "image"
    ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(attachment.displayName)}" loading="lazy" />`
    : url && kind === "video"
      ? `<video src="${escapeHtml(url)}" controls preload="metadata"></video>`
      : url && kind === "audio"
        ? `<audio src="${escapeHtml(url)}" controls preload="metadata"></audio>`
        : kind !== "file"
          ? `<span class="party-attachment-loading" data-party-attachment-preview="${escapeHtml(attachment.id)}" data-party-preview-kind="${kind}">Loading preview…</span>`
          : `<span class="party-file-glyph" aria-hidden="true">${escapeHtml(attachment.displayName.split(".").pop()?.slice(0, 4).toUpperCase() || "FILE")}</span>`;
  return `
    <article class="party-attachment is-${kind}">
      <div class="party-attachment-preview">${preview}</div>
      <div class="party-attachment-details">
        <strong title="${escapeHtml(attachment.displayName)}">${escapeHtml(attachment.displayName)}</strong>
        <small>${escapeHtml(formatBytes(attachment.size))} · ${escapeHtml(attachment.mimeType)}</small>
      </div>
      <button
        type="button"
        data-party-download="${escapeHtml(attachment.id)}"
        data-party-download-name="${escapeHtml(attachment.displayName)}"
        aria-label="Download ${escapeHtml(attachment.displayName)}"
      >↓</button>
    </article>
  `;
};

const renderMessages = (
  messages: PartyMessage[],
  conversation: PartyConversation,
  currentUserId: string,
  hasOlder: boolean,
  objectUrls: Map<string, string>
) => {
  if (messages.length === 0) {
    return `
      <div class="party-message-empty">
        <span aria-hidden="true">✦</span>
        <strong>This is the beginning</strong>
        <p>Messages stay on this Nebula server and are visible to conversation members.</p>
      </div>
    `;
  }
  const memberMap = new Map(conversation.members?.map((member) => [member.id, member]) ?? []);
  return `
    ${hasOlder ? `<button type="button" class="party-load-earlier" data-party-older>Load earlier messages</button>` : ""}
    ${messages.map((message, index) => {
      const mine = message.senderId === currentUserId;
      const previous = messages[index - 1];
      const newGroup = !previous || previous.senderId !== message.senderId ||
        Date.parse(message.createdAt) - Date.parse(previous.createdAt) > 5 * 60_000;
      const sender = memberMap.get(message.senderId);
      const senderName = mine ? "You" : sender?.displayName ?? sender?.username ?? "Member";
      return `
        <article class="party-message${mine ? " is-mine" : ""}${newGroup ? " starts-group" : ""}" data-party-sequence="${message.sequence}">
          <div class="party-message-meta">
            ${newGroup ? `<strong>${escapeHtml(senderName)}</strong>` : ""}
            <time datetime="${escapeHtml(message.createdAt)}">${escapeHtml(formatTime(message.createdAt, true))}</time>
          </div>
          ${message.text ? `<div class="party-bubble">${escapeHtml(message.text)}</div>` : ""}
          ${message.attachments.length > 0
            ? `<div class="party-message-attachments">${message.attachments.map((item) => renderAttachment(item, objectUrls)).join("")}</div>`
            : ""}
        </article>
      `;
    }).join("")}
  `;
};

const renderUploads = (uploads: UploadState[]) => uploads.length === 0 ? "" : uploads.map((upload) => `
  <article class="party-upload is-${upload.status}" data-party-upload="${escapeHtml(upload.id)}">
    <span class="party-file-glyph" aria-hidden="true">${escapeHtml(upload.file.name.split(".").pop()?.slice(0, 4).toUpperCase() || "FILE")}</span>
    <div>
      <strong>${escapeHtml(upload.file.name)}</strong>
      <small>${upload.status === "uploading"
        ? `${Math.round(upload.progress)}% · ${formatBytes(upload.file.size)}`
        : upload.status === "complete"
          ? "Sent"
          : upload.status === "cancelled"
            ? "Cancelled"
            : escapeHtml(upload.error || "Upload failed")}</small>
      <progress max="100" value="${upload.progress}" aria-label="Upload progress"></progress>
    </div>
    ${upload.status === "uploading"
      ? `<button type="button" data-party-cancel-upload="${escapeHtml(upload.id)}">Cancel</button>`
      : upload.status === "failed"
        ? `<button type="button" data-party-retry-upload="${escapeHtml(upload.id)}">Retry</button>`
        : `<button type="button" data-party-dismiss-upload="${escapeHtml(upload.id)}" aria-label="Dismiss">×</button>`}
  </article>
`).join("");

const renderUserResults = (
  users: PartyUser[],
  selectedIds: Set<string>,
  mode: "direct" | "group",
  currentUserId: string
) => {
  const available = users.filter((user) => user.id !== currentUserId);
  if (available.length === 0) {
    return `<div class="party-user-empty">No enabled accounts match this search.</div>`;
  }
  return available.map((user) => {
    const selected = selectedIds.has(user.id);
    return `
      <button
        type="button"
        class="party-user-result${selected ? " is-selected" : ""}"
        data-party-user="${escapeHtml(user.id)}"
        aria-pressed="${mode === "group" ? selected : "false"}"
      >
        <span class="party-user-avatar" aria-hidden="true">${escapeHtml(initials(user.displayName))}</span>
        <span><strong>${escapeHtml(user.displayName)}</strong><small>@${escapeHtml(user.username)}</small></span>
        <i aria-hidden="true">${mode === "direct" ? "Message" : selected ? "✓" : "+"}</i>
      </button>
    `;
  }).join("");
};

const roleLabel = (role: PartyMemberRole) => role[0].toUpperCase() + role.slice(1);

const renderMembersDialog = (
  conversation: PartyConversation,
  currentUserId: string,
  users: PartyUser[],
  memberQuery: string
) => {
  const members = conversation.members ?? [];
  const current = members.find((member) => member.id === currentUserId);
  const canManage = current?.role === "owner" || current?.role === "admin";
  const canChangeRoles = current?.role === "owner";
  const memberIds = new Set(members.map((member) => member.id));
  const candidates = users.filter((user) => !memberIds.has(user.id) && user.id !== currentUserId);
  return `
    <section class="party-dialog" role="dialog" aria-modal="true" aria-labelledby="party-members-title">
      <header>
        <div><small>Group settings</small><h2 id="party-members-title">Manage group</h2></div>
        <button type="button" data-party-dialog-close aria-label="Close">×</button>
      </header>
      ${canManage ? `
        <form class="party-group-details" data-party-group-details>
          <label><span>Group title</span><input name="title" maxlength="80" required value="${escapeHtml(conversation.title ?? "")}" /></label>
          <button type="submit">Save title</button>
          <label class="party-avatar-picker">
            <span>Group image</span>
            <input type="file" data-party-avatar accept="image/png,image/jpeg,image/webp,image/gif" />
          </label>
        </form>
      ` : ""}
      <div class="party-dialog-section">
        <h3>Members <span>${members.length}</span></h3>
        <div class="party-member-list">
          ${members.map((member) => `
            <article class="party-member">
              <span class="party-user-avatar" aria-hidden="true">${escapeHtml(initials(member.displayName))}</span>
              <span><strong>${escapeHtml(member.displayName)}${member.id === currentUserId ? " (you)" : ""}</strong><small>@${escapeHtml(member.username)}</small></span>
              ${canManage && member.role !== "owner" && member.id !== currentUserId
                ? `${canChangeRoles ? `<select data-party-member-role="${escapeHtml(member.id)}" aria-label="Role for ${escapeHtml(member.displayName)}">
                    ${(["member", "admin"] as const).map((role) => `<option value="${role}"${member.role === role ? " selected" : ""}>${roleLabel(role)}</option>`).join("")}
                  </select>` : `<em>${escapeHtml(roleLabel(member.role))}</em>`}
                  ${canChangeRoles || member.role === "member"
                    ? `<button type="button" class="is-danger" data-party-remove-member="${escapeHtml(member.id)}" aria-label="Remove ${escapeHtml(member.displayName)}">Remove</button>`
                    : ""}`
                : `<em>${escapeHtml(roleLabel(member.role))}</em>`}
            </article>
          `).join("")}
        </div>
      </div>
      ${canManage ? `
        <div class="party-dialog-section">
          <h3>Add people</h3>
          <label class="party-search">
            <span class="sr-only">Search enabled accounts</span>
            <i aria-hidden="true">⌕</i>
            <input type="search" autocomplete="off" value="${escapeHtml(memberQuery)}" placeholder="Search enabled accounts" data-party-member-search />
          </label>
          <div class="party-user-results">
            ${candidates.length > 0 ? candidates.map((user) => `
              <button type="button" class="party-user-result" data-party-add-member="${escapeHtml(user.id)}">
                <span class="party-user-avatar" aria-hidden="true">${escapeHtml(initials(user.displayName))}</span>
                <span><strong>${escapeHtml(user.displayName)}</strong><small>@${escapeHtml(user.username)}</small></span>
                <i aria-hidden="true">+</i>
              </button>
            `).join("") : `<div class="party-user-empty">No accounts available to add.</div>`}
          </div>
        </div>
      ` : ""}
    </section>
  `;
};

export const bindPartyView = (container: ParentNode, options: PartyViewOptions) => {
  const app = container.querySelector<HTMLElement>("[data-party-app]");
  if (!app) return () => {};

  const conversationsNode = app.querySelector<HTMLElement>("[data-party-conversations]")!;
  const threadShell = app.querySelector<HTMLElement>("[data-party-thread-shell]")!;
  const emptyNode = app.querySelector<HTMLElement>("[data-party-empty]")!;
  const threadHeader = app.querySelector<HTMLElement>("[data-party-thread-header]")!;
  const messageRegion = app.querySelector<HTMLElement>("[data-party-message-region]")!;
  const messagesNode = app.querySelector<HTMLElement>("[data-party-messages]")!;
  const composer = app.querySelector<HTMLFormElement>("[data-party-composer]")!;
  const messageInput = app.querySelector<HTMLTextAreaElement>("[data-party-message-input]")!;
  const fileInput = app.querySelector<HTMLInputElement>("[data-party-file]")!;
  const sendButton = app.querySelector<HTMLButtonElement>("[data-party-send]")!;
  const uploadTray = app.querySelector<HTMLElement>("[data-party-upload-tray]")!;
  const dialogHost = app.querySelector<HTMLElement>("[data-party-dialog-host]")!;
  const liveRegion = app.querySelector<HTMLElement>("[data-party-live]")!;
  const connectionNode = app.querySelector<HTMLElement>("[data-party-connection]")!;
  const searchInput = app.querySelector<HTMLInputElement>("[data-party-conversation-search]")!;
  const viewController = new AbortController();

  let disposed = false;
  let conversations: PartyConversation[] = [];
  let conversationCursor: string | null = null;
  let conversationQuery = "";
  let selectedConversation: PartyConversation | null = null;
  let messages: PartyMessage[] = [];
  let messageCursor: number | null = null;
  let loadingConversations = true;
  let loadingMessages = false;
  let sending = false;
  let listError = "";
  let threadError = "";
  let dialog: PartyDialog = null;
  let newMode: "direct" | "group" = "direct";
  let discoveryUsers: PartyUser[] = [];
  let discoveryQuery = "";
  let groupTitle = "";
  let selectedUserIds = new Set<string>();
  let memberQuery = "";
  let uploads: UploadState[] = [];
  let connection: ConnectionState = navigator.onLine ? "reconnecting" : "offline";
  let reconnectAttempt = 0;
  let reconnectTimer = 0;
  let conversationSearchTimer = 0;
  let discoveryTimer = 0;
  let refreshTimer = 0;
  let conversationController: AbortController | null = null;
  let messageController: AbortController | null = null;
  let discoveryController: AbortController | null = null;
  let eventController: AbortController | null = null;
  const objectUrls = new Map<string, string>();
  const previewLoads = new Map<string, AbortController>();
  const previewQueue: HTMLElement[] = [];
  const queuedPreviewIds = new Set<string>();
  let activePreviewLoads = 0;
  const maxPreviewLoads = 3;
  let previewObserver: IntersectionObserver | null = null;
  const dialogFocus = createDialogFocusManager(dialogHost);

  const announce = (message: string) => {
    liveRegion.textContent = "";
    queueMicrotask(() => { if (!disposed) liveRegion.textContent = message; });
  };

  const setConnection = (next: ConnectionState) => {
    connection = next;
    connectionNode.className = `party-connection is-${next}`;
    const label = next === "connected" ? "Live" : next === "offline" ? "Offline" : "Reconnecting";
    connectionNode.querySelector("span")!.textContent = label;
    fileInput.disabled = next === "offline";
    sendButton.disabled = sending || next === "offline";
  };

  const patchAttachmentPreviews = (id: string, url: string) => {
    app.querySelectorAll<HTMLElement>(`[data-party-attachment-preview="${CSS.escape(id)}"]`).forEach((node) => {
      const kind = node.dataset.partyPreviewKind;
      if (kind === "avatar") {
        const image = document.createElement("img");
        image.src = url;
        image.alt = "";
        node.parentElement?.replaceChildren(image);
        return;
      }
      const host = node.closest<HTMLElement>(".party-attachment-preview");
      if (!host) return;
      const label = node.closest(".party-attachment")?.querySelector("strong")?.textContent ?? "Attachment";
      let media: HTMLImageElement | HTMLVideoElement | HTMLAudioElement;
      if (kind === "video") {
        media = document.createElement("video");
        media.controls = true;
        media.preload = "metadata";
      } else if (kind === "audio") {
        media = document.createElement("audio");
        media.controls = true;
        media.preload = "metadata";
      } else {
        media = document.createElement("img");
        media.alt = label;
        media.loading = "lazy";
      }
      media.src = url;
      host.replaceChildren(media);
    });
  };

  const pumpPreviewQueue = () => {
    while (!disposed && activePreviewLoads < maxPreviewLoads && previewQueue.length > 0) {
      const node = previewQueue.shift()!;
      const id = node.dataset.partyAttachmentPreview;
      if (!id || objectUrls.has(id) || previewLoads.has(id)) {
        if (id) queuedPreviewIds.delete(id);
        continue;
      }
      const controller = new AbortController();
      previewLoads.set(id, controller);
      activePreviewLoads += 1;
      void fetchPartyAttachment(id, controller.signal)
        .then((response) => response.blob())
        .then((blob) => {
          if (disposed || controller.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          objectUrls.set(id, url);
          patchAttachmentPreviews(id, url);
        })
        .catch((error) => {
          if (!isAbortError(error) && node.isConnected) node.textContent = "Preview unavailable";
        })
        .finally(() => {
          previewLoads.delete(id);
          queuedPreviewIds.delete(id);
          activePreviewLoads -= 1;
          pumpPreviewQueue();
        });
    }
  };

  const enqueueAttachmentPreview = (node: HTMLElement) => {
    const id = node.dataset.partyAttachmentPreview;
    if (!id || objectUrls.has(id) || previewLoads.has(id) || queuedPreviewIds.has(id)) return;
    queuedPreviewIds.add(id);
    previewQueue.push(node);
    pumpPreviewQueue();
  };

  const hydrateAttachmentPreviews = () => {
    previewObserver?.disconnect();
    const nodes = [...app.querySelectorAll<HTMLElement>("[data-party-attachment-preview]")];
    if (!("IntersectionObserver" in window)) {
      nodes.forEach(enqueueAttachmentPreview);
      return;
    }
    previewObserver ??= new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        previewObserver?.unobserve(entry.target);
        enqueueAttachmentPreview(entry.target as HTMLElement);
      });
    }, { root: app, rootMargin: "240px" });
    nodes.forEach((node) => previewObserver?.observe(node));
  };

  const renderConversationList = () => {
    if (loadingConversations && conversations.length === 0) {
      conversationsNode.innerHTML = `
        <div class="party-list-loading" role="status" aria-label="Loading conversations">
          <i></i><i></i><i></i><i></i>
        </div>
      `;
      return;
    }
    if (listError && conversations.length === 0) {
      conversationsNode.innerHTML = `
        <div class="party-list-state is-error" role="alert">
          <strong>Conversations unavailable</strong>
          <span>${escapeHtml(listError)}</span>
          <button type="button" data-party-retry-list>Retry</button>
        </div>
      `;
      return;
    }
    conversationsNode.innerHTML = renderConversationItems(
      conversations,
      selectedConversation?.id ?? null,
      options.currentUserId,
      conversationCursor,
      objectUrls
    );
    hydrateAttachmentPreviews();
  };

  const renderThread = (scroll: "bottom" | "preserve" | "none" = "none") => {
    if (!selectedConversation) {
      emptyNode.hidden = false;
      threadShell.hidden = true;
      app.classList.remove("is-mobile-thread");
      return;
    }
    emptyNode.hidden = true;
    threadShell.hidden = false;
    threadHeader.innerHTML = renderThreadHeader(selectedConversation, options.currentUserId, objectUrls);
    messagesNode.setAttribute("aria-busy", String(loadingMessages));
    if (loadingMessages && messages.length === 0) {
      messagesNode.innerHTML = `<div class="party-thread-loading" role="status"><i></i><span>Loading messages…</span></div>`;
    } else if (threadError && messages.length === 0) {
      messagesNode.innerHTML = `
        <div class="party-message-empty is-error" role="alert">
          <strong>Messages unavailable</strong><p>${escapeHtml(threadError)}</p>
          <button type="button" data-party-retry-thread>Retry</button>
        </div>
      `;
    } else {
      const oldHeight = messageRegion.scrollHeight;
      const oldTop = messageRegion.scrollTop;
      messagesNode.innerHTML = renderMessages(
        messages,
        selectedConversation,
        options.currentUserId,
        messageCursor !== null,
        objectUrls
      );
      if (scroll === "bottom") {
        requestAnimationFrame(() => { messageRegion.scrollTop = messageRegion.scrollHeight; });
      } else if (scroll === "preserve") {
        requestAnimationFrame(() => { messageRegion.scrollTop = oldTop + messageRegion.scrollHeight - oldHeight; });
      }
      hydrateAttachmentPreviews();
    }
    composer.toggleAttribute("aria-busy", sending);
    sendButton.disabled = sending || connection === "offline";
  };

  const renderUploadTray = () => {
    const visibleUploads = uploads.filter((upload) => upload.conversationId === selectedConversation?.id);
    uploadTray.hidden = visibleUploads.length === 0;
    uploadTray.innerHTML = renderUploads(visibleUploads);
  };

  const renderNewDialog = () => {
    dialogHost.hidden = false;
    dialogHost.innerHTML = `
      <section class="party-dialog" role="dialog" aria-modal="true" aria-labelledby="party-new-title">
        <header>
          <div><small>New conversation</small><h2 id="party-new-title">${newMode === "direct" ? "Message someone" : "Create a group"}</h2></div>
          <button type="button" data-party-dialog-close aria-label="Close">×</button>
        </header>
        <div class="party-dialog-tabs" role="tablist" aria-label="Conversation type">
          <button type="button" role="tab" data-party-new-mode="direct" aria-selected="${newMode === "direct"}">Direct</button>
          <button type="button" role="tab" data-party-new-mode="group" aria-selected="${newMode === "group"}">Group</button>
        </div>
        ${newMode === "group" ? `
          <label class="party-group-title">
            <span>Group title</span>
            <input data-party-group-title maxlength="80" value="${escapeHtml(groupTitle)}" placeholder="Weekend crew" autocomplete="off" />
          </label>
        ` : ""}
        <label class="party-search party-user-search">
          <span class="sr-only">Search enabled accounts</span>
          <i aria-hidden="true">⌕</i>
          <input type="search" autocomplete="off" value="${escapeHtml(discoveryQuery)}" placeholder="Search enabled accounts" data-party-user-search />
        </label>
        <div class="party-user-results" data-party-user-results>
          ${renderUserResults(discoveryUsers, selectedUserIds, newMode, options.currentUserId)}
        </div>
        ${newMode === "group" ? `
          <footer>
            <span>${selectedUserIds.size} selected</span>
            <button type="button" data-party-create-group ${selectedUserIds.size === 0 ? "disabled" : ""}>Create group</button>
          </footer>
        ` : ""}
      </section>
    `;
  };

  const closeDialog = () => {
    dialog = null;
    dialogHost.hidden = true;
    dialogHost.innerHTML = "";
    discoveryController?.abort();
    discoveryController = null;
    selectedUserIds.clear();
    memberQuery = "";
    dialogFocus.deactivate(app.querySelector<HTMLButtonElement>("[data-party-new]"));
  };

  const loadDiscovery = async (query = discoveryQuery, forMembers = false) => {
    discoveryController?.abort();
    const controller = new AbortController();
    discoveryController = controller;
    try {
      const result = await searchPartyUsers(query, 40, controller.signal);
      if (disposed || controller.signal.aborted) return;
      discoveryUsers = result.users;
      if (dialog === "new") {
        renderNewDialog();
        const input = dialogHost.querySelector<HTMLInputElement>("[data-party-user-search]");
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      }
      else if (dialog === "members" && selectedConversation) {
        dialogHost.innerHTML = renderMembersDialog(selectedConversation, options.currentUserId, discoveryUsers, memberQuery);
        const input = dialogHost.querySelector<HTMLInputElement>("[data-party-member-search]");
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      }
    } catch (error) {
      if (isAbortError(error)) return;
      announce(error instanceof Error ? error.message : "Account search failed.");
      if (!forMembers) discoveryUsers = [];
    }
  };

  const openNewDialog = (trigger?: HTMLElement | null) => {
    dialog = "new";
    newMode = "direct";
    discoveryQuery = "";
    groupTitle = "";
    discoveryUsers = [];
    selectedUserIds.clear();
    renderNewDialog();
    void loadDiscovery();
    dialogFocus.activate(trigger, "[data-party-user-search]");
  };

  const openMembersDialog = (trigger?: HTMLElement | null) => {
    if (!selectedConversation || selectedConversation.kind !== "group") return;
    dialog = "members";
    memberQuery = "";
    discoveryUsers = [];
    dialogHost.hidden = false;
    dialogHost.innerHTML = renderMembersDialog(selectedConversation, options.currentUserId, discoveryUsers, memberQuery);
    void loadDiscovery("", true);
    dialogFocus.activate(trigger, "[data-party-dialog-close]");
  };

  const mergeMessages = (incoming: PartyMessage[]) => {
    const byId = new Map(messages.map((message) => [message.id, message]));
    incoming.forEach((message) => byId.set(message.id, message));
    messages = [...byId.values()].sort((a, b) => a.sequence - b.sequence);
  };

  const markLatestRead = () => {
    if (!selectedConversation || document.visibilityState === "hidden") return;
    const sequence = messages.at(-1)?.sequence;
    if (!sequence) return;
    const conversationId = selectedConversation.id;
    void markPartyConversationRead(conversationId, sequence).then(() => {
      const item = conversations.find((candidate) => candidate.id === conversationId);
      if (item) item.unreadCount = 0;
      renderConversationList();
    }).catch(() => {});
  };

  const loadMessages = async (conversation: PartyConversation, older = false) => {
    if (loadingMessages) return;
    messageController?.abort();
    const controller = new AbortController();
    messageController = controller;
    loadingMessages = true;
    threadError = "";
    renderThread();
    try {
      const page = await listPartyMessages(conversation.id, {
        beforeSequence: older ? messageCursor ?? undefined : undefined,
        limit: 50,
        signal: controller.signal
      });
      if (disposed || controller.signal.aborted || selectedConversation?.id !== conversation.id) return;
      if (!older) messages = [];
      mergeMessages(page.messages);
      messageCursor = page.nextCursor;
      renderThread(older ? "preserve" : "bottom");
      markLatestRead();
    } catch (error) {
      if (isAbortError(error)) return;
      threadError = error instanceof Error ? error.message : "Messages could not be loaded.";
      renderThread();
    } finally {
      if (messageController === controller) messageController = null;
      loadingMessages = false;
      messagesNode.setAttribute("aria-busy", "false");
    }
  };

  const selectConversation = async (conversationId: string) => {
    if (selectedConversation?.id === conversationId && messages.length > 0) {
      app.classList.add("is-mobile-thread");
      messageInput.focus();
      return;
    }
    const listConversation = conversations.find((conversation) => conversation.id === conversationId);
    if (!listConversation) return;
    messageController?.abort();
    messageController = null;
    loadingMessages = false;
    selectedConversation = listConversation;
    messages = [];
    messageCursor = null;
    threadError = "";
    app.classList.add("is-mobile-thread");
    renderUploadTray();
    renderConversationList();
    renderThread();
    try {
      const detail = await getPartyConversation(conversationId);
      if (disposed || selectedConversation?.id !== conversationId) return;
      selectedConversation = detail.conversation;
      const index = conversations.findIndex((conversation) => conversation.id === conversationId);
      if (index >= 0) conversations[index] = { ...conversations[index], ...detail.conversation };
      renderConversationList();
      renderThread();
      await loadMessages(detail.conversation);
    } catch (error) {
      if (disposed || selectedConversation?.id !== conversationId) return;
      threadError = error instanceof Error ? error.message : "Conversation unavailable.";
      renderThread();
    }
  };

  const loadConversations = async (append = false, preserveSelection = true) => {
    conversationController?.abort();
    const controller = new AbortController();
    conversationController = controller;
    loadingConversations = true;
    listError = "";
    renderConversationList();
    try {
      const page = await listPartyConversations({
        cursor: append ? conversationCursor ?? undefined : undefined,
        limit: 60,
        query: conversationQuery,
        signal: controller.signal
      });
      if (disposed || controller.signal.aborted) return;
      if (append) {
        const merged = new Map(conversations.map((item) => [item.id, item]));
        page.conversations.forEach((item) => merged.set(item.id, item));
        conversations = [...merged.values()];
      } else {
        conversations = page.conversations;
      }
      conversationCursor = page.nextCursor;
      const selectedId = preserveSelection ? selectedConversation?.id : null;
      if (selectedId) {
        const latest = conversations.find((candidate) => candidate.id === selectedId);
        if (latest && selectedConversation) selectedConversation = { ...latest, members: selectedConversation.members };
      }
      loadingConversations = false;
      renderConversationList();
    } catch (error) {
      if (isAbortError(error)) return;
      listError = error instanceof Error ? error.message : "Conversations could not be loaded.";
      loadingConversations = false;
      renderConversationList();
    } finally {
      if (conversationController === controller) conversationController = null;
    }
  };

  const refreshSelected = async () => {
    const id = selectedConversation?.id;
    if (!id) return;
    try {
      const shouldStickToLatest =
        messageRegion.scrollHeight - messageRegion.scrollTop - messageRegion.clientHeight < 120;
      const [detail, page] = await Promise.all([
        getPartyConversation(id),
        listPartyMessages(id, { limit: 50 })
      ]);
      if (disposed || selectedConversation?.id !== id) return;
      selectedConversation = detail.conversation;
      mergeMessages(page.messages);
      renderThread(shouldStickToLatest ? "bottom" : "none");
      markLatestRead();
    } catch {
      // A transient SSE refresh failure is retried by reconnect/focus resync.
    }
  };

  const resync = (conversationId?: string) => {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      void loadConversations(false, true);
      if (!conversationId || selectedConversation?.id === conversationId) void refreshSelected();
    }, 180);
  };

  const scheduleReconnect = () => {
    if (disposed || !navigator.onLine) {
      setConnection("offline");
      return;
    }
    setConnection("reconnecting");
    const delay = Math.min(30_000, 1_000 * (2 ** reconnectAttempt));
    reconnectAttempt = Math.min(reconnectAttempt + 1, 5);
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(startEventStream, delay);
  };

  const startEventStream = () => {
    if (disposed || eventController || !navigator.onLine) {
      if (!navigator.onLine) setConnection("offline");
      return;
    }
    const controller = new AbortController();
    eventController = controller;
    void streamPartyEvents({
      onEvent: (event) => resync(event.conversationId),
      onOpen: () => {
        reconnectAttempt = 0;
        setConnection("connected");
      },
      signal: controller.signal
    }).then(() => {
      if (!controller.signal.aborted) scheduleReconnect();
    }).catch((error) => {
      if (!isAbortError(error)) scheduleReconnect();
    }).finally(() => {
      if (eventController === controller) eventController = null;
    });
  };

  const sendCurrentMessage = async () => {
    if (!selectedConversation || sending) return;
    if (connection === "offline") {
      announce("Party is offline. Your draft is still here.");
      return;
    }
    const text = messageInput.value;
    if (!text.trim()) return;
    sending = true;
    sendButton.disabled = true;
    composer.classList.add("is-sending");
    try {
      const result = await sendPartyMessage(selectedConversation.id, text, clientId());
      if (disposed) return;
      mergeMessages([result.message]);
      messageInput.value = "";
      messageInput.style.height = "";
      renderThread("bottom");
      announce(result.duplicate ? "Message already delivered." : "Message sent.");
      void loadConversations(false, true);
    } catch (error) {
      if (!disposed) announce(error instanceof Error ? error.message : "Message could not be sent.");
    } finally {
      sending = false;
      sendButton.disabled = false;
      composer.classList.remove("is-sending");
      messageInput.focus();
    }
  };

  const beginUpload = (upload: UploadState) => {
    if (upload.file.size > 25 * 1024 * 1024) {
      upload.status = "failed";
      upload.error = "Files must be 25 MB or smaller.";
      renderUploadTray();
      return;
    }
    upload.status = "uploading";
    upload.error = "";
    upload.progress = 0;
    const conversationId = upload.conversationId;
    const handle = uploadPartyAttachment(conversationId, upload.file, clientId(), (loaded, total) => {
      upload.progress = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
      renderUploadTray();
    });
    upload.handle = handle;
    renderUploadTray();
    void handle.promise.then((result) => {
      if (disposed) return;
      upload.progress = 100;
      upload.status = "complete";
      upload.handle = null;
      if (selectedConversation?.id === conversationId) {
        mergeMessages([result.message]);
        renderThread("bottom");
      }
      renderUploadTray();
      announce(`${upload.file.name} sent.`);
      void loadConversations(false, true);
    }).catch((error) => {
      if (disposed) return;
      upload.handle = null;
      if (isAbortError(error)) {
        upload.status = "cancelled";
        upload.error = "";
      } else {
        upload.status = "failed";
        upload.error = error instanceof Error ? error.message : "Upload failed.";
      }
      renderUploadTray();
    });
  };

  const handleFiles = (files: FileList | File[]) => {
    if (!selectedConversation) return;
    const conversationId = selectedConversation.id;
    [...files].slice(0, 4).forEach((file) => {
      const upload: UploadState = {
        error: "",
        conversationId,
        file,
        handle: null,
        id: clientId(),
        progress: 0,
        status: "uploading"
      };
      uploads.push(upload);
      beginUpload(upload);
    });
    fileInput.value = "";
  };

  app.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-party-close]")) { options.onClose?.(); return; }
    if (target.closest("[data-party-new]")) { openNewDialog(target.closest<HTMLElement>("[data-party-new]")); return; }
    if (target.closest("[data-party-dialog-close]")) { closeDialog(); return; }
    if (target.closest("[data-party-mobile-back]")) {
      app.classList.remove("is-mobile-thread");
      app.querySelector<HTMLButtonElement>(`[data-party-conversation="${CSS.escape(selectedConversation?.id ?? "")}"]`)?.focus();
      return;
    }
    if (target.closest("[data-party-members]")) { openMembersDialog(target.closest<HTMLElement>("[data-party-members]")); return; }
    if (target.closest("[data-party-retry-list]")) { void loadConversations(); return; }
    if (target.closest("[data-party-retry-thread]") && selectedConversation) { void loadMessages(selectedConversation); return; }
    if (target.closest("[data-party-more-conversations]")) { void loadConversations(true); return; }
    if (target.closest("[data-party-older]") && selectedConversation) { void loadMessages(selectedConversation, true); return; }

    const conversationButton = target.closest<HTMLButtonElement>("[data-party-conversation]");
    if (conversationButton?.dataset.partyConversation) {
      void selectConversation(conversationButton.dataset.partyConversation);
      return;
    }
    const modeButton = target.closest<HTMLButtonElement>("[data-party-new-mode]");
    if (modeButton?.dataset.partyNewMode === "direct" || modeButton?.dataset.partyNewMode === "group") {
      newMode = modeButton.dataset.partyNewMode;
      selectedUserIds.clear();
      renderNewDialog();
      queueMicrotask(() => dialogHost.querySelector<HTMLInputElement>("[data-party-user-search]")?.focus());
      return;
    }
    const userButton = target.closest<HTMLButtonElement>("[data-party-user]");
    if (userButton?.dataset.partyUser) {
      const userId = userButton.dataset.partyUser;
      if (newMode === "direct") {
        userButton.disabled = true;
        void createPartyDirectConversation(userId).then(({ conversation }) => {
          closeDialog();
          const existing = conversations.findIndex((item) => item.id === conversation.id);
          if (existing >= 0) conversations[existing] = conversation;
          else conversations.unshift(conversation);
          renderConversationList();
          void selectConversation(conversation.id);
        }).catch((error) => {
          userButton.disabled = false;
          announce(error instanceof Error ? error.message : "Conversation could not be created.");
        });
      } else {
        if (selectedUserIds.has(userId)) selectedUserIds.delete(userId);
        else selectedUserIds.add(userId);
        renderNewDialog();
      }
      return;
    }
    if (target.closest("[data-party-create-group]")) {
      const title = groupTitle.trim();
      if (!title) {
        announce("Add a group title.");
        dialogHost.querySelector<HTMLInputElement>("[data-party-group-title]")?.focus();
        return;
      }
      const button = target.closest<HTMLButtonElement>("[data-party-create-group]")!;
      button.disabled = true;
      void createPartyGroupConversation({ memberIds: [...selectedUserIds], title }).then(({ conversation }) => {
        closeDialog();
        conversations.unshift(conversation);
        renderConversationList();
        void selectConversation(conversation.id);
      }).catch((error) => {
        button.disabled = false;
        announce(error instanceof Error ? error.message : "Group could not be created.");
      });
      return;
    }
    const addMember = target.closest<HTMLButtonElement>("[data-party-add-member]");
    if (addMember?.dataset.partyAddMember && selectedConversation) {
      addMember.disabled = true;
      void addPartyConversationMember(selectedConversation.id, addMember.dataset.partyAddMember).then(({ conversation }) => {
        selectedConversation = conversation;
        openMembersDialog();
        renderThread();
        announce("Member added.");
      }).catch((error) => {
        addMember.disabled = false;
        announce(error instanceof Error ? error.message : "Member could not be added.");
      });
      return;
    }
    const removeMember = target.closest<HTMLButtonElement>("[data-party-remove-member]");
    if (removeMember?.dataset.partyRemoveMember && selectedConversation) {
      removeMember.disabled = true;
      void removePartyConversationMember(selectedConversation.id, removeMember.dataset.partyRemoveMember).then(({ conversation }) => {
        selectedConversation = conversation;
        openMembersDialog();
        renderThread();
        announce("Member removed.");
      }).catch((error) => {
        removeMember.disabled = false;
        announce(error instanceof Error ? error.message : "Member could not be removed.");
      });
      return;
    }
    const cancelUpload = target.closest<HTMLButtonElement>("[data-party-cancel-upload]");
    if (cancelUpload?.dataset.partyCancelUpload) {
      uploads.find((item) => item.id === cancelUpload.dataset.partyCancelUpload)?.handle?.cancel();
      return;
    }
    const retryUpload = target.closest<HTMLButtonElement>("[data-party-retry-upload]");
    if (retryUpload?.dataset.partyRetryUpload) {
      const upload = uploads.find((item) => item.id === retryUpload.dataset.partyRetryUpload);
      if (upload) beginUpload(upload);
      return;
    }
    const dismissUpload = target.closest<HTMLButtonElement>("[data-party-dismiss-upload]");
    if (dismissUpload?.dataset.partyDismissUpload) {
      uploads = uploads.filter((item) => item.id !== dismissUpload.dataset.partyDismissUpload);
      renderUploadTray();
      return;
    }
    const download = target.closest<HTMLButtonElement>("[data-party-download]");
    if (download?.dataset.partyDownload && download.dataset.partyDownloadName) {
      download.disabled = true;
      void downloadPartyAttachment(download.dataset.partyDownload, download.dataset.partyDownloadName)
        .catch((error) => announce(error instanceof Error ? error.message : "Download failed."))
        .finally(() => { download.disabled = false; });
    }
  }, { signal: viewController.signal });

  app.addEventListener("submit", (event) => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>("form");
    if (!form) return;
    if (form.matches("[data-party-composer]")) {
      event.preventDefault();
      void sendCurrentMessage();
      return;
    }
    if (form.matches("[data-party-group-details]") && selectedConversation) {
      event.preventDefault();
      const title = new FormData(form).get("title");
      if (typeof title !== "string" || !title.trim()) return;
      void updatePartyConversation(selectedConversation.id, { title: title.trim() }).then(({ conversation }) => {
        selectedConversation = conversation;
        renderThread();
        renderConversationList();
        announce("Group title updated.");
      }).catch((error) => announce(error instanceof Error ? error.message : "Group could not be updated."));
    }
  }, { signal: viewController.signal });

  app.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;
    if (target === fileInput) {
      if (fileInput.files) handleFiles(fileInput.files);
      return;
    }
    const role = target.closest<HTMLSelectElement>("[data-party-member-role]");
    if (role?.dataset.partyMemberRole && selectedConversation) {
      role.disabled = true;
      void updatePartyConversationMember(
        selectedConversation.id,
        role.dataset.partyMemberRole,
        role.value as Exclude<PartyMemberRole, "owner">
      ).then(({ conversation }) => {
        selectedConversation = conversation;
        openMembersDialog();
        announce("Member role updated.");
      }).catch((error) => {
        role.disabled = false;
        announce(error instanceof Error ? error.message : "Role could not be updated.");
      });
      return;
    }
    const avatar = target.closest<HTMLInputElement>("[data-party-avatar]");
    const image = avatar?.files?.[0];
    if (avatar && image && selectedConversation) {
      const conversationId = selectedConversation.id;
      const handle = uploadPartyAttachment(conversationId, image, clientId(), () => {});
      avatar.disabled = true;
      void handle.promise.then(async ({ message }) => {
        const attachmentId = message.attachments[0]?.id;
        if (!attachmentId) throw new Error("The image upload did not return an attachment.");
        const { conversation } = await updatePartyConversation(conversationId, { avatarAttachmentId: attachmentId });
        selectedConversation = conversation;
        renderThread();
        renderConversationList();
        openMembersDialog();
        announce("Group image updated.");
      }).catch((error) => {
        avatar.disabled = false;
        announce(error instanceof Error ? error.message : "Group image could not be updated.");
      });
    }
  }, { signal: viewController.signal });

  app.addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    if (target === messageInput) {
      messageInput.style.height = "auto";
      messageInput.style.height = `${Math.min(messageInput.scrollHeight, 144)}px`;
      return;
    }
    const titleInput = target.closest<HTMLInputElement>("[data-party-group-title]");
    if (titleInput) {
      groupTitle = titleInput.value;
      return;
    }
    if (target === searchInput) {
      conversationQuery = searchInput.value.trim();
      window.clearTimeout(conversationSearchTimer);
      conversationSearchTimer = window.setTimeout(() => void loadConversations(false, true), 250);
      return;
    }
    const userSearch = target.closest<HTMLInputElement>("[data-party-user-search]");
    if (userSearch) {
      discoveryQuery = userSearch.value;
      window.clearTimeout(discoveryTimer);
      discoveryTimer = window.setTimeout(() => void loadDiscovery(), 220);
      return;
    }
    const memberSearch = target.closest<HTMLInputElement>("[data-party-member-search]");
    if (memberSearch) {
      memberQuery = memberSearch.value;
      window.clearTimeout(discoveryTimer);
      discoveryTimer = window.setTimeout(() => void loadDiscovery(memberQuery, true), 220);
    }
  }, { signal: viewController.signal });

  app.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (target === messageInput && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendCurrentMessage();
      return;
    }
    if (dialog && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeDialog();
      return;
    }
    if (dialog && dialogFocus.handleKeydown(event)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    const conversationButton = target.closest<HTMLButtonElement>("[data-party-conversation]");
    if (conversationButton && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const buttons = [...conversationsNode.querySelectorAll<HTMLButtonElement>("[data-party-conversation]")];
      const index = buttons.indexOf(conversationButton);
      buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    }
  }, { signal: viewController.signal });

  const onOffline = () => {
    window.clearTimeout(reconnectTimer);
    eventController?.abort();
    previewObserver?.disconnect();
    previewObserver = null;
    previewQueue.length = 0;
    queuedPreviewIds.clear();
    eventController = null;
    setConnection("offline");
    announce("Party is offline. Messages will not send until the connection returns.");
  };
  const onOnline = () => {
    setConnection("reconnecting");
    reconnectAttempt = 0;
    startEventStream();
    resync();
  };
  const onFocus = () => resync();
  window.addEventListener("offline", onOffline, { signal: viewController.signal });
  window.addEventListener("online", onOnline, { signal: viewController.signal });
  window.addEventListener("focus", onFocus, { signal: viewController.signal });

  renderConversationList();
  renderThread();
  renderUploadTray();
  setConnection(connection);
  void loadConversations(false, false);
  startEventStream();
  queueMicrotask(() => app.focus({ preventScroll: true }));

  return () => {
    if (disposed) return;
    disposed = true;
    viewController.abort();
    conversationController?.abort();
    messageController?.abort();
    discoveryController?.abort();
    eventController?.abort();
    previewLoads.forEach((controller) => controller.abort());
    uploads.forEach((upload) => upload.handle?.cancel());
    window.clearTimeout(reconnectTimer);
    window.clearTimeout(conversationSearchTimer);
    window.clearTimeout(discoveryTimer);
    window.clearTimeout(refreshTimer);
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
  };
};
