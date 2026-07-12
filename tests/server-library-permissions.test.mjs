import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAccountStore } from "../server/accountStore.mjs";
import { createApiHandler } from "../server/api.mjs";
import { createAuthGuard } from "../server/auth.mjs";
import { applyCatalogMigration, bootstrapSharedContentRoot, createCatalogRepository, scanLocalRoot } from "../server/catalog/index.mjs";
import { applyDomainMigrations } from "../server/database.mjs";
import { createDeliveryService } from "../server/playback/delivery.mjs";
import { createPlaybackPlanner } from "../server/playback-planner/index.mjs";
import { createPlaybackRepository } from "../server/playback/repository.mjs";
import { PLAYBACK_MIGRATION } from "../server/playback/schema.mjs";
import { createPlaybackService } from "../server/playback/service.mjs";
import { createLibraryPermissionsService, libraryPermissionsMigration } from "../server/permissions/index.mjs";
import { createStorage } from "../server/storage.mjs";

const ownerPassword = "owner password secure";
const memberPassword = "member password secure";
const authHeaders = (token) => ({ authorization: `Bearer ${token}` });

test("library permission migration preserves access and selected policies isolate members", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const accounts = await createAccountStore({ database });
  applyCatalogMigration(database);
  const catalog = createCatalogRepository(database);
  const movies = catalog.ensureLibrary({ name: "Movies", mediaKind: "video" });
  const music = catalog.ensureLibrary({ name: "Music", mediaKind: "audio" });
  const owner = await accounts.setupOwner({ clientLabel: "test", displayName: "Owner", password: ownerPassword, username: "owner" });
  const first = await accounts.createMember({ displayName: "First", password: memberPassword, username: "first" });
  const second = await accounts.createMember({ displayName: "Second", password: memberPassword, username: "second" });

  applyDomainMigrations(database, [libraryPermissionsMigration]);
  applyDomainMigrations(database, [libraryPermissionsMigration]);
  const permissions = createLibraryPermissionsService({ database });
  const firstPrincipal = { type: "user", userId: first.id };
  const secondPrincipal = { type: "user", userId: second.id };
  assert.equal(permissions.canAccessLibrary(firstPrincipal, movies.id), true);
  assert.equal(permissions.canAccessLibrary(firstPrincipal, music.id), true);
  assert.equal(permissions.canAccessLibrary({ type: "user", userId: owner.user.id }, music.id), true);

  permissions.setMemberAccess(first.id, { libraryIds: [movies.id], mode: "selected" });
  permissions.setMemberAccess(second.id, { libraryIds: [music.id], mode: "selected" });
  assert.equal(permissions.canAccessLibrary(firstPrincipal, movies.id), true);
  assert.equal(permissions.canAccessLibrary(firstPrincipal, music.id), false);
  assert.equal(permissions.canAccessLibrary(secondPrincipal, movies.id), false);
  assert.equal(permissions.canAccessLibrary(secondPrincipal, music.id), true);

  const future = catalog.ensureLibrary({ name: "Future", mediaKind: "video" });
  assert.equal(permissions.canAccessLibrary(firstPrincipal, future.id), false);
  const newMember = await accounts.createMember({ displayName: "New", password: memberPassword, username: "new-member" });
  assert.equal(permissions.canAccessLibrary({ type: "user", userId: newMember.id }, future.id), true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM nebula_domain_migrations WHERE migration_id = 'library-permissions-v1'").get().count, 1);
  accounts.close();
  database.close();
});

const startPermissionApi = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-library-permissions-"));
  const storage = await createStorage({ contentRoot: path.join(root, "content"), dataRoot: path.join(root, "data") });
  const database = new DatabaseSync(storage.accountDatabasePath);
  database.exec("PRAGMA foreign_keys = ON");
  const accounts = await createAccountStore({ database });
  applyCatalogMigration(database);
  applyDomainMigrations(database, [libraryPermissionsMigration]);
  const catalog = createCatalogRepository(database);
  const { root: catalogRoot } = bootstrapSharedContentRoot(catalog, { contentRoot: storage.contentRoot });
  await writeFile(path.join(storage.contentRoot, "Movie.mp4"), "0123456789");
  await writeFile(path.join(storage.contentRoot, "Song.mp3"), "abcdefghij");
  await scanLocalRoot({ absoluteRoot: storage.contentRoot, repository: catalog, rootId: catalogRoot.id });
  const permissions = createLibraryPermissionsService({ database });
  const owner = await accounts.setupOwner({ clientLabel: "test", displayName: "Owner", password: ownerPassword, username: "owner" });
  const member = await accounts.createMember({ displayName: "Member", password: memberPassword, username: "member" });
  const memberLogin = await accounts.login({ clientLabel: "test", password: memberPassword, remoteAddress: "127.0.0.1", username: "member" });
  const authGuard = createAuthGuard(accounts);
  const handler = createApiHandler(storage, accounts, authGuard, {
    catalog: { libraryPermissions: permissions, repository: catalog, scan: async () => ({}) },
    libraryPermissions: permissions
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://nebula");
    if (!(await authGuard.authorize(request, response, url))) return;
    if (!(await handler(request, response))) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    accounts.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    accounts, baseUrl: `http://127.0.0.1:${server.address().port}`, catalog, catalogRoot,
    member, memberToken: memberLogin.session.token, ownerToken: owner.session.token, permissions
  };
};

test("owner administration denies members and restrictions prevent catalog and compatibility existence leaks", async (t) => {
  const api = await startPermissionApi(t);
  const memberHeaders = authHeaders(api.memberToken);
  const ownerHeaders = authHeaders(api.ownerToken);
  const sharedLibraryId = api.catalogRoot.library_id;
  const movie = api.catalog.resolveContentPath("Movie.mp4", api.catalogRoot.id);

  const deniedAdmin = await fetch(`${api.baseUrl}/api/auth/accounts/library-permissions`, { headers: memberHeaders });
  assert.equal(deniedAdmin.status, 403);
  const ownerAdmin = await fetch(`${api.baseUrl}/api/auth/accounts/library-permissions`, { headers: ownerHeaders });
  assert.equal(ownerAdmin.status, 200);
  assert.equal((await ownerAdmin.json()).libraries[0].id, sharedLibraryId);

  const before = await fetch(`${api.baseUrl}/api/cinema/library`, { headers: memberHeaders }).then((response) => response.json());
  assert.equal(before.entries.length, 1);
  const issuedTicketUrl = new URL(before.entries[0].streamUrl, api.baseUrl);

  const saved = await fetch(`${api.baseUrl}/api/auth/accounts/${api.member.id}/library-permissions`, {
    body: JSON.stringify({ libraryIds: [], mode: "selected" }),
    headers: { ...ownerHeaders, "content-type": "application/json" },
    method: "PATCH"
  });
  assert.equal(saved.status, 200);

  const catalogList = await fetch(`${api.baseUrl}/api/catalog/items`, { headers: memberHeaders }).then((response) => response.json());
  assert.deepEqual(catalogList.items, []);
  assert.equal((await fetch(`${api.baseUrl}/api/catalog/items/${movie.itemId}`, { headers: memberHeaders })).status, 404);
  assert.deepEqual((await fetch(`${api.baseUrl}/api/cinema/library`, { headers: memberHeaders }).then((response) => response.json())).entries, []);
  assert.deepEqual((await fetch(`${api.baseUrl}/api/music/library`, { headers: memberHeaders }).then((response) => response.json())).entries, []);
  assert.equal((await fetch(`${api.baseUrl}/api/cinema/media?path=Movie.mp4`, { headers: memberHeaders })).status, 404);
  assert.equal((await fetch(`${api.baseUrl}/api/music/media?path=Song.mp3`, { headers: memberHeaders })).status, 404);
  assert.equal((await fetch(issuedTicketUrl)).status, 404, "a ticket issued before revocation must be re-authorized");
  assert.equal((await fetch(`${api.baseUrl}/api/files`, { headers: memberHeaders })).status, 200, "Files permissions must remain unchanged");
  assert.equal((await fetch(`${api.baseUrl}/api/cinema/media?path=Movie.mp4`, { headers: { ...ownerHeaders, range: "bytes=0-2" } })).status, 206);
});

test("playback state, planning admission, and active delivery access honor current library grants", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const accounts = await createAccountStore({ database });
  applyCatalogMigration(database);
  PLAYBACK_MIGRATION.apply(database);
  libraryPermissionsMigration.apply(database);
  const catalog = createCatalogRepository(database);
  const allowedLibrary = catalog.ensureLibrary({ name: "Allowed", mediaKind: "video" });
  const deniedLibrary = catalog.ensureLibrary({ name: "Denied", mediaKind: "video" });
  const allowedRoot = catalog.ensureRoot({ libraryId: allowedLibrary.id, path: "/allowed", rootKey: "allowed", mediaKind: "video" });
  const deniedRoot = catalog.ensureRoot({ libraryId: deniedLibrary.id, path: "/denied", rootKey: "denied", mediaKind: "video" });
  catalog.reconcileScan({ rootId: allowedRoot.id, files: [{ itemType: "movie", mediaKind: "video", modifiedMs: 1, path: "Allowed.mp4", size: 1, title: "Allowed" }] });
  catalog.reconcileScan({ rootId: deniedRoot.id, files: [{ itemType: "movie", mediaKind: "video", modifiedMs: 1, path: "Denied.mp4", size: 1, title: "Denied" }] });
  const allowed = catalog.resolveContentPath("Allowed.mp4", allowedRoot.id);
  const denied = catalog.resolveContentPath("Denied.mp4", deniedRoot.id);
  await accounts.setupOwner({ clientLabel: "test", displayName: "Owner", password: ownerPassword, username: "owner" });
  const member = await accounts.createMember({ displayName: "Member", password: memberPassword, username: "member" });
  const principal = { type: "user", userId: member.id };
  const permissions = createLibraryPermissionsService({ database });
  const repository = createPlaybackRepository({ db: database });
  const playback = createPlaybackService({
    identityValidator: ({ itemId, sourceId }, actor) => catalog.getSource(sourceId)?.itemId === itemId && permissions.canAccessItem(actor, itemId),
    repository,
    visibilityFilter: ({ itemId }, actor) => permissions.canAccessItem(actor, itemId)
  });
  for (const source of [allowed, denied]) {
    await playback.recordEvent({ durationSeconds: 100, event: "start", eventId: randomUUID(), itemId: source.itemId, positionSeconds: 20, sourceId: source.id }, principal);
  }
  permissions.setMemberAccess(member.id, { libraryIds: [allowedLibrary.id], mode: "selected" });
  assert.deepEqual(playback.listContinueWatching({}, principal).map(({ itemId }) => itemId), [allowed.itemId]);
  await assert.rejects(() => playback.setWatched({ itemId: denied.itemId, sourceId: denied.id, watched: true }, principal), { status: 404 });

  const planner = createPlaybackPlanner({
    resolveMedia: async ({ itemId, sourceId }, actor) => permissions.canAccessItem(actor, itemId)
      ? { item: catalog.getItem(itemId), probe: { probeState: "pending" }, source: catalog.getSource(sourceId) }
      : null
  });
  const deniedPlan = await planner.plan({
    capabilities: { audioCodecs: [], containers: [], deviceId: "test", maxAudioChannels: null, maxBitrate: null, maxHeight: null, maxWidth: null, subtitleFormats: [], supportsHls: false, videoCodecs: [] },
    itemId: denied.itemId,
    sourceId: denied.id
  }, principal);
  assert.equal(deniedPlan.decision, "unsupported");
  assert.equal(deniedPlan.reasons[0].code, "CATALOG_SOURCE_NOT_FOUND");

  let permitted = true;
  const delivery = createDeliveryService({
    authorize: () => permitted,
    contentRoot: "/content",
    planner: { plan: async ({ itemId, sourceId }) => ({ decision: "direct-play", itemId, sourceId, output: {}, reasons: [] }) },
    remuxService: {},
    resolveSource: async () => ({ path: "Allowed.mp4" }),
    transcodeService: {},
    ttlMs: 60_000
  });
  const created = await delivery.create({ capabilities: {}, itemId: allowed.itemId, sourceId: allowed.id }, principal);
  permitted = false;
  assert.throws(() => delivery.get(created.session.id, principal), { status: 404 });
  await assert.rejects(() => delivery.create({ capabilities: {}, itemId: denied.itemId, sourceId: denied.id }, principal), { status: 404 });
  await delivery.shutdown();
  accounts.close();
  database.close();
});
