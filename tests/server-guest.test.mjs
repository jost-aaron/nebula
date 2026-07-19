import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import test from "node:test";
import { createAccountStore } from "../server/accountStore.mjs";
import { createAccountRoutes } from "../server/accounts.mjs";
import { createAuthGuard } from "../server/auth.mjs";
import { createGuestService } from "../server/guest/service.mjs";

const owner = { clientLabel: "test", displayName: "Owner", password: "correct horse battery", username: "owner" };

test("guest eligibility is first-run only and owner initialization is irreversible", async () => {
  const db = new DatabaseSync(":memory:");
  const accounts = await createAccountStore({ database: db });
  const guests = createGuestService({ accountStore: accounts });
  accounts.setOwnerCreatedHook(guests.revokeAll);
  assert.equal(accounts.isOwnerInitialized(), false);
  assert.equal(guests.eligible(), true);
  const guest = guests.createSession();
  assert.ok(guests.authenticateSession(guest.token));
  await accounts.setupOwner(owner);
  assert.equal(accounts.isOwnerInitialized(), true);
  assert.equal(guests.authenticateSession(guest.token), null);
  db.exec("DELETE FROM users");
  assert.equal(accounts.countUsers(), 0);
  assert.equal(guests.eligible(), false);
  await assert.rejects(accounts.setupOwner(owner), { status: 409 });
  db.close();
});

test("upgrading an existing owner database sets the initialized marker", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA user_version = 2;
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, display_name TEXT, password_credential TEXT, role TEXT, disabled INTEGER, preferences_json TEXT, created_at TEXT, updated_at TEXT, last_login_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, token_hash TEXT, csrf_token TEXT, client_label TEXT, created_at TEXT, last_seen_at TEXT, expires_at TEXT, revoked_at TEXT);
    CREATE TABLE login_attempts (attempt_key TEXT PRIMARY KEY, failed_count INTEGER, window_started_at TEXT, blocked_until TEXT);
    CREATE TABLE cinema_watchlist (user_id TEXT, content_path TEXT, created_at TEXT);
    CREATE TABLE user_migrations (user_id TEXT, migration_key TEXT, completed_at TEXT);
    CREATE TABLE media_tickets (token_hash TEXT PRIMARY KEY, principal_type TEXT, principal_id TEXT, media_kind TEXT, content_path TEXT, created_at TEXT, expires_at TEXT, revoked_at TEXT);
    CREATE TABLE server_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_at TEXT);
    INSERT INTO users VALUES ('owner-id','owner','Owner','credential','owner',0,'{}','now','now',NULL);`);
  const accounts = await createAccountStore({ database: db });
  assert.equal(accounts.isOwnerInitialized(), true);
  db.close();
});

test("guest sessions expire, vanish on restart, and tickets stay session-bound in memory", async () => {
  const db = new DatabaseSync(":memory:");
  let clock = 1_000;
  const accounts = await createAccountStore({ database: db, now: () => clock });
  const guests = createGuestService({ accountStore: accounts, now: () => clock, ttlMs: 60_000 });
  const session = guests.createSession();
  const ticket = guests.issueMediaTicket({ contentPath: "movie.mp4", mediaKind: "video", sessionId: session.id });
  assert.equal(guests.authenticateMediaTicket({ contentPath: "movie.mp4", mediaKind: "video", token: ticket }).principalType, "guest");
  assert.equal(createGuestService({ accountStore: accounts }).authenticateSession(session.token), null);
  clock += 60_001;
  assert.equal(guests.authenticateSession(session.token), null);
  assert.equal(guests.authenticateMediaTicket({ contentPath: "movie.mp4", mediaKind: "video", token: ticket }), null);
  db.close();
});

test("guest principal is denied persistence and administration but may read media", async () => {
  const db = new DatabaseSync(":memory:");
  const accounts = await createAccountStore({ database: db });
  const guests = createGuestService({ accountStore: accounts });
  const session = guests.createSession();
  const guard = createAuthGuard(accounts, { guestService: guests });
  const request = (method, path) => ({ headers: { cookie: `nebula_session=${session.token}`, ...(method === "POST" ? { "x-nebula-csrf": session.csrfToken } : {}) }, method, socket: { remoteAddress: "127.0.0.1" }, url: path });
  const response = () => ({ end() {}, setHeader() {}, writeHead(status) { this.status = status; } });
  for (const path of ["/api/cinema/library", "/api/music/library", "/api/catalog/items"]) assert.equal(await guard.authorize(request("GET", path), response()), true);
  for (const [method, path] of [["GET", "/api/files"], ["GET", "/api/jobs"], ["GET", "/api/playback/history"], ["POST", "/api/playback/events"], ["PATCH", "/api/cinema/watchlist"], ["GET", "/api/admin/backups"], ["GET", "/api/auth/accounts"]]) {
    const result = response();
    assert.equal(await guard.authorize(request(method, path), result), false, `${method} ${path}`);
    assert.equal(result.status, 403);
  }
  db.close();
});

test("guest entry trusts only the socket remote address, never Host", async () => {
  const db = new DatabaseSync(":memory:");
  const accounts = await createAccountStore({ database: db });
  const guests = createGuestService({ accountStore: accounts });
  const guard = createAuthGuard(accounts, { guestService: guests });
  const route = createAccountRoutes(accounts, guard, null, null, guests);
  const invoke = async (remoteAddress, host) => {
    const request = Readable.from(["{}"]);
    Object.assign(request, { headers: { host }, method: "POST", socket: { remoteAddress } });
    const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(status) { this.status = status; }, end(body = "") { this.body = body; } };
    await route(request, response, new URL("http://nebula.local/api/auth/guest"));
    return response;
  };
  const forged = await invoke("203.0.113.8", "localhost:5173");
  assert.equal(forged.status, 403);
  assert.equal(forged.headers["set-cookie"], undefined);
  assert.equal((await invoke("::ffff:127.0.0.1", "attacker.example")).status, 201);
  db.close();
});

test("concurrent first-owner creation has one winner and revokes all guests", async () => {
  const db = new DatabaseSync(":memory:");
  const accounts = await createAccountStore({ database: db });
  const guests = createGuestService({ accountStore: accounts });
  accounts.setOwnerCreatedHook(guests.revokeAll);
  const guest = guests.createSession();
  const results = await Promise.allSettled([
    accounts.setupOwner(owner),
    accounts.setupOwner({ ...owner, username: "other-owner" })
  ]);
  assert.deepEqual(results.map(({ status }) => status).sort(), ["fulfilled", "rejected"]);
  assert.equal(accounts.countUsers(), 1);
  assert.equal(accounts.isOwnerInitialized(), true);
  assert.equal(guests.authenticateSession(guest.token), null);
  db.close();
});
