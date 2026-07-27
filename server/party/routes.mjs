import { json, readBody } from "../http.mjs";

const PARTY_BODY_LIMIT = 64 * 1024;
const UUID_PATH = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const conversationRoute = new RegExp(`^/api/party/conversations/${UUID_PATH}$`, "i");
const memberRoute = new RegExp(`^/api/party/conversations/${UUID_PATH}/members/${UUID_PATH}$`, "i");
const membersRoute = new RegExp(`^/api/party/conversations/${UUID_PATH}/members$`, "i");
const messagesRoute = new RegExp(`^/api/party/conversations/${UUID_PATH}/messages$`, "i");
const readRoute = new RegExp(`^/api/party/conversations/${UUID_PATH}/read$`, "i");
const uploadRoute = new RegExp(`^/api/party/conversations/${UUID_PATH}/attachments$`, "i");
const attachmentRoute = new RegExp(`^/api/party/attachments/${UUID_PATH}$`, "i");

const accountId = (request) => {
  const context = request.nebulaAuth;
  if (context?.kind !== "account" || !context.user?.id || context.user.disabled) {
    throw Object.assign(new Error("An enabled Nebula account is required."), {
      code: "party_account_required", expose: true, status: 403
    });
  }
  return context.user.id;
};

const decodeHeader = (value) => {
  try { return decodeURIComponent(String(value ?? "")); } catch {
    throw Object.assign(new Error("Attachment filename is invalid."), {
      code: "invalid_attachment_name", expose: true, status: 400
    });
  }
};

export const createPartyRoutes = ({ attachments = null, events = null, service } = {}) => {
  if (!service) throw new TypeError("A Party service is required.");

  return async (request, response, url) => {
    if (!url.pathname.startsWith("/api/party")) return false;

    if (request.method === "GET" && url.pathname === "/api/party/events") {
      if (!events) {
        json(response, 503, { code: "party_events_unavailable", error: "Party events are unavailable." });
        return true;
      }
      accountId(request);
      events.subscribe(request, response, request.nebulaAuth);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/party/users") {
      json(response, 200, {
        users: service.discoverUsers({
          limit: url.searchParams.get("limit"),
          query: url.searchParams.get("q")
        }, request.nebulaAuth)
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/party/direct") {
      const result = service.createDirect(
        await readBody(request, { limit: PARTY_BODY_LIMIT }), request.nebulaAuth
      );
      json(response, result.created ? 201 : 200, result);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/party/groups") {
      const conversation = service.createGroup(
        await readBody(request, { limit: PARTY_BODY_LIMIT }), request.nebulaAuth
      );
      json(response, 201, { conversation });
      return true;
    }

    if (url.pathname === "/api/party/conversations" && request.method === "GET") {
      json(response, 200, service.listConversations({
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit"),
        query: url.searchParams.get("q")
      }, request.nebulaAuth));
      return true;
    }

    const attachmentMatch = attachmentRoute.exec(url.pathname);
    if (attachmentMatch && ["GET", "HEAD"].includes(request.method)) {
      if (!attachments) {
        json(response, 404, { code: "party_attachment_not_found", error: "Attachment not found." });
        return true;
      }
      await attachments.serve({
        attachmentId: attachmentMatch[1],
        download: url.searchParams.get("download") === "1",
        request,
        response,
        userId: accountId(request)
      });
      return true;
    }

    const uploadMatch = uploadRoute.exec(url.pathname);
    if (uploadMatch && request.method === "POST") {
      if (!attachments) {
        json(response, 503, { code: "party_attachments_unavailable", error: "Party attachments are unavailable." });
        return true;
      }
      const context = request.nebulaAuth;
      const conversationId = uploadMatch[1];
      const userId = accountId(request);
      const clientMessageId = url.searchParams.get("clientId")
        ?? request.headers["x-nebula-client-id"]
        ?? null;
      const result = await attachments.upload({
        clientMessageId,
        commit: (metadata, options = {}) => service.createAttachmentMessage(
          conversationId,
          metadata,
          options.clientMessageId ?? clientMessageId,
          context,
          { conversationQuotaBytes: options.conversationQuotaBytes }
        ),
        conversationId,
        declaredMimeType: request.headers["content-type"],
        displayName: decodeHeader(request.headers["x-nebula-file-name"]),
        request,
        userId
      });
      json(response, 201, {
        ...result,
        attachment: result.attachment ?? result.message?.attachments?.[0]
      });
      return true;
    }

    const memberMatch = memberRoute.exec(url.pathname);
    if (memberMatch) {
      const [, conversationId, userId] = memberMatch;
      if (request.method === "PATCH") {
        const conversation = service.updateMemberRole(
          conversationId, userId,
          await readBody(request, { limit: PARTY_BODY_LIMIT }),
          request.nebulaAuth
        );
        json(response, 200, { conversation });
        return true;
      }
      if (request.method === "DELETE") {
        const conversation = service.removeMember(conversationId, userId, request.nebulaAuth);
        json(response, 200, { conversation });
        return true;
      }
    }

    const membersMatch = membersRoute.exec(url.pathname);
    if (membersMatch && request.method === "POST") {
      const conversation = service.addMember(
        membersMatch[1],
        await readBody(request, { limit: PARTY_BODY_LIMIT }),
        request.nebulaAuth
      );
      json(response, 200, { conversation });
      return true;
    }

    const messagesMatch = messagesRoute.exec(url.pathname);
    if (messagesMatch) {
      const conversationId = messagesMatch[1];
      if (request.method === "GET") {
        json(response, 200, service.listMessages(conversationId, {
          beforeSequence: url.searchParams.get("beforeSequence") ?? url.searchParams.get("cursor"),
          limit: url.searchParams.get("limit")
        }, request.nebulaAuth));
        return true;
      }
      if (request.method === "POST") {
        const result = service.sendMessage(
          conversationId,
          await readBody(request, { limit: PARTY_BODY_LIMIT }),
          request.nebulaAuth
        );
        json(response, result.duplicate ? 200 : 201, result);
        return true;
      }
    }

    const readMatch = readRoute.exec(url.pathname);
    if (readMatch && request.method === "POST") {
      json(response, 200, {
        ok: true,
        read: service.markRead(
          readMatch[1],
          await readBody(request, { limit: PARTY_BODY_LIMIT }),
          request.nebulaAuth
        )
      });
      return true;
    }

    const conversationMatch = conversationRoute.exec(url.pathname);
    if (conversationMatch) {
      const conversationId = conversationMatch[1];
      if (request.method === "GET") {
        json(response, 200, {
          conversation: service.getConversation(conversationId, request.nebulaAuth)
        });
        return true;
      }
      if (request.method === "PATCH") {
        const conversation = service.updateGroup(
          conversationId,
          await readBody(request, { limit: PARTY_BODY_LIMIT }),
          request.nebulaAuth
        );
        json(response, 200, { conversation });
        return true;
      }
    }

    return false;
  };
};
