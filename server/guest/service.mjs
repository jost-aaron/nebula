import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const TICKET_TTL_MS = 6 * 60 * 60 * 1000;
const hash = (value) => createHash("sha256").update(String(value)).digest();
const token = (bytes = 32) => randomBytes(bytes).toString("base64url");

const findByToken = (records, rawToken) => {
  if (!rawToken) return null;
  const candidate = hash(rawToken);
  for (const record of records.values()) {
    if (record.tokenHash.length === candidate.length && timingSafeEqual(record.tokenHash, candidate)) return record;
  }
  return null;
};

export const createGuestService = ({ accountStore, enabled = process.env.NEBULA_FIRST_RUN_GUEST_ENABLED !== "false", now = () => Date.now(), ttlMs = Number(process.env.NEBULA_GUEST_SESSION_TTL_MS ?? DEFAULT_TTL_MS) } = {}) => {
  const sessions = new Map();
  const tickets = new Map();

  const eligible = () => Boolean(enabled && accountStore.countUsers() === 0 && !accountStore.isOwnerInitialized());
  const purge = () => {
    const timestamp = now();
    for (const [id, entry] of sessions) if (entry.expiresAtMs <= timestamp) sessions.delete(id);
    for (const [id, entry] of tickets) if (entry.expiresAtMs <= timestamp || !sessions.has(entry.sessionId)) tickets.delete(id);
  };
  const revokeAll = () => { sessions.clear(); tickets.clear(); };

  const createSession = () => {
    purge();
    if (!eligible()) throw Object.assign(new Error("Guest access is not available on this server."), { status: 409, code: "guest_unavailable" });
    const rawToken = token();
    const entry = {
      csrfToken: token(24),
      expiresAtMs: now() + Math.max(60_000, ttlMs),
      id: randomUUID(),
      tokenHash: hash(rawToken)
    };
    sessions.set(entry.id, entry);
    return { csrfToken: entry.csrfToken, expiresAt: new Date(entry.expiresAtMs).toISOString(), id: entry.id, token: rawToken };
  };

  const authenticateSession = (rawToken) => {
    purge();
    if (!eligible()) { revokeAll(); return null; }
    const entry = findByToken(sessions, rawToken);
    return entry ? { csrfToken: entry.csrfToken, expiresAt: new Date(entry.expiresAtMs).toISOString(), sessionId: entry.id } : null;
  };

  const revokeSession = (sessionId) => {
    sessions.delete(sessionId);
    for (const [id, entry] of tickets) if (entry.sessionId === sessionId) tickets.delete(id);
  };

  const issueMediaTicket = ({ contentPath, mediaKind, sessionId }) => {
    purge();
    if (!sessions.has(sessionId)) throw Object.assign(new Error("Guest session expired."), { status: 401 });
    const rawToken = token();
    const entry = { contentPath, expiresAtMs: now() + TICKET_TTL_MS, id: randomUUID(), mediaKind, sessionId, tokenHash: hash(rawToken) };
    tickets.set(entry.id, entry);
    return rawToken;
  };

  const authenticateMediaTicket = ({ contentPath, mediaKind, token: rawToken }) => {
    purge();
    const entry = findByToken(tickets, rawToken);
    return entry && entry.contentPath === contentPath && entry.mediaKind === mediaKind && sessions.has(entry.sessionId)
      ? { principalId: entry.sessionId, principalType: "guest" }
      : null;
  };

  return { authenticateMediaTicket, authenticateSession, createSession, eligible, issueMediaTicket, revokeAll, revokeSession };
};
