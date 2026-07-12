import { clearSessionCookie, sessionCookie } from "./auth.mjs";
import { json, readBody } from "./http.mjs";
import { actorFromContext } from "./audit/service.mjs";

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const clientLabel = (request, body) => String(body.clientLabel ?? request.headers["user-agent"] ?? "Nebula client").slice(0, 160);
const isNative = (body) => body.clientType === "native";

const authResponse = (request, response, status, result, native) => {
  if (!native) response.setHeader("set-cookie", sessionCookie(request, result.session.token, SESSION_MAX_AGE_SECONDS));
  json(response, status, {
    csrfToken: native ? null : result.session.csrfToken,
    expiresAt: result.session.expiresAt,
    sessionToken: native ? result.session.token : undefined,
    transport: native ? "bearer" : "cookie",
    user: result.user
  });
};

export const createAccountRoutes = (accountStore, authGuard, libraryPermissions = null, audit = null) => async (request, response, url) => {
  if (request.method === "GET" && url.pathname === "/api/auth/status") {
    const context = request.nebulaAuth;
    json(response, 200, {
      authenticated: Boolean(context),
      serviceAuthenticated: context?.kind === "service",
      setupRequired: accountStore.countUsers() === 0,
      user: context?.user ?? null
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/setup") {
    const body = await readBody(request, { limit: 32 * 1024 });
    try {
      const result = await accountStore.setupOwner({
        clientLabel: clientLabel(request, body), displayName: body.displayName, password: body.password, username: body.username
      });
      audit?.recordBestEffort({ actor: { kind: "account", principalId: result.user.id, role: result.user.role }, eventType: "account.owner_setup", outcome: "success", target: { type: "account", id: result.user.id }, metadata: { clientType: isNative(body) ? "native" : "browser" } });
      authResponse(request, response, 201, result, isNative(body));
    } catch (error) {
      audit?.recordBestEffort({ actor: { kind: "anonymous" }, eventType: "account.owner_setup", outcome: "failure", metadata: { clientType: isNative(body) ? "native" : "browser" } });
      throw error;
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readBody(request, { limit: 32 * 1024 });
    try {
      const result = await accountStore.login({ clientLabel: clientLabel(request, body), password: body.password, remoteAddress: authGuard.remoteAddress(request), username: body.username });
      audit?.recordBestEffort({ actor: { kind: "account", principalId: result.user.id, role: result.user.role }, eventType: "account.login", outcome: "success", target: { type: "account", id: result.user.id }, metadata: { clientType: isNative(body) ? "native" : "browser", transport: isNative(body) ? "bearer" : "cookie" } });
      authResponse(request, response, 200, result, isNative(body));
    } catch (error) {
      audit?.recordBestEffort({ actor: { kind: "anonymous" }, eventType: "account.login", outcome: "failure", metadata: { clientType: isNative(body) ? "native" : "browser" } });
      throw error;
    }
    return true;
  }

  const context = request.nebulaAuth;
  if (!context || context.kind !== "account") {
    if (url.pathname.startsWith("/api/auth/")) {
      json(response, 403, { code: "account_required", error: "This action requires an account session." });
      return true;
    }
    return false;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    json(response, 200, {
      csrfToken: context.transport === "cookie" ? context.csrfToken : null,
      expiresAt: context.expiresAt,
      transport: context.transport,
      user: context.user
    });
    return true;
  }

  if (url.pathname === "/api/auth/server-settings/tmdb") {
    const saved = Boolean(accountStore.getServerSetting("tmdb_api_token"));
    const environment = Boolean(String(process.env.TMDB_API_TOKEN ?? "").trim());

    if (request.method === "GET") {
      json(response, 200, {
        configured: saved || environment,
        source: saved ? "admin" : environment ? "environment" : "none"
      });
      return true;
    }

    if (request.method === "PATCH") {
      const body = await readBody(request, { limit: 8 * 1024 });
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (token.length < 20 || token.length > 2048 || /\s/.test(token)) {
        audit?.recordBestEffort({ actor: actorFromContext(context), eventType: "account.server_setting_changed", outcome: "failure", target: { type: "server-setting", id: "tmdb" }, metadata: { setting: "tmdb" } });
        json(response, 400, { error: "Enter a valid TMDB API Read Access Token." });
        return true;
      }
      accountStore.setServerSetting("tmdb_api_token", token);
      audit?.recordBestEffort({ actor: actorFromContext(context), eventType: "account.server_setting_changed", outcome: "success", target: { type: "server-setting", id: "tmdb" }, metadata: { setting: "tmdb" } });
      json(response, 200, { configured: true, source: "admin" });
      return true;
    }

    if (request.method === "DELETE") {
      accountStore.deleteServerSetting("tmdb_api_token");
      audit?.recordBestEffort({ actor: actorFromContext(context), eventType: "account.server_setting_changed", outcome: "success", target: { type: "server-setting", id: "tmdb" }, metadata: { setting: "tmdb" } });
      json(response, 200, {
        configured: environment,
        source: environment ? "environment" : "none"
      });
      return true;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    accountStore.revokeSession(context.user.id, context.sessionId);
    audit?.recordBestEffort({ actor: actorFromContext(context), eventType: "account.logout", outcome: "success", target: { type: "session", id: context.sessionId }, metadata: { transport: context.transport } });
    response.setHeader("set-cookie", clearSessionCookie(request));
    json(response, 200, { ok: true });
    return true;
  }

  if (request.method === "PATCH" && url.pathname === "/api/auth/profile") {
    const body = await readBody(request, { limit: 32 * 1024 });
    try {
      const user = accountStore.updateProfile(context.user.id, body);
      audit?.recordBestEffort({ actor: actorFromContext(context), eventType: "account.profile_updated", outcome: "success", target: { type: "account", id: context.user.id } });
      json(response, 200, { user });
    } catch (error) {
      audit?.recordBestEffort({ actor: actorFromContext(context), eventType: "account.profile_updated", outcome: "failure", target: { type: "account", id: context.user.id } });
      throw error;
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/change-password") {
    const body = await readBody(request, { limit: 32 * 1024 });
    try {
      const result = await accountStore.changePassword({ clientLabel: clientLabel(request, body), currentPassword: body.currentPassword, currentSessionId: context.sessionId, newPassword: body.newPassword, userId: context.user.id });
      audit?.recordBestEffort({ actor: actorFromContext(context), eventType: "account.password_changed", outcome: "success", target: { type: "account", id: context.user.id } });
      const native = context.transport === "bearer";
      if (!native) response.setHeader("set-cookie", sessionCookie(request, result.session.token, SESSION_MAX_AGE_SECONDS));
      json(response, 200, { csrfToken: native ? null : result.session.csrfToken, expiresAt: result.session.expiresAt, sessionToken: native ? result.session.token : undefined, transport: context.transport, user: accountStore.getUser(context.user.id) });
    } catch (error) {
      audit?.recordBestEffort({ actor: actorFromContext(context), eventType: "account.password_changed", outcome: "failure", target: { type: "account", id: context.user.id } });
      throw error;
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/sessions") {
    json(response, 200, { sessions: accountStore.listSessions(context.user.id, context.sessionId) });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/accounts") {
    json(response, 200, { accounts: accountStore.listUsers() });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/accounts/library-permissions" && libraryPermissions) {
    json(response, 200, libraryPermissions.listAdministration());
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/accounts") {
    const body = await readBody(request, { limit: 32 * 1024 });
    try {
      const user = await accountStore.createMember(body);
      audit?.recordBestEffort({ actor: actorFromContext(context), eventType: "account.member_created", outcome: "success", target: { type: "account", id: user.id } });
      json(response, 201, { user });
    } catch (error) {
      audit?.recordBestEffort({ actor: actorFromContext(context), eventType: "account.member_created", outcome: "failure" });
      throw error;
    }
    return true;
  }

  const accountMatch = url.pathname.match(/^\/api\/auth\/accounts\/([a-f0-9-]{36})$/i);
  if (request.method === "PATCH" && accountMatch) {
    const body = await readBody(request, { limit: 8 * 1024 });
    try {
      const user = accountStore.setMemberDisabled(accountMatch[1], Boolean(body.disabled));
      audit?.recordBestEffort({ actor: actorFromContext(context), eventType: "account.member_status_changed", outcome: "success", target: { type: "account", id: accountMatch[1] }, metadata: { disabled: Boolean(body.disabled) } });
      json(response, 200, { user });
    } catch (error) {
      audit?.recordBestEffort({ actor: actorFromContext(context), eventType: "account.member_status_changed", outcome: "failure", target: { type: "account", id: accountMatch[1] }, metadata: { disabled: Boolean(body.disabled) } });
      throw error;
    }
    return true;
  }

  const libraryPermissionsMatch = url.pathname.match(/^\/api\/auth\/accounts\/([a-f0-9-]{36})\/library-permissions$/i);
  if (request.method === "PATCH" && libraryPermissionsMatch && libraryPermissions) {
    const body = await readBody(request, { limit: 32 * 1024 });
    json(response, 200, { member: libraryPermissions.setMemberAccess(libraryPermissionsMatch[1], body) });
    return true;
  }

  const sessionMatch = url.pathname.match(/^\/api\/auth\/sessions\/([a-f0-9-]{36})$/i);
  if (request.method === "DELETE" && sessionMatch) {
    accountStore.revokeSession(context.user.id, sessionMatch[1]);
    audit?.recordBestEffort({ actor: actorFromContext(context), eventType: "account.session_revoked", outcome: "success", target: { type: "session", id: sessionMatch[1] } });
    if (sessionMatch[1] === context.sessionId) response.setHeader("set-cookie", clearSessionCookie(request));
    json(response, 200, { currentRevoked: sessionMatch[1] === context.sessionId, ok: true });
    return true;
  }

  return false;
};
