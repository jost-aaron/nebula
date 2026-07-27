import {
  apiFetch,
  apiHeaders,
  apiJson,
  apiUrl,
  applyApiHeadersToRequest,
  ApiError
} from "./http";
import type {
  PartyApiErrorBody,
  PartyAttachmentUploadResponse,
  PartyConversation,
  PartyConversationList,
  PartyConversationResponse,
  PartyEvent,
  PartyExportPage,
  PartyMemberRole,
  PartyMessagePage,
  PartyMessageResponse,
  PartyNullableConversationResponse,
  PartyUsersResponse
} from "../shared/partyTypes";

const partyPath = (suffix = "") => `/api/party${suffix}`;
const conversationPath = (conversationId: string, suffix = "") =>
  partyPath(`/conversations/${encodeURIComponent(conversationId)}${suffix}`);

const withQuery = (path: string, values: Record<string, number | string | undefined>) => {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== "") query.set(key, String(value));
  });
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
};

export const searchPartyUsers = (query: string, limit = 30, signal?: AbortSignal) =>
  apiJson<PartyUsersResponse>(withQuery(partyPath("/users"), { limit, q: query.trim() }), {
    method: "GET",
    signal
  });

export const listPartyConversations = (
  options: { cursor?: string; limit?: number; query?: string; signal?: AbortSignal } = {}
) =>
  apiJson<PartyConversationList>(
    withQuery(partyPath("/conversations"), {
      cursor: options.cursor,
      limit: options.limit ?? 60,
      q: options.query?.trim()
    }),
    { method: "GET", signal: options.signal }
  );

export const getPartyConversation = (conversationId: string, signal?: AbortSignal) =>
  apiJson<PartyConversationResponse>(conversationPath(conversationId), { method: "GET", signal });

export const createPartyDirectConversation = (userId: string) =>
  apiJson<PartyConversationResponse>(partyPath("/direct"), {
    body: JSON.stringify({ userId }),
    method: "POST"
  });

export const createPartyGroupConversation = (body: {
  avatarAttachmentId?: string;
  memberIds: string[];
  title: string;
}) =>
  apiJson<PartyConversationResponse>(partyPath("/groups"), {
    body: JSON.stringify(body),
    method: "POST"
  });

export const updatePartyConversation = (
  conversationId: string,
  body: { avatarAttachmentId?: string | null; title?: string }
) =>
  apiJson<PartyConversationResponse>(conversationPath(conversationId), {
    body: JSON.stringify(body),
    method: "PATCH"
  });

export const addPartyConversationMember = (
  conversationId: string,
  userId: string,
  role: Exclude<PartyMemberRole, "owner"> = "member"
) =>
  apiJson<PartyConversationResponse>(conversationPath(conversationId, "/members"), {
    body: JSON.stringify({ role, userId }),
    method: "POST"
  });

export const updatePartyConversationMember = (
  conversationId: string,
  userId: string,
  role: Exclude<PartyMemberRole, "owner">
) =>
  apiJson<PartyConversationResponse>(
    conversationPath(conversationId, `/members/${encodeURIComponent(userId)}`),
    { body: JSON.stringify({ role }), method: "PATCH" }
  );

export const removePartyConversationMember = (conversationId: string, userId: string) =>
  apiJson<PartyNullableConversationResponse>(
    conversationPath(conversationId, `/members/${encodeURIComponent(userId)}`),
    { method: "DELETE" }
  );

export const listPartyMessages = (
  conversationId: string,
  options: { beforeSequence?: number; limit?: number; signal?: AbortSignal } = {}
) =>
  apiJson<PartyMessagePage>(
    withQuery(conversationPath(conversationId, "/messages"), {
      beforeSequence: options.beforeSequence,
      limit: options.limit ?? 50
    }),
    { method: "GET", signal: options.signal }
  );

export const sendPartyMessage = (conversationId: string, text: string, clientId: string) =>
  apiJson<PartyMessageResponse>(conversationPath(conversationId, "/messages"), {
    body: JSON.stringify({ clientId, text }),
    method: "POST"
  });

export const markPartyConversationRead = (conversationId: string, sequence: number) =>
  apiJson<{ ok: true }>(conversationPath(conversationId, "/read"), {
    body: JSON.stringify({ sequence }),
    method: "POST"
  });

export const deletePartyConversation = (conversationId: string) =>
  apiJson<{ deleted: true }>(conversationPath(conversationId), {
    body: JSON.stringify({ confirmId: conversationId }),
    method: "DELETE"
  });

export const downloadPartyConversationExport = async (conversationId: string) => {
  let cursor: number | undefined;
  let first: PartyExportPage | null = null;
  const pages: PartyExportPage["messages"][] = [];
  do {
    const page = await apiJson<PartyExportPage>(withQuery(conversationPath(conversationId, "/export"), {
      beforeSequence: cursor,
      limit: 500
    }), { method: "GET" });
    first ??= page;
    pages.push(page.messages);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  if (!first) throw new ApiError("Conversation export is unavailable.", 500);
  const payload = {
    conversation: first.conversation,
    exportedAt: new Date().toISOString(),
    format: first.format,
    formatVersion: first.formatVersion,
    messages: pages.reverse().flat(),
    privacy: first.privacy
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `nebula-party-${conversationId}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

const parseXhrError = (request: XMLHttpRequest) => {
  try {
    const body = JSON.parse(request.responseText || "{}") as PartyApiErrorBody;
    return new ApiError(body.error ?? "Upload failed.", request.status, body.code);
  } catch {
    return new ApiError(request.responseText || "Upload failed.", request.status);
  }
};

export interface PartyUploadHandle {
  cancel: () => void;
  promise: Promise<PartyAttachmentUploadResponse>;
}

export const uploadPartyAttachment = (
  conversationId: string,
  file: File,
  clientId: string,
  onProgress: (loaded: number, total: number) => void
): PartyUploadHandle => {
  const request = new XMLHttpRequest();
  const promise = new Promise<PartyAttachmentUploadResponse>((resolve, reject) => {
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(JSON.parse(request.responseText) as PartyAttachmentUploadResponse);
        } catch {
          reject(new Error("The server returned an invalid upload response."));
        }
      } else {
        reject(parseXhrError(request));
      }
    });
    request.addEventListener("abort", () => reject(new DOMException("Upload cancelled.", "AbortError")));
    request.addEventListener("error", () => reject(new Error("Upload failed. Check the connection and retry.")));

    request.open(
      "POST",
      apiUrl(withQuery(conversationPath(conversationId, "/attachments"), {
        clientId
      }))
    );
    applyApiHeadersToRequest(request, {
      "content-type": file.type || "application/octet-stream",
      "x-nebula-file-name": encodeURIComponent(file.name)
    });
    request.send(file);
  });

  return { cancel: () => request.abort(), promise };
};

export const fetchPartyAttachment = (
  attachmentId: string,
  signal?: AbortSignal,
  download = false
) =>
  apiFetch(withQuery(partyPath(`/attachments/${encodeURIComponent(attachmentId)}`), {
    download: download ? 1 : undefined
  }), {
    method: "GET",
    signal
  }).then(async (response) => {
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText })) as PartyApiErrorBody;
      throw new ApiError(body.error ?? "Attachment unavailable.", response.status, body.code);
    }
    return response;
  });

export const downloadPartyAttachment = async (attachmentId: string, displayName: string) => {
  const response = await fetchPartyAttachment(attachmentId, undefined, true);
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = displayName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
};

const decodeSseFrame = (frame: string): PartyEvent | null => {
  let eventType = "message";
  const data: string[] = [];
  frame.split(/\r?\n/).forEach((line) => {
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  });
  if (eventType !== "ready" && eventType !== "conversation") return null;
  try {
    const parsed = JSON.parse(data.join("\n") || "{}") as { conversationId?: unknown };
    return {
      conversationId: typeof parsed.conversationId === "string" ? parsed.conversationId : undefined,
      type: eventType
    };
  } catch {
    return null;
  }
};

export const streamPartyEvents = async (options: {
  onEvent: (event: PartyEvent) => void;
  onOpen?: () => void;
  signal: AbortSignal;
}) => {
  const response = await fetch(apiUrl(partyPath("/events")), {
    credentials: "include",
    headers: apiHeaders({ accept: "text/event-stream" }),
    method: "GET",
    signal: options.signal
  });
  if (response.status === 401) window.dispatchEvent(new CustomEvent("nebula:session-expired"));
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as PartyApiErrorBody;
    throw new ApiError(body.error ?? "Party live updates are unavailable.", response.status, body.code);
  }

  options.onOpen?.();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (!options.signal.aborted) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() ?? "";
      frames.forEach((frame) => {
        const event = decodeSseFrame(frame);
        if (event) options.onEvent(event);
      });
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
};
