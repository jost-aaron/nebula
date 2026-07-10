import { clearSessionCookie, sessionCookie } from "./auth.mjs";
import { json, readBody } from "./http.mjs";

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

export const createAccountRoutes = (accountStore, authGuard) => async (request, response, url) => {
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
    const result = await accountStore.setupOwner({
      clientLabel: clientLabel(request, body),
      displayName: body.displayName,
      password: body.password,
      username: body.username
    });
    authResponse(request, response, 201, result, isNative(body));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readBody(request, { limit: 32 * 1024 });
    const result = await accountStore.login({
      clientLabel: clientLabel(request, body),
      password: body.password,
      remoteAddress: authGuard.remoteAddress(request),
      username: body.username
    });
    authResponse(request, response, 200, result, isNative(body));
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

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    accountStore.revokeSession(context.user.id, context.sessionId);
    response.setHeader("set-cookie", clearSessionCookie(request));
    json(response, 200, { ok: true });
    return true;
  }

  if (request.method === "PATCH" && url.pathname === "/api/auth/profile") {
    const body = await readBody(request, { limit: 32 * 1024 });
    json(response, 200, { user: accountStore.updateProfile(context.user.id, body) });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/change-password") {
    const body = await readBody(request, { limit: 32 * 1024 });
    const result = await accountStore.changePassword({
      clientLabel: clientLabel(request, body),
      currentPassword: body.currentPassword,
      currentSessionId: context.sessionId,
      newPassword: body.newPassword,
      userId: context.user.id
    });
    const native = context.transport === "bearer";
    if (!native) response.setHeader("set-cookie", sessionCookie(request, result.session.token, SESSION_MAX_AGE_SECONDS));
    json(response, 200, {
      csrfToken: native ? null : result.session.csrfToken,
      expiresAt: result.session.expiresAt,
      sessionToken: native ? result.session.token : undefined,
      transport: context.transport,
      user: accountStore.getUser(context.user.id)
    });
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

  if (request.method === "POST" && url.pathname === "/api/auth/accounts") {
    const body = await readBody(request, { limit: 32 * 1024 });
    json(response, 201, { user: await accountStore.createMember(body) });
    return true;
  }

  const accountMatch = url.pathname.match(/^\/api\/auth\/accounts\/([a-f0-9-]{36})$/i);
  if (request.method === "PATCH" && accountMatch) {
    const body = await readBody(request, { limit: 8 * 1024 });
    json(response, 200, { user: accountStore.setMemberDisabled(accountMatch[1], Boolean(body.disabled)) });
    return true;
  }

  const sessionMatch = url.pathname.match(/^\/api\/auth\/sessions\/([a-f0-9-]{36})$/i);
  if (request.method === "DELETE" && sessionMatch) {
    accountStore.revokeSession(context.user.id, sessionMatch[1]);
    if (sessionMatch[1] === context.sessionId) response.setHeader("set-cookie", clearSessionCookie(request));
    json(response, 200, { currentRevoked: sessionMatch[1] === context.sessionId, ok: true });
    return true;
  }

  return false;
};
