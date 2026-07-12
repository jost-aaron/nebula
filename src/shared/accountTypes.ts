export type AccountRole = "owner" | "member";
export type SessionTransport = "cookie" | "bearer";

export interface AccountUser {
  createdAt: string;
  disabled: boolean;
  displayName: string;
  id: string;
  lastLoginAt: string | null;
  preferences: Record<string, unknown>;
  role: AccountRole;
  updatedAt: string;
  username: string;
}

export interface AuthStatus {
  authenticated: boolean;
  guestAvailable: boolean;
  principal: "account" | "guest" | null;
  serviceAuthenticated: boolean;
  setupRequired: boolean;
  user: AccountUser | null;
}

export interface AccountSessionState {
  csrfToken: string | null;
  expiresAt: string;
  transport: SessionTransport;
  principal?: "account";
  user: AccountUser;
}

export interface GuestSessionState {
  csrfToken: string | null;
  expiresAt: string;
  principal: "guest";
  transport: SessionTransport;
  user: null;
}

export type CurrentSessionState = AccountSessionState | GuestSessionState;

export type AuthSessionResponse = CurrentSessionState & { sessionToken?: string };

export interface AccountSession {
  clientLabel: string;
  createdAt: string;
  current: boolean;
  expiresAt: string;
  id: string;
  lastSeenAt: string;
}
