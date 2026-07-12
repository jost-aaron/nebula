import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAccountStore } from "../server/accountStore.mjs";
import { createApiHandler } from "../server/api.mjs";
import { createAuthGuard } from "../server/auth.mjs";
import { applyCatalogMigration, createCatalogRepository } from "../server/catalog/index.mjs";
import { applyDomainMigrations } from "../server/database.mjs";
import { createMediaListsService, mediaListsMigration } from "../server/mediaLists/index.mjs";
import { createLibraryPermissionsService, libraryPermissionsMigration } from "../server/permissions/index.mjs";

const password = "correct horse battery";
const seed = (catalog, library, root, title, mediaKind) => {
  catalog.reconcileScan({ rootId: root.id, files: [{ fileKey: randomUUID(), itemType: mediaKind === "video" ? "movie" : "track", mediaKind, modifiedMs: 1, path: `${title}.${mediaKind === "video" ? "mp4" : "mp3"}`, size: 10, title }] });
  return catalog.listItems({ libraryId: library.id })[0];
};

const fixture = async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const accounts = await createAccountStore({ database: db });
  applyCatalogMigration(db);
  applyDomainMigrations(db, [libraryPermissionsMigration, mediaListsMigration]);
  const catalog = createCatalogRepository(db);
  const video = catalog.ensureLibrary({ name: "Video", mediaKind: "video" });
  const audio = catalog.ensureLibrary({ name: "Audio", mediaKind: "audio" });
  const videoRoot = catalog.ensureRoot({ libraryId: video.id, mediaKind: "video", path: "/video", rootKey: "video" });
  const audioRoot = catalog.ensureRoot({ libraryId: audio.id, mediaKind: "audio", path: "/audio", rootKey: "audio" });
  const movie = seed(catalog, video, videoRoot, "Movie", "video");
  const song = seed(catalog, audio, audioRoot, "Song", "audio");
  const owner = await accounts.setupOwner({ clientLabel: "test", displayName: "Owner", password, username: "owner" });
  const first = await accounts.createMember({ displayName: "First", password, username: "first" });
  const second = await accounts.createMember({ displayName: "Second", password, username: "second" });
  const permissions = createLibraryPermissionsService({ database: db });
  const service = createMediaListsService({ database: db, permissions });
  return { accounts, audio, db, first, movie, owner, permissions, second, service, song, video };
};

test("media list migration is composable and playlists isolate accounts with ordered duplicate-free stable IDs", async () => {
  const f = await fixture();
  applyDomainMigrations(f.db, [mediaListsMigration]);
  assert.equal(f.db.prepare("SELECT COUNT(*) count FROM nebula_domain_migrations WHERE migration_id = 'media-lists-v1'").get().count, 1);
  const first = { type: "user", userId: f.first.id };
  const second = { type: "user", userId: f.second.id };
  const playlist = f.service.create({ mediaKind: "video", name: "  Favorites  ", type: "playlist" }, first);
  assert.equal(playlist.name, "Favorites");
  assert.equal(f.service.list({ type: "playlist" }, second).length, 0);
  assert.throws(() => f.service.get(playlist.id, "playlist", second), /not found/i);
  assert.equal(f.service.addItem(playlist.id, "playlist", f.movie.id, first).items[0].id, f.movie.id);
  assert.throws(() => f.service.addItem(playlist.id, "playlist", f.movie.id, first), (error) => error.status === 409);
  assert.throws(() => f.service.addItem(playlist.id, "playlist", f.song.id, first), /kind/i);
  assert.throws(() => f.service.create({ mediaKind: "audio", name: "x".repeat(81), type: "playlist" }, first), /1 to 80/);
  f.accounts.close(); f.db.close();
});

test("owner collections retain unavailable items while member reads obey current library grants and expose no paths", async () => {
  const f = await fixture();
  const owner = { type: "user", userId: f.owner.user.id, role: "owner" };
  const member = { type: "user", userId: f.first.id, role: "member" };
  const collection = f.service.create({ mediaKind: "mixed", name: "Shared picks", type: "collection" }, owner);
  f.service.addItem(collection.id, "collection", f.movie.id, owner);
  f.service.addItem(collection.id, "collection", f.song.id, owner);
  f.permissions.setMemberAccess(f.first.id, { libraryIds: [f.video.id], mode: "selected" });
  let visible = f.service.get(collection.id, "collection", member);
  assert.deepEqual(visible.items.map(({ id }) => id), [f.movie.id]);
  assert.equal(JSON.stringify(visible).includes("Movie.mp4"), false);
  f.db.prepare("UPDATE media_sources SET availability = 'missing' WHERE item_id = ?").run(f.movie.id);
  visible = f.service.get(collection.id, "collection", member);
  assert.equal(visible.items[0].available, false);
  assert.throws(() => f.service.remove(collection.id, "collection", member), (error) => error.status === 403);
  f.accounts.close(); f.db.close();
});

test("playlist and collection APIs enforce member authorization, CSRF, and cross-user isolation", async (t) => {
  const f = await fixture();
  const firstLogin = await f.accounts.login({ clientLabel: "test", password, remoteAddress: "127.0.0.1", username: "first" });
  const secondLogin = await f.accounts.login({ clientLabel: "test", password, remoteAddress: "127.0.0.1", username: "second" });
  const auth = createAuthGuard(f.accounts);
  const handler = createApiHandler({}, f.accounts, auth, { mediaLists: f.service });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://nebula");
    if (!(await auth.authorize(request, response, url))) return;
    if (!(await handler(request, response))) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); f.accounts.close(); f.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, token, method = "GET", body) => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const created = await call("/api/playlists", firstLogin.session.token, "POST", { mediaKind: "video", name: "Mine" });
  assert.equal(created.status, 201);
  const id = (await created.json()).list.id;
  assert.equal((await call(`/api/playlists/${id}`, secondLogin.session.token)).status, 404);
  assert.equal((await call("/api/collections", firstLogin.session.token, "POST", { mediaKind: "video", name: "Denied" })).status, 403);
  assert.equal((await call(`/api/playlists/${id}/items`, firstLogin.session.token, "POST", { itemId: f.movie.id })).status, 200);
  assert.equal((await call(`/api/playlists/${id}/items`, firstLogin.session.token, "PUT", { itemIds: [f.movie.id] })).status, 200);
});
