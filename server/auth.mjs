import { timingSafeEqual } from "node:crypto";
import { json } from "./http.mjs";

export const SESSION_COOKIE = "nebula_session";
const localhostAddresses = new Set(["127.0.0.1", "::1"]);
const publicAuthRoutes = new Set([
  "GET /api/auth/status",
  "POST /api/auth/setup",
  "POST /api/auth/login",
  "POST /api/auth/guest"
]);

const normalizedRemoteAddress = (request) =>
  (request.socket.remoteAddress ?? "").toLowerCase().replace(/^::ffff:/, "").split("%")[0];

export const isTrustedLocalAddress = (address) => {
  const value = String(address ?? "").toLowerCase().replace(/^::ffff:/, "").split("%")[0];
  if (localhostAddresses.has(value) || value === "::") return true;
  if (/^10\./.test(value) || /^192\.168\./.test(value) || /^169\.254\./.test(value)) return true;
  const match = /^172\.(\d{1,3})\./.exec(value);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value);
};

const decodeCookie = (value) => {
  try { return decodeURIComponent(value); } catch { return ""; }
};

const parseCookies = (request) => Object.fromEntries(
  String(request.headers.cookie ?? "").slice(0, 8192).split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? [part, ""] : [part.slice(0, separator), decodeCookie(part.slice(separator + 1))];
  })
);

const bearerToken = (request) => {
  const match = /^Bearer ([^\s]+)$/.exec(String(request.headers.authorization ?? ""));
  return match?.[1] ?? "";
};

const constantTimeTokenMatch = (actual, expected) => {
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};

export const capabilitiesForRole = (role) => new Set(role === "owner"
  ? ["account.use", "dashboard.use", "files.read", "files.write", "media.manage", "media.read", "playback.persist", "server.admin", "watchlist.write"]
  : ["account.use", "dashboard.use", "files.read", "media.read", "playback.persist", "watchlist.write"]);

export const guestCapabilities = () => new Set(["account.use", "dashboard.use", "media.read"]);

const capabilityForRoute = (request, url) => {
  const method = request.method ?? "GET";
  const path = url.pathname;
  if (path === "/api/auth/server-settings/tmdb") return "server.admin";
  if (path === "/api/auth/accounts" || path.startsWith("/api/auth/accounts/")) return "server.admin";
  if (path === "/api/admin/observability/readiness" || path === "/api/admin/audit" || path === "/api/admin/backups" || path.startsWith("/api/admin/backups/") || path.startsWith("/api/admin/cluster") || path.startsWith("/api/admin/playback-policy") || path.startsWith("/api/admin/tailscale") || path.startsWith("/api/admin/transcode-acceleration") || path.startsWith("/api/admin/rendition-policy") || path.startsWith("/api/admin/renditions")) return "server.admin";
  if (path.startsWith("/api/collections")) return ["GET", "HEAD"].includes(method) ? "media.read" : "server.admin";
  if (path.startsWith("/api/playlists")) return "media.read";
  if (path.startsWith("/api/auth/")) return "account.use";
  if (path === "/api/server/info") return "dashboard.use";
  if (path.startsWith("/api/files")) return ["GET", "HEAD"].includes(method) ? "files.read" : "files.write";
  if (path.startsWith("/api/catalog")) return ["GET", "HEAD"].includes(method) ? "media.read" : "media.manage";
  if (path === "/api/subtitles/provider-status" && method === "PUT") return "server.admin";
  if (path.startsWith("/api/subtitles")) return "media.read";
  if (path.startsWith("/api/playback")) return "playback.persist";
  if (path.startsWith("/api/jobs")) return "server.admin";
  if (path.startsWith("/api/renditions/items/")) return ["GET", "HEAD"].includes(method) ? "media.read" : "server.admin";
  if (path === "/api/cinema/watchlist") return "watchlist.write";
  if (path === "/api/cinema/metadata" || path === "/api/cinema/identify" || path.startsWith("/api/cinema/tmdb/")) return "media.manage";
  if (path.startsWith("/api/cinema/") || path.startsWith("/api/music/")) return "media.read";
  return "dashboard.use";
};

const isStateChanging = (request) => !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET");

export const sessionCookie = (request, token, maxAgeSeconds, { externalHttps = process.env.NEBULA_EXTERNAL_HTTPS === "true" } = {}) => {
  const secure = Boolean(request.socket.encrypted) || (typeof externalHttps === "function" ? externalHttps() : externalHttps);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
};

export const clearSessionCookie = (request, options) => sessionCookie(request, "", 0, options);

export const createAuthGuard = (accountStore = {
  authenticateMediaTicket: () => null,
  authenticateSession: () => null,
  countUsers: () => 1
}, { audit = null, externalHttps = process.env.NEBULA_EXTERNAL_HTTPS === "true", guestService = null } = {}) => {
  const serviceAuthRequired = process.env.NEBULA_REQUIRE_AUTH === "true";
  const serviceToken = process.env.NEBULA_API_TOKEN ?? "";
  const allowLocalhost = process.env.NEBULA_AUTH_ALLOW_LOCALHOST !== "false";

  const serviceContext = {
    capabilities: capabilitiesForRole("owner"),
    kind: "service",
    principalId: "service-token",
    sessionId: null,
    transport: "bearer",
    user: null
  };

  const resolveContext = (request, url) => {
    if ((url.pathname === "/api/cinema/media" || url.pathname === "/api/music/media") && url.searchParams.has("ticket")) {
      const contentPath = url.searchParams.get("path") ?? "";
      const ticket = accountStore.authenticateMediaTicket({
        contentPath,
        mediaKind: url.pathname.includes("cinema") ? "video" : "audio",
        token: url.searchParams.get("ticket")
      });
      const guestTicket = guestService?.authenticateMediaTicket({ contentPath, mediaKind: url.pathname.includes("cinema") ? "video" : "audio", token: url.searchParams.get("ticket") });
      const resolvedTicket = ticket ?? guestTicket;
      if (resolvedTicket) return { ...serviceContext, kind: "media-ticket", principalId: resolvedTicket.principalId, principalType: resolvedTicket.principalType };
      return null;
    }

    const bearer = bearerToken(request);
    const cookieToken = parseCookies(request)[SESSION_COOKIE] ?? "";
    for (const [token, transport] of [[bearer, "bearer"], [cookieToken, "cookie"]]) {
      const guest = guestService?.authenticateSession(token);
      if (guest) return { capabilities: guestCapabilities(), csrfToken: guest.csrfToken, expiresAt: guest.expiresAt, kind: "guest", principalId: guest.sessionId, sessionId: guest.sessionId, transport, user: null };
      const session = accountStore.authenticateSession(token);
      if (session) {
        return {
          capabilities: capabilitiesForRole(session.user.role),
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt,
          kind: "account",
          principalId: session.user.id,
          sessionId: session.sessionId,
          transport,
          user: session.user
        };
      }
    }

    if (serviceToken && constantTimeTokenMatch(bearer, serviceToken)) return serviceContext;
    if (serviceAuthRequired && localhostAddresses.has(normalizedRemoteAddress(request)) && allowLocalhost) return serviceContext;
    return null;
  };

  return {
    externalHttps,
    hasCapability(context, capability) {
      return Boolean(context?.capabilities?.has(capability));
    },
    required: true,
    remoteAddress: normalizedRemoteAddress,
    resolve(request, url = new URL(request.url ?? "/", "http://nebula.local")) {
      const context = resolveContext(request, url);
      request.nebulaAuth = context;
      return context;
    },
    async authorize(request, response, url = new URL(request.url ?? "/", "http://nebula.local")) {
      const routeKey = `${request.method ?? "GET"} ${url.pathname}`;
      const context = this.resolve(request, url);

      if (publicAuthRoutes.has(routeKey)) return true;

      if (!context) {
        audit?.recordBestEffort({ actor: { kind: "anonymous" }, eventType: "auth.access_denied", outcome: "denied" });
        json(response, 401, {
          code: accountStore.countUsers() === 0 && !accountStore.isOwnerInitialized?.() ? "setup_required" : "unauthorized",
          error: "Authentication required."
        });
        return false;
      }

      if (context.kind === "media-ticket") return true;

      if (context.transport === "cookie" && isStateChanging(request)) {
        const csrf = String(request.headers["x-nebula-csrf"] ?? "");
        if (!constantTimeTokenMatch(csrf, context.csrfToken)) {
          audit?.recordBestEffort({ actor: { kind: "account", principalId: context.principalId, role: context.user?.role }, eventType: "auth.access_denied", outcome: "denied", metadata: { transport: "cookie" } });
          json(response, 403, { code: "csrf_required", error: "Request verification failed." });
          return false;
        }
      }

      const capability = capabilityForRoute(request, url);
      if (!context.capabilities.has(capability)) {
        audit?.recordBestEffort({ actor: { kind: context.kind, principalId: context.principalId, role: context.user?.role }, eventType: "auth.access_denied", outcome: "denied", target: { type: "capability", id: capability }, metadata: { transport: context.transport } });
        json(response, 403, { code: "permission_denied", error: "You do not have permission to perform this action." });
        return false;
      }

      return true;
    }
  };
};
