import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccountStore, hashPassword, verifyPassword } from "../server/accountStore.mjs";
import { createApiHandler } from "../server/api.mjs";
import { createAuthGuard } from "../server/auth.mjs";
import { applyApiCorsHeaders, handleApiPreflight } from "../server/cors.mjs";
import { createStorage } from "../server/storage.mjs";

const ownerPassword = "correct horse battery";
const memberPassword = "member password secure";

const startApi = async ({ now, serviceToken = "" } = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-accounts-test-"));
  const contentRoot = path.join(root, "content");
  const dataRoot = path.join(root, "data");
  const storage = await createStorage({ contentRoot, dataRoot });
  const accountStore = await createAccountStore({ databasePath: storage.accountDatabasePath, ...(now ? { now } : {}) });
  const previous = {
    NEBULA_API_TOKEN: process.env.NEBULA_API_TOKEN,
    NEBULA_AUTH_ALLOW_LOCALHOST: process.env.NEBULA_AUTH_ALLOW_LOCALHOST,
    NEBULA_REQUIRE_AUTH: process.env.NEBULA_REQUIRE_AUTH
  };
  process.env.NEBULA_API_TOKEN = serviceToken;
  process.env.NEBULA_REQUIRE_AUTH = serviceToken ? "true" : "false";
  process.env.NEBULA_AUTH_ALLOW_LOCALHOST = "false";
  const authGuard = createAuthGuard(accountStore);
  Object.entries(previous).forEach(([key, value]) => value === undefined ? delete process.env[key] : process.env[key] = value);
  const handler = createApiHandler(storage, accountStore, authGuard);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    applyApiCorsHeaders(request, response);
    if (handleApiPreflight(request, response)) return;
    if (!(await authGuard.authorize(request, response, url))) return;
    if (!(await handler(request, response))) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    accountStore,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    root,
    storage,
    async close({ keepRoot = false } = {}) {
      await new Promise((resolve) => server.close(resolve));
      accountStore.close();
      if (!keepRoot) await rm(root, { force: true, recursive: true });
    }
  };
};

const jsonRequest = (url, { bearer, body, cookie, csrf, method = "GET", origin } = {}) => {
  const headers = { ...(body === undefined ? {} : { "content-type": "application/json" }) };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-nebula-csrf"] = csrf;
  if (origin) headers.origin = origin;
  return fetch(url, { body: body === undefined ? undefined : JSON.stringify(body), headers, method });
};

const setupOwner = async (api, clientType = "browser") => {
  const response = await jsonRequest(`${api.baseUrl}/api/auth/setup`, {
    body: { clientType, displayName: "Owner", password: ownerPassword, username: "owner" },
    method: "POST"
  });
  const data = await response.json();
  return { cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "", data, response };
};

test("passwords use salted scrypt credentials and verify in constant-time form", async () => {
  const first = await hashPassword(ownerPassword);
  const second = await hashPassword(ownerPassword);
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword(ownerPassword, first), true);
  assert.equal(await verifyPassword("incorrect password", first), false);
  assert.equal(first.includes(ownerPassword), false);
});

test("first-owner setup succeeds exactly once and persists across store recreation", async (t) => {
  const api = await startApi();
  let root = api.root;
  const first = await setupOwner(api);
  assert.equal(first.response.status, 201);
  assert.equal(first.data.user.role, "owner");
  const second = await setupOwner(api);
  assert.equal(second.response.status, 409);
  await api.close({ keepRoot: true });
  const reopened = await createAccountStore({ databasePath: path.join(root, "data", "nebula.sqlite") });
  t.after(async () => { reopened.close(); await rm(root, { force: true, recursive: true }); });
  assert.equal(reopened.countUsers(), 1);
  const login = await reopened.login({ clientLabel: "recreated server", password: ownerPassword, remoteAddress: "127.0.0.1", username: "owner" });
  assert.equal(login.user.username, "owner");
});

test("login succeeds but unknown, incorrect, and disabled accounts share a generic failure", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  await setupOwner(api);
  const member = await api.accountStore.createMember({ displayName: "Member", password: memberPassword, username: "member" });
  const valid = await jsonRequest(`${api.baseUrl}/api/auth/login`, { body: { clientType: "native", password: memberPassword, username: "member" }, method: "POST" });
  assert.equal(valid.status, 200);
  const wrong = await jsonRequest(`${api.baseUrl}/api/auth/login`, { body: { password: "wrong password value", username: "member" }, method: "POST" });
  const unknown = await jsonRequest(`${api.baseUrl}/api/auth/login`, { body: { password: "wrong password value", username: "missing" }, method: "POST" });
  api.accountStore.setMemberDisabled(member.id, true);
  const disabled = await jsonRequest(`${api.baseUrl}/api/auth/login`, { body: { password: memberPassword, username: "member" }, method: "POST" });
  assert.deepEqual([wrong.status, unknown.status, disabled.status], [401, 401, 401]);
  assert.equal((await wrong.json()).error, (await unknown.json()).error);
  assert.equal((await disabled.json()).error, "Sign in failed. Check your credentials and try again.");
});

test("repeated login failures are throttled without revealing account existence", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  await setupOwner(api);
  const statuses = [];
  for (let index = 0; index < 6; index += 1) {
    statuses.push((await jsonRequest(`${api.baseUrl}/api/auth/login`, { body: { password: "incorrect password", username: "owner" }, method: "POST" })).status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
});

test("sessions expire, revoke, logout, and rotate after password changes", async (t) => {
  let clock = Date.now();
  const api = await startApi({ now: () => clock });
  t.after(() => api.close());
  const owner = await setupOwner(api, "native");
  const token = owner.data.sessionToken;
  assert.ok(api.accountStore.authenticateSession(token));
  clock += 31 * 24 * 60 * 60 * 1000;
  assert.equal(api.accountStore.authenticateSession(token), null);
  clock = Date.now();
  const login = await api.accountStore.login({ clientLabel: "second", password: ownerPassword, remoteAddress: "127.0.0.1", username: "owner" });
  const rotated = await api.accountStore.changePassword({ clientLabel: "changed", currentPassword: ownerPassword, currentSessionId: login.session.id, newPassword: "a newer secure password", userId: login.user.id });
  assert.equal(api.accountStore.authenticateSession(login.session.token), null);
  assert.ok(api.accountStore.authenticateSession(rotated.session.token));
  api.accountStore.revokeSession(login.user.id, rotated.session.id);
  assert.equal(api.accountStore.authenticateSession(rotated.session.token), null);
  const logoutLogin = await api.accountStore.login({ clientLabel: "logout", password: "a newer secure password", remoteAddress: "127.0.0.1", username: "owner" });
  assert.equal((await jsonRequest(`${api.baseUrl}/api/auth/logout`, { bearer: logoutLogin.session.token, body: {}, method: "POST" })).status, 200);
  assert.equal(api.accountStore.authenticateSession(logoutLogin.session.token), null);
});

test("cookie sessions require CSRF while native bearer sessions do not", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const owner = await setupOwner(api);
  const rejected = await jsonRequest(`${api.baseUrl}/api/auth/profile`, { body: { displayName: "No CSRF" }, cookie: owner.cookie, method: "PATCH" });
  assert.equal(rejected.status, 403);
  const accepted = await jsonRequest(`${api.baseUrl}/api/auth/profile`, { body: { displayName: "Cookie Owner" }, cookie: owner.cookie, csrf: owner.data.csrfToken, method: "PATCH" });
  assert.equal(accepted.status, 200);
  const nativeLogin = await jsonRequest(`${api.baseUrl}/api/auth/login`, { body: { clientType: "native", password: ownerPassword, username: "owner" }, method: "POST" });
  const native = await nativeLogin.json();
  const bearerAccepted = await jsonRequest(`${api.baseUrl}/api/auth/profile`, { bearer: native.sessionToken, body: { displayName: "Native Owner" }, method: "PATCH" });
  assert.equal(bearerAccepted.status, 200);
});

test("owner and member capabilities protect shared Files mutations", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const owner = await setupOwner(api);
  await api.accountStore.createMember({ displayName: "Member", password: memberPassword, username: "member" });
  const loginResponse = await jsonRequest(`${api.baseUrl}/api/auth/login`, { body: { clientType: "native", password: memberPassword, username: "member" }, method: "POST" });
  const member = await loginResponse.json();
  assert.equal((await jsonRequest(`${api.baseUrl}/api/files`, { bearer: member.sessionToken })).status, 200);
  assert.equal((await jsonRequest(`${api.baseUrl}/api/files/folder`, { bearer: member.sessionToken, body: { name: "denied", path: "" }, method: "POST" })).status, 403);
  assert.equal((await jsonRequest(`${api.baseUrl}/api/files/folder`, { body: { name: "owner-folder", path: "" }, cookie: owner.cookie, csrf: owner.data.csrfToken, method: "POST" })).status, 201);
});

test("only owners can manage a redacted persistent TMDB server token", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const owner = await setupOwner(api, "native");
  await api.accountStore.createMember({ displayName: "Member", password: memberPassword, username: "member" });
  const member = await jsonRequest(`${api.baseUrl}/api/auth/login`, { body: { clientType: "native", password: memberPassword, username: "member" }, method: "POST" }).then((response) => response.json());
  const secret = "tmdb-admin-test-token-value-123456";

  const denied = await jsonRequest(`${api.baseUrl}/api/auth/server-settings/tmdb`, { bearer: member.sessionToken });
  assert.equal(denied.status, 403);
  const saved = await jsonRequest(`${api.baseUrl}/api/auth/server-settings/tmdb`, { bearer: owner.data.sessionToken, body: { token: secret }, method: "PATCH" });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { configured: true, source: "admin" });
  assert.equal(api.accountStore.getServerSetting("tmdb_api_token"), secret);
  const status = await jsonRequest(`${api.baseUrl}/api/auth/server-settings/tmdb`, { bearer: owner.data.sessionToken });
  const statusText = await status.text();
  assert.deepEqual(JSON.parse(statusText), { configured: true, source: "admin" });
  assert.equal(statusText.includes(secret), false);
  const removed = await jsonRequest(`${api.baseUrl}/api/auth/server-settings/tmdb`, { bearer: owner.data.sessionToken, method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal(api.accountStore.getServerSetting("tmdb_api_token"), "");
});

test("legacy service tokens still authorize protected APIs", async (t) => {
  const api = await startApi({ serviceToken: "legacy-service-secret" });
  t.after(() => api.close());
  assert.equal((await jsonRequest(`${api.baseUrl}/api/server/info`)).status, 401);
  assert.equal((await jsonRequest(`${api.baseUrl}/api/server/info`, { bearer: "legacy-service-secret" })).status, 200);
  const owner = await setupOwner(api);
  const accountPreferred = await jsonRequest(`${api.baseUrl}/api/auth/me`, { bearer: "legacy-service-secret", cookie: owner.cookie });
  assert.equal(accountPreferred.status, 200);
  assert.equal((await accountPreferred.json()).user.username, "owner");
});

test("protected media ranges and Files streamed/resumable uploads work with account auth", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const owner = await setupOwner(api, "native");
  const bearer = owner.data.sessionToken;
  await writeFile(path.join(api.storage.contentRoot, "movie.mp4"), "0123456789");
  const library = await jsonRequest(`${api.baseUrl}/api/cinema/library`, { bearer }).then((response) => response.json());
  const media = await fetch(new URL(library.entries[0].streamUrl, api.baseUrl), { headers: { range: "bytes=2-5" } });
  assert.equal(media.status, 206);
  assert.equal(await media.text(), "2345");
  const stream = await fetch(`${api.baseUrl}/api/files/upload?path=&name=streamed.txt`, { body: "streamed", headers: { authorization: `Bearer ${bearer}` }, method: "PUT" });
  assert.equal(stream.status, 201);
  const session = await jsonRequest(`${api.baseUrl}/api/files/uploads`, { bearer, body: { chunkSize: 2, name: "chunked.bin", path: "", size: 4 }, method: "POST" }).then((response) => response.json());
  for (const [index, value] of ["ab", "cd"].entries()) {
    assert.equal((await fetch(`${api.baseUrl}/api/files/uploads/${session.id}/chunks/${index}`, { body: value, headers: { authorization: `Bearer ${bearer}` }, method: "PUT" })).status, 200);
  }
  assert.equal((await jsonRequest(`${api.baseUrl}/api/files/uploads/${session.id}/complete`, { bearer, body: {}, method: "POST" })).status, 201);
  assert.equal(await readFile(path.join(api.storage.contentRoot, "chunked.bin"), "utf8"), "abcd");
  assert.equal((await jsonRequest(`${api.baseUrl}/api/auth/logout`, { bearer, body: {}, method: "POST" })).status, 200);
  assert.equal((await fetch(new URL(library.entries[0].streamUrl, api.baseUrl), { headers: { range: "bytes=0-1" } })).status, 401);
});

test("Cinema watchlists are per-user and migrate legacy owner state once", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const owner = await setupOwner(api, "native");
  await writeFile(path.join(api.storage.contentRoot, "legacy.mp4"), "video");
  await writeFile(api.storage.cinemaMetadataPath, JSON.stringify({ "legacy.mp4": { watchlisted: true } }));
  const ownerLibrary = await jsonRequest(`${api.baseUrl}/api/cinema/library`, { bearer: owner.data.sessionToken }).then((response) => response.json());
  assert.equal(ownerLibrary.entries[0].watchlisted, true);
  await api.accountStore.createMember({ displayName: "Member", password: memberPassword, username: "member" });
  const memberLogin = await jsonRequest(`${api.baseUrl}/api/auth/login`, { body: { clientType: "native", password: memberPassword, username: "member" }, method: "POST" }).then((response) => response.json());
  const memberLibrary = await jsonRequest(`${api.baseUrl}/api/cinema/library`, { bearer: memberLogin.sessionToken }).then((response) => response.json());
  assert.equal(memberLibrary.entries[0].watchlisted, false);
  await jsonRequest(`${api.baseUrl}/api/cinema/watchlist`, { bearer: memberLogin.sessionToken, body: { path: "legacy.mp4", watchlisted: true }, method: "PATCH" });
  assert.equal(api.accountStore.getWatchlist(memberLogin.user.id).has("legacy.mp4"), true);
  assert.equal(api.accountStore.getWatchlist(owner.data.user.id).has("legacy.mp4"), true);
  await jsonRequest(`${api.baseUrl}/api/cinema/watchlist`, { bearer: owner.data.sessionToken, body: { path: "legacy.mp4", watchlisted: false }, method: "PATCH" });
  assert.equal(api.accountStore.getWatchlist(owner.data.user.id).has("legacy.mp4"), false);
  assert.equal(api.accountStore.getWatchlist(memberLogin.user.id).has("legacy.mp4"), true);
});

test("Capacitor CORS remains allowlisted and supports credentials plus CSRF", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const preflight = await fetch(`${api.baseUrl}/api/auth/login`, { headers: { origin: "capacitor://localhost", "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-nebula-csrf" }, method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "capacitor://localhost");
  assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
  assert.match(preflight.headers.get("access-control-allow-headers"), /x-nebula-csrf/);
  const rejected = await jsonRequest(`${api.baseUrl}/api/auth/status`, { origin: "https://attacker.example" });
  assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  const malformedCookie = await fetch(`${api.baseUrl}/api/auth/status`, { headers: { cookie: "nebula_session=%E0%A4%A" } });
  assert.equal(malformedCookie.status, 200);
});
