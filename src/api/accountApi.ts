import { apiJson, getApiBaseUrl, setAccountSessionToken, setCsrfToken } from "./http";
import type { AccountSession, AccountSessionState, AccountUser, AuthSessionResponse, AuthStatus } from "../shared/accountTypes";

const bearerClient = () => {
  if (window.location.protocol === "capacitor:") return true;
  const base = getApiBaseUrl();
  if (!base) return false;
  try { return new URL(base).origin !== window.location.origin; } catch { return false; }
};

const acceptSession = (session: AuthSessionResponse) => {
  setCsrfToken(session.csrfToken);
  if (session.transport === "bearer" && session.sessionToken) setAccountSessionToken(session.sessionToken);
  return session;
};

export const getAuthStatus = () => apiJson<AuthStatus>("/api/auth/status", { method: "GET" });

export const getCurrentAccount = async () => {
  const session = await apiJson<AccountSessionState>("/api/auth/me", { method: "GET" });
  setCsrfToken(session.csrfToken);
  return session;
};

export const setupOwner = (body: { displayName: string; password: string; username: string }) =>
  apiJson<AuthSessionResponse>("/api/auth/setup", {
    body: JSON.stringify({ ...body, clientType: bearerClient() ? "native" : "browser" }),
    method: "POST"
  }).then(acceptSession);

export const login = (body: { password: string; username: string }) =>
  apiJson<AuthSessionResponse>("/api/auth/login", {
    body: JSON.stringify({ ...body, clientType: bearerClient() ? "native" : "browser" }),
    method: "POST"
  }).then(acceptSession);

export const logout = async () => {
  await apiJson<{ ok: boolean }>("/api/auth/logout", { body: "{}", method: "POST" });
  setCsrfToken(null);
  setAccountSessionToken("");
};

export const updateProfile = (body: { displayName: string }) =>
  apiJson<{ user: AccountUser }>("/api/auth/profile", { body: JSON.stringify(body), method: "PATCH" });

export const changePassword = (body: { currentPassword: string; newPassword: string }) =>
  apiJson<AuthSessionResponse>("/api/auth/change-password", { body: JSON.stringify(body), method: "POST" }).then(acceptSession);

export const listAccountSessions = () => apiJson<{ sessions: AccountSession[] }>("/api/auth/sessions", { method: "GET" });

export const revokeAccountSession = (id: string) =>
  apiJson<{ currentRevoked: boolean; ok: boolean }>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });

export const listAccounts = () => apiJson<{ accounts: AccountUser[] }>("/api/auth/accounts", { method: "GET" });

export const createMemberAccount = (body: { displayName: string; password: string; username: string }) =>
  apiJson<{ user: AccountUser }>("/api/auth/accounts", { body: JSON.stringify(body), method: "POST" });

export const setMemberDisabled = (id: string, disabled: boolean) =>
  apiJson<{ user: AccountUser }>(`/api/auth/accounts/${encodeURIComponent(id)}`, { body: JSON.stringify({ disabled }), method: "PATCH" });
