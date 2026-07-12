import { apiJson, getApiBaseUrl, setAccountSessionToken, setCsrfToken } from "./http";
import type { AccountSession, AccountSessionState, AccountUser, AuthSessionResponse, AuthStatus, CurrentSessionState } from "../shared/accountTypes";
import type { LibraryAccessMode, LibraryPermissionsAdministration, MemberLibraryAccess } from "../shared/libraryPermissionTypes";

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
  const session = await apiJson<CurrentSessionState>("/api/auth/me", { method: "GET" });
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

export const continueAsGuest = () => apiJson<AuthSessionResponse>("/api/auth/guest", {
  body: "{}",
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

export const getLibraryPermissionsAdministration = () =>
  apiJson<LibraryPermissionsAdministration>("/api/auth/accounts/library-permissions", { method: "GET" });

export const saveMemberLibraryPermissions = (id: string, body: { libraryIds: string[]; mode: LibraryAccessMode }) =>
  apiJson<{ member: MemberLibraryAccess }>(`/api/auth/accounts/${encodeURIComponent(id)}/library-permissions`, {
    body: JSON.stringify(body),
    method: "PATCH"
  });

export type TmdbServerSettingStatus = { configured: boolean; source: "admin" | "environment" | "none" };

export const getTmdbServerSetting = () =>
  apiJson<TmdbServerSettingStatus>("/api/auth/server-settings/tmdb", { method: "GET" });

export const saveTmdbServerSetting = (token: string) =>
  apiJson<TmdbServerSettingStatus>("/api/auth/server-settings/tmdb", { body: JSON.stringify({ token }), method: "PATCH" });

export const clearTmdbServerSetting = () =>
  apiJson<TmdbServerSettingStatus>("/api/auth/server-settings/tmdb", { method: "DELETE" });
