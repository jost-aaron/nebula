import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const scrypt = promisify(scryptCallback);
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MEDIA_TICKET_TTL_MS = 6 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const iso = (value) => new Date(value).toISOString();
const normalizeUsername = (value = "") => String(value).trim().toLowerCase();
const bounded = (value, max) => String(value ?? "").trim().slice(0, max);

const publicUser = (row) => row ? ({
  createdAt: row.created_at,
  disabled: Boolean(row.disabled),
  displayName: row.display_name,
  id: row.id,
  lastLoginAt: row.last_login_at,
  preferences: JSON.parse(row.preferences_json || "{}"),
  role: row.role,
  updatedAt: row.updated_at,
  username: row.username
}) : null;

const publicSession = (row, currentSessionId) => ({
  clientLabel: row.client_label,
  createdAt: row.created_at,
  current: row.id === currentSessionId,
  expiresAt: row.expires_at,
  id: row.id,
  lastSeenAt: row.last_seen_at
});

const validatePassword = (password) => {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw Object.assign(new Error("Password must be between 12 and 128 characters."), { status: 400 });
  }
};

const validateIdentity = ({ displayName, username }) => {
  const normalized = normalizeUsername(username);
  const name = bounded(displayName, 80);

  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(normalized)) {
    throw Object.assign(new Error("Account name must be 3-32 letters, numbers, dots, dashes, or underscores."), { status: 400 });
  }

  if (name.length < 1) {
    throw Object.assign(new Error("Display name is required."), { status: 400 });
  }

  return { displayName: name, username: normalized };
};

export const hashPassword = async (password) => {
  validatePassword(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    p: SCRYPT_P,
    r: SCRYPT_R,
    maxmem: 64 * 1024 * 1024
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${Buffer.from(derived).toString("base64")}`;
};

export const verifyPassword = async (password, credential) => {
  const parts = String(credential ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  const expected = Buffer.from(rawHash, "base64");
  if (expected.length !== SCRYPT_KEY_LENGTH) return false;

  try {
    const actual = await scrypt(String(password ?? ""), Buffer.from(rawSalt, "base64"), expected.length, {
      N: Number(rawN), r: Number(rawR), p: Number(rawP), maxmem: 64 * 1024 * 1024
    });
    return timingSafeEqual(expected, Buffer.from(actual));
  } catch {
    return false;
  }
};

export const migrateAccountSchema = (db) => {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version > 3) throw new Error(`Account database schema ${version} is newer than this server supports.`);

  if (version === 0) db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_credential TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
      preferences_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE UNIQUE INDEX one_owner ON users(role) WHERE role = 'owner';
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token TEXT NOT NULL,
      client_label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX active_sessions_by_user ON sessions(user_id, expires_at, revoked_at);
    CREATE TABLE login_attempts (
      attempt_key TEXT PRIMARY KEY,
      failed_count INTEGER NOT NULL,
      window_started_at TEXT NOT NULL,
      blocked_until TEXT
    );
    CREATE TABLE cinema_watchlist (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, content_path)
    );
    CREATE TABLE user_migrations (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      migration_key TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (user_id, migration_key)
    );
    CREATE TABLE media_tickets (
      token_hash TEXT PRIMARY KEY,
      principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'service')),
      principal_id TEXT NOT NULL,
      media_kind TEXT NOT NULL CHECK (media_kind IN ('video', 'audio')),
      content_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX media_ticket_expiration ON media_tickets(expires_at);
    PRAGMA user_version = 1;
    COMMIT;
  `);

  if (version < 2) db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE server_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 2;
    COMMIT;
  `);

  if (version < 3) db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE server_state (
      state_key TEXT PRIMARY KEY,
      state_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO server_state (state_key, state_value, updated_at)
      VALUES ('owner_initialized', CASE WHEN EXISTS(SELECT 1 FROM users WHERE role = 'owner') THEN 'true' ELSE 'false' END, datetime('now'));
    PRAGMA user_version = 3;
    COMMIT;
  `);
};

export const createAccountStore = async ({ database, databasePath, now = () => Date.now() }) => {
  const ownsDatabase = !database;
  if (ownsDatabase) await mkdir(path.dirname(databasePath), { recursive: true });
  const db = database ?? new DatabaseSync(databasePath);
  migrateAccountSchema(db);
  const dummyCredential = await hashPassword("nebula-dummy-password-only");

  const createSessionRecord = (userId, clientLabel) => {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const id = randomUUID();
    const createdAt = iso(now());
    const expiresAt = iso(now() + SESSION_TTL_MS);
    db.prepare(`INSERT INTO sessions
      (id, user_id, token_hash, csrf_token, client_label, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, hashToken(token), csrfToken, bounded(clientLabel || "Browser", 160), createdAt, createdAt, expiresAt);
    return { csrfToken, expiresAt, id, token };
  };

  let ownerCreatedHook = () => {};
  const setupOwner = async ({ clientLabel, displayName, password, username }) => {
    const identity = validateIdentity({ displayName, username });
    const credential = await hashPassword(password);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (db.prepare("SELECT COUNT(*) AS count FROM users").get().count !== 0) {
        throw Object.assign(new Error("Owner setup is already complete."), { status: 409 });
      }
      if (db.prepare("SELECT state_value FROM server_state WHERE state_key = 'owner_initialized'").get()?.state_value === "true") {
        throw Object.assign(new Error("Owner setup is already complete."), { status: 409 });
      }
      const id = randomUUID();
      const timestamp = iso(now());
      db.prepare(`INSERT INTO users
        (id, username, display_name, password_credential, role, created_at, updated_at, last_login_at)
        VALUES (?, ?, ?, ?, 'owner', ?, ?, ?)`)
        .run(id, identity.username, identity.displayName, credential, timestamp, timestamp, timestamp);
      const session = createSessionRecord(id, clientLabel);
      db.prepare("UPDATE server_state SET state_value = 'true', updated_at = ? WHERE state_key = 'owner_initialized'").run(timestamp);
      db.exec("COMMIT");
      ownerCreatedHook();
      return { session, user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id)) };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const login = async ({ clientLabel, password, remoteAddress, username }) => {
    const normalized = normalizeUsername(bounded(username, 128));
    const candidatePassword = typeof password === "string" && password.length <= 128 ? password : "";
    const attemptKey = hashToken(`${normalized}\n${bounded(remoteAddress, 80)}`);
    const timestamp = now();
    const attempt = db.prepare("SELECT * FROM login_attempts WHERE attempt_key = ?").get(attemptKey);
    if (attempt?.blocked_until && Date.parse(attempt.blocked_until) > timestamp) {
      throw Object.assign(new Error("Sign in failed. Check your credentials and try again later."), { status: 429 });
    }

    const row = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(normalized);
    const matches = await verifyPassword(candidatePassword, row?.password_credential ?? dummyCredential);
    if (!row || !matches || row.disabled) {
      const activeWindow = attempt && timestamp - Date.parse(attempt.window_started_at) < LOGIN_WINDOW_MS;
      const failedCount = activeWindow ? attempt.failed_count + 1 : 1;
      const windowStarted = activeWindow ? attempt.window_started_at : iso(timestamp);
      const blockedUntil = failedCount >= LOGIN_MAX_FAILURES ? iso(timestamp + LOGIN_BLOCK_MS) : null;
      db.prepare(`INSERT INTO login_attempts (attempt_key, failed_count, window_started_at, blocked_until)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(attempt_key) DO UPDATE SET
          failed_count = excluded.failed_count,
          window_started_at = excluded.window_started_at,
          blocked_until = excluded.blocked_until`)
        .run(attemptKey, failedCount, windowStarted, blockedUntil);
      throw Object.assign(new Error("Sign in failed. Check your credentials and try again."), { status: 401 });
    }

    db.prepare("DELETE FROM login_attempts WHERE attempt_key = ?").run(attemptKey);
    const loggedInAt = iso(timestamp);
    db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(loggedInAt, loggedInAt, row.id);
    return {
      session: createSessionRecord(row.id, clientLabel),
      user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(row.id))
    };
  };

  const authenticateSession = (token) => {
    if (!token) return null;
    const row = db.prepare(`SELECT
        s.id AS session_id, s.csrf_token, s.expires_at, s.revoked_at,
        u.*
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`).get(hashToken(token));
    if (!row || row.disabled || row.revoked_at || Date.parse(row.expires_at) <= now()) return null;
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(iso(now()), row.session_id);
    return {
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
      sessionId: row.session_id,
      user: publicUser(row)
    };
  };

  const updateProfile = (userId, { displayName, preferences }) => {
    const current = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!current) throw Object.assign(new Error("Account not found."), { status: 404 });
    const nextName = bounded(displayName ?? current.display_name, 80);
    if (!nextName) throw Object.assign(new Error("Display name is required."), { status: 400 });
    const nextPreferences = preferences === undefined ? current.preferences_json : JSON.stringify(preferences ?? {});
    if (nextPreferences.length > 16_384) throw Object.assign(new Error("Preferences are too large."), { status: 400 });
    db.prepare("UPDATE users SET display_name = ?, preferences_json = ?, updated_at = ? WHERE id = ?")
      .run(nextName, nextPreferences, iso(now()), userId);
    return publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(userId));
  };

  const createMember = async ({ displayName, password, username }) => {
    const identity = validateIdentity({ displayName, username });
    const credential = await hashPassword(password);
    const id = randomUUID();
    const timestamp = iso(now());
    try {
      db.prepare(`INSERT INTO users
        (id, username, display_name, password_credential, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'member', ?, ?)`)
        .run(id, identity.username, identity.displayName, credential, timestamp, timestamp);
    } catch (error) {
      if (error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE") {
        throw Object.assign(new Error("That account name is already in use."), { status: 409 });
      }
      throw error;
    }
    return publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
  };

  const setMemberDisabled = (userId, disabled) => {
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!row || row.role !== "member") throw Object.assign(new Error("Member account not found."), { status: 404 });
    const timestamp = iso(now());
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?").run(disabled ? 1 : 0, timestamp, userId);
      if (disabled) {
        db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(timestamp, userId);
        db.prepare("UPDATE media_tickets SET revoked_at = ? WHERE principal_type = 'user' AND principal_id = ? AND revoked_at IS NULL").run(timestamp, userId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(userId));
  };

  const changePassword = async ({ currentPassword, currentSessionId, newPassword, userId, clientLabel }) => {
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!row || !(await verifyPassword(currentPassword, row.password_credential))) {
      throw Object.assign(new Error("Current password is incorrect."), { status: 401 });
    }
    const credential = await hashPassword(newPassword);
    db.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = iso(now());
      db.prepare("UPDATE users SET password_credential = ?, updated_at = ? WHERE id = ?").run(credential, timestamp, userId);
      db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(timestamp, userId);
      db.prepare("UPDATE media_tickets SET revoked_at = ? WHERE principal_type = 'user' AND principal_id = ? AND revoked_at IS NULL").run(timestamp, userId);
      const session = createSessionRecord(userId, clientLabel);
      db.exec("COMMIT");
      return { previousSessionId: currentSessionId, session };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const listSessions = (userId, currentSessionId) => db.prepare(`SELECT * FROM sessions
    WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`)
    .all(userId, iso(now())).map((row) => publicSession(row, currentSessionId));

  const revokeSession = (userId, sessionId) => {
    const result = db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .run(iso(now()), sessionId, userId);
    if (result.changes === 0) throw Object.assign(new Error("Session not found."), { status: 404 });
    db.prepare("UPDATE media_tickets SET revoked_at = ? WHERE principal_type = 'user' AND principal_id = ? AND revoked_at IS NULL")
      .run(iso(now()), userId);
  };

  const migrateLegacyWatchlist = (userId, paths) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const already = db.prepare("SELECT 1 FROM user_migrations WHERE user_id = ? AND migration_key = 'legacy-watchlist-v1'").get(userId);
      if (!already) {
        const insert = db.prepare("INSERT OR IGNORE INTO cinema_watchlist (user_id, content_path, created_at) VALUES (?, ?, ?)");
        for (const contentPath of paths) insert.run(userId, contentPath, iso(now()));
        db.prepare("INSERT INTO user_migrations (user_id, migration_key, completed_at) VALUES (?, 'legacy-watchlist-v1', ?)")
          .run(userId, iso(now()));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const getWatchlist = (userId) => new Set(db.prepare("SELECT content_path FROM cinema_watchlist WHERE user_id = ?")
    .all(userId).map((row) => row.content_path));

  const setWatchlisted = (userId, contentPath, watchlisted) => {
    if (watchlisted) {
      db.prepare("INSERT OR IGNORE INTO cinema_watchlist (user_id, content_path, created_at) VALUES (?, ?, ?)")
        .run(userId, contentPath, iso(now()));
    } else {
      db.prepare("DELETE FROM cinema_watchlist WHERE user_id = ? AND content_path = ?").run(userId, contentPath);
    }
  };

  const getServerSetting = (key) => db.prepare("SELECT setting_value FROM server_settings WHERE setting_key = ?")
    .get(String(key))?.setting_value ?? "";

  const setServerSetting = (key, value) => {
    const settingKey = bounded(key, 80);
    const settingValue = String(value ?? "");
    db.prepare(`INSERT INTO server_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`)
      .run(settingKey, settingValue, iso(now()));
  };

  const deleteServerSetting = (key) => db.prepare("DELETE FROM server_settings WHERE setting_key = ?").run(String(key));

  const issueMediaTicket = ({ contentPath, mediaKind, principalId, principalType }) => {
    db.prepare("DELETE FROM media_tickets WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(iso(now()));
    const token = randomBytes(32).toString("base64url");
    db.prepare(`INSERT INTO media_tickets
      (token_hash, principal_type, principal_id, media_kind, content_path, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(hashToken(token), principalType, principalId, mediaKind, contentPath, iso(now()), iso(now() + MEDIA_TICKET_TTL_MS));
    return token;
  };

  const authenticateMediaTicket = ({ contentPath, mediaKind, token }) => {
    if (!token) return null;
    const row = db.prepare(`SELECT * FROM media_tickets
      WHERE token_hash = ? AND content_path = ? AND media_kind = ? AND revoked_at IS NULL AND expires_at > ?`)
      .get(hashToken(token), contentPath, mediaKind, iso(now()));
    return row ? { principalId: row.principal_id, principalType: row.principal_type } : null;
  };

  return {
    authenticateMediaTicket,
    authenticateSession,
    changePassword,
    close: () => { if (ownsDatabase) db.close(); },
    countUsers: () => db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
    createMember,
    deleteServerSetting,
    getServerSetting,
    getUser: (userId) => publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(userId)),
    getWatchlist,
    issueMediaTicket,
    isOwnerInitialized: () => db.prepare("SELECT state_value FROM server_state WHERE state_key = 'owner_initialized'").get()?.state_value === "true",
    listSessions,
    listUsers: () => db.prepare("SELECT * FROM users ORDER BY role DESC, display_name COLLATE NOCASE").all().map(publicUser),
    login,
    migrateLegacyWatchlist,
    revokeSession,
    setWatchlisted,
    setServerSetting,
    setMemberDisabled,
    setOwnerCreatedHook: (hook) => { ownerCreatedHook = typeof hook === "function" ? hook : () => {}; },
    setupOwner,
    updateProfile
  };
};

export const accountSecurityParameters = Object.freeze({
  loginBlockMs: LOGIN_BLOCK_MS,
  loginMaxFailures: LOGIN_MAX_FAILURES,
  loginWindowMs: LOGIN_WINDOW_MS,
  mediaTicketTtlMs: MEDIA_TICKET_TTL_MS,
  scrypt: { keyLength: SCRYPT_KEY_LENGTH, N: SCRYPT_N, p: SCRYPT_P, r: SCRYPT_R },
  sessionTtlMs: SESSION_TTL_MS
});
