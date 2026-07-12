import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccountStore } from "../server/accountStore.mjs";
import { applyCatalogMigration, catalogMigration, createCatalogRepository } from "../server/catalog/index.mjs";
import { createCatalogRoutes } from "../server/catalog/routes.mjs";
import { applyDomainMigrations, openNebulaDatabase } from "../server/database.mjs";
import { createPlaybackRepository } from "../server/playback/repository.mjs";
import { createPlaybackRoutes } from "../server/playback/routes.mjs";
import { PLAYBACK_MIGRATION } from "../server/playback/schema.mjs";
import { createPlaybackService } from "../server/playback/service.mjs";

const responseCapture = () => {
  let status = 0;
  let body = "";
  return {
    end(value = "") { body += value; },
    json() { return JSON.parse(body); },
    status() { return status; },
    writeHead(value) { status = value; }
  };
};

test("shared database composes account, catalog, and playback migrations once", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-media-platform-"));
  const database = await openNebulaDatabase(path.join(root, "nebula.sqlite"));
  t.after(async () => { database.close(); await rm(root, { force: true, recursive: true }); });
  const accountStore = await createAccountStore({ database });
  applyDomainMigrations(database, [catalogMigration, PLAYBACK_MIGRATION]);
  applyDomainMigrations(database, [catalogMigration, PLAYBACK_MIGRATION]);

  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM nebula_domain_migrations").get().count, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'media_items', 'playback_states')").get().count, 3);
  accountStore.close();
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
});

test("catalog routes expose stable items and manual scans", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyCatalogMigration(database);
  const repository = createCatalogRepository(database);
  const library = repository.ensureLibrary({ name: "Movies" });
  const root = repository.ensureRoot({ libraryId: library.id, path: "/content", rootKey: "test" });
  repository.reconcileScan({ files: [{ itemType: "movie", mediaKind: "video", modifiedMs: 1, path: "Movie.mp4", size: 10, title: "Movie" }], rootId: root.id });
  const route = createCatalogRoutes({ repository, scan: async () => ({ id: "scan-id" }) });

  const listResponse = responseCapture();
  assert.equal(await route({ method: "GET" }, listResponse, new URL("http://nebula/api/catalog/items?mediaKind=video")), true);
  assert.equal(listResponse.status(), 200);
  assert.match(listResponse.json().items[0].id, /^[0-9a-f-]{36}$/);

  const scanResponse = responseCapture();
  assert.equal(await route({ method: "POST" }, scanResponse, new URL("http://nebula/api/catalog/scan")), true);
  assert.equal(scanResponse.status(), 202);
  database.close();
});

test("playback routes derive user identity and reject service principals", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  PLAYBACK_MIGRATION.apply(database);
  const service = createPlaybackService({ repository: createPlaybackRepository({ db: database }) });
  const route = createPlaybackRoutes(service);
  const identity = { eventId: randomUUID(), itemId: randomUUID(), sourceId: randomUUID() };
  const request = {
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ ...identity, durationSeconds: 100, event: "start", positionSeconds: 0, sessionId: null })); },
    headers: {},
    method: "POST",
    nebulaAuth: { user: { id: "user-a" } }
  };
  const response = responseCapture();
  assert.equal(await route(request, response, new URL("http://nebula/api/playback/events")), true);
  assert.equal(response.status(), 200);
  assert.equal(response.json().state.userId, "user-a");

  const serviceRequest = { ...request, nebulaAuth: { principalId: "service-token", user: null } };
  const serviceResponse = responseCapture();
  await assert.rejects(() => route(serviceRequest, serviceResponse, new URL("http://nebula/api/playback/events")), { status: 403 });
  database.close();
});

test("delivery routes forward the authenticated principal to the trusted delivery boundary", async () => {
  const calls = [];
  const delivery = {
    async create(body, principal) {
      calls.push({ body, principal });
      return { plan: { decision: "direct-play" }, session: { id: "delivery-a", status: "ready" } };
    },
    get(id, principal) { calls.push({ id, principal }); return { id, status: "ready" }; },
    async cancel(id, principal) { calls.push({ cancel: id, principal }); }
  };
  const route = createPlaybackRoutes({}, null, delivery);
  const body = { itemId: "item-a", sourceId: "source-a", capabilities: { deviceId: "web" }, plan: { decision: "transcode" } };
  const request = {
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
    headers: {}, method: "POST", nebulaAuth: { user: { id: "user-a" } }
  };
  const created = responseCapture();
  assert.equal(await route(request, created, new URL("http://nebula/api/playback/delivery-sessions")), true);
  assert.equal(created.status(), 201);
  assert.deepEqual(calls[0], { body, principal: { type: "user", userId: "user-a" } });

  const statusResponse = responseCapture();
  await route({ headers: {}, method: "GET", nebulaAuth: request.nebulaAuth }, statusResponse, new URL("http://nebula/api/playback/delivery-sessions/delivery-a"));
  assert.equal(statusResponse.status(), 200);
  const cancelResponse = responseCapture();
  await route({ headers: {}, method: "DELETE", nebulaAuth: request.nebulaAuth }, cancelResponse, new URL("http://nebula/api/playback/delivery-sessions/delivery-a"));
  assert.equal(cancelResponse.status(), 204);
});
