import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStorage } from "../server/storage.mjs";
import { openNebulaDatabase, applyDomainMigrations } from "../server/database.mjs";
import { createAccountStore } from "../server/accountStore.mjs";
import { createAuthGuard } from "../server/auth.mjs";
import { applyApiCorsHeaders, handleApiPreflight } from "../server/cors.mjs";
import { createApiHandler } from "../server/api.mjs";
import { createBackupService } from "../server/backup/index.mjs";
import { catalogMigration } from "../server/catalog/index.mjs";
import { PLAYBACK_MIGRATION } from "../server/playback/schema.mjs";
import { probeMigration } from "../server/probe/index.mjs";
import { createJobsRepository, createJobsService, createJobsWorker, jobsMigration } from "../server/jobs/index.mjs";
import { createPlaybackPolicyRepository, createPlaybackPolicyService, playbackPolicyMigration } from "../server/playbackPolicy/index.mjs";
import {
  createCatalogCheck,
  createDatabaseCheck,
  createDirectoryCheck,
  createDiskCheck,
  createObservabilityRoutes,
  createObservabilityService,
  createWorkerCheck
} from "../server/observability/index.mjs";

const ownerPassword = "correct horse battery";
const memberPassword = "member password secure";

const jsonRequest = (url, { bearer, body, cookie, csrf, method = "GET" } = {}) => {
  const headers = { ...(body === undefined ? {} : { "content-type": "application/json" }) };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-nebula-csrf"] = csrf;
  return fetch(url, { body: body === undefined ? undefined : JSON.stringify(body), headers, method });
};

const setupOwner = async (api, clientType = "native") => {
  const response = await jsonRequest(`${api.baseUrl}/api/auth/setup`, {
    body: { clientType, displayName: "Owner", password: ownerPassword, username: "owner" },
    method: "POST"
  });
  return { body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "", response };
};

const withAuthEnvironment = async (values, callback) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const startAdminServer = async ({ serviceToken = "admin-service-secret" } = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-admin-routes-"));
  const contentRoot = path.join(root, "content");
  const dataRoot = path.join(root, "data");
  const storage = await createStorage({ contentRoot, dataRoot });
  const database = await openNebulaDatabase(storage.accountDatabasePath);
  const accountStore = await createAccountStore({ database });
  applyDomainMigrations(database, [catalogMigration, PLAYBACK_MIGRATION, probeMigration, jobsMigration, playbackPolicyMigration]);
  const jobsRepository = createJobsRepository({ db: database });
  const jobsService = createJobsService({ repository: jobsRepository });
  const jobsWorker = createJobsWorker({ handlers: {}, repository: jobsRepository });
  jobsWorker.start({ pollIntervalMs: 25 });
  const backupService = createBackupService({
    backupRoot: path.join(storage.dataRoot, "backups"),
    dataRoot: storage.dataRoot,
    database,
    databasePath: storage.accountDatabasePath
  });
  const playbackPolicy = createPlaybackPolicyService({ repository: createPlaybackPolicyRepository(database) });

  let authGuard;
  await withAuthEnvironment({
    NEBULA_API_TOKEN: serviceToken,
    NEBULA_AUTH_ALLOW_LOCALHOST: "false",
    NEBULA_REQUIRE_AUTH: "true"
  }, async () => {
    authGuard = createAuthGuard(accountStore);
  });

  const observabilityService = createObservabilityService({
    checks: [
      { name: "database", run: createDatabaseCheck({ database }) },
      { name: "content_root", run: createDirectoryCheck({ directory: storage.contentRoot, name: "content_root" }) },
      { name: "jobs_worker", run: createWorkerCheck({ snapshot: jobsWorker.snapshot }) },
      { name: "catalog", run: createCatalogCheck({ snapshot: () => ({ failedScans: 0, lastCompletedAt: null, pendingProbes: 0, scanningRoots: 0 }) }) },
      { name: "content_disk", run: createDiskCheck({ directory: storage.contentRoot, minimumFreeBytes: 1, name: "content_disk" }) },
      { name: "cache_disk", run: createDiskCheck({ directory: storage.dataRoot, minimumFreeBytes: 1, name: "cache_disk" }) }
    ]
  });
  const observabilityRoutes = createObservabilityRoutes({
    isAdmin: (request, url) => {
      const context = authGuard.resolve(request, url);
      return context?.kind !== "media-ticket" && authGuard.hasCapability(context, "server.admin");
    },
    service: observabilityService
  });
  const apiHandler = createApiHandler(storage, accountStore, authGuard, { backup: backupService, jobs: jobsService, playbackPolicy });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (await observabilityRoutes(request, response, url)) return;
    if (url.pathname.startsWith("/api/")) {
      applyApiCorsHeaders(request, response);
      if (handleApiPreflight(request, response)) return;
      if (!(await authGuard.authorize(request, response, url))) return;
      if (await apiHandler(request, response)) return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    accountStore,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await jobsWorker.stop();
      playbackPolicy.shutdown();
      accountStore.close();
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  };
};

test("backup, readiness, and metrics admin routes allow owners and service admins but deny members", async (t) => {
  const api = await startAdminServer();
  t.after(() => api.close());

  const owner = await setupOwner(api);
  await api.accountStore.createMember({ displayName: "Member", password: memberPassword, username: "member" });
  const member = await jsonRequest(`${api.baseUrl}/api/auth/login`, {
    body: { clientType: "native", password: memberPassword, username: "member" },
    method: "POST"
  }).then((response) => response.json());

  assert.equal((await jsonRequest(`${api.baseUrl}/api/admin/backups`, { bearer: member.sessionToken })).status, 403);
  assert.equal((await jsonRequest(`${api.baseUrl}/api/admin/observability/readiness`, { bearer: member.sessionToken })).status, 403);
  assert.equal((await fetch(`${api.baseUrl}/metrics`, { headers: { authorization: `Bearer ${member.sessionToken}` } })).status, 403);

  const created = await jsonRequest(`${api.baseUrl}/api/admin/backups`, {
    bearer: owner.body.sessionToken,
    body: { backupId: "wave4-owner" },
    method: "POST"
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).backup.backupId, "wave4-owner");

  const listed = await jsonRequest(`${api.baseUrl}/api/admin/backups`, { bearer: owner.body.sessionToken });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).backups[0].backupId, "wave4-owner");

  const inspected = await jsonRequest(`${api.baseUrl}/api/admin/backups/wave4-owner`, { bearer: owner.body.sessionToken });
  assert.equal(inspected.status, 200);
  const inspectedBody = await inspected.json();
  assert.equal(inspectedBody.validation.valid, true);
  assert.match(JSON.stringify(inspectedBody.validation.tables), /background_jobs/);

  assert.equal((await jsonRequest(`${api.baseUrl}/api/admin/backups`, {
    bearer: owner.body.sessionToken,
    body: { backupId: "wave4-owner" },
    method: "POST"
  })).status, 409);

  assert.equal((await fetch(`${api.baseUrl}/metrics`, {
    headers: { authorization: "Bearer admin-service-secret" }
  })).status, 200);
  assert.equal((await jsonRequest(`${api.baseUrl}/api/admin/observability/readiness`, {
    bearer: owner.body.sessionToken
  })).status, 200);
});

test("health and readiness stay public, readiness stays opaque, and online restore is not exposed", async (t) => {
  const api = await startAdminServer();
  t.after(() => api.close());

  const owner = await setupOwner(api, "browser");

  const live = await fetch(`${api.baseUrl}/healthz`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { live: true });

  const ready = await fetch(`${api.baseUrl}/readyz`);
  assert.equal(ready.status, 200);
  const readyText = await ready.text();
  assert.equal(readyText, JSON.stringify({ ready: true }));
  assert.equal(readyText.includes("components"), false);
  assert.equal(readyText.includes("database"), false);

  const restore = await jsonRequest(`${api.baseUrl}/api/admin/backups/offline-only/restore`, {
    body: {},
    cookie: owner.cookie,
    csrf: owner.body.csrfToken,
    method: "POST"
  });
  assert.equal(restore.status, 404);
});

test("playback policy config and aggregate status allow owners and service admins but deny members", async (t) => {
  const api = await startAdminServer();
  t.after(() => api.close());
  const owner = await setupOwner(api);
  const memberUser = await api.accountStore.createMember({ displayName: "Member", password: memberPassword, username: "member" });
  const member = await jsonRequest(`${api.baseUrl}/api/auth/login`, { body: { clientType: "native", password: memberPassword, username: "member" }, method: "POST" }).then((response) => response.json());

  assert.equal((await jsonRequest(`${api.baseUrl}/api/admin/playback-policy`, { bearer: member.sessionToken })).status, 403);
  const saved = await jsonRequest(`${api.baseUrl}/api/admin/playback-policy`, { bearer: owner.body.sessionToken, body: { maxBitrate: 8_000_000, maxConcurrentStreams: 3 }, method: "PUT" });
  assert.equal(saved.status, 200);
  const memberSaved = await jsonRequest(`${api.baseUrl}/api/admin/playback-policy/users/${memberUser.id}`, { bearer: "admin-service-secret", body: { maxBitrate: 3_000_000, maxConcurrentStreams: 1 }, method: "PUT" });
  assert.equal(memberSaved.status, 200);
  const status = await jsonRequest(`${api.baseUrl}/api/admin/playback-policy/status`, { bearer: owner.body.sessionToken });
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.global.maxConcurrentStreams, 3);
  assert.equal(body.users.find(({ id }) => id === memberUser.id).effective.maxBitrate, 3_000_000);
});
