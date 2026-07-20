import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccountStore } from "../server/accountStore.mjs";
import { createApiHandler } from "../server/api.mjs";
import { applyApiCorsHeaders, handleApiPreflight } from "../server/cors.mjs";
import { applyDomainMigrations, openNebulaDatabase } from "../server/database.mjs";
import { createAuthGuard } from "../server/auth.mjs";
import { createStorage } from "../server/storage.mjs";
import { auditMigration, createAuditService } from "../server/audit/index.mjs";

const ownerPassword = "correct horse battery";
const memberPassword = "member password secure";
const requestJson = (url, { bearer, body, method = "GET" } = {}) => fetch(url, {
  body: body === undefined ? undefined : JSON.stringify(body),
  headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
  method
});

const startServer = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-audit-api-"));
  const storage = await createStorage({ contentRoot: path.join(root, "content"), dataRoot: path.join(root, "data") });
  const database = await openNebulaDatabase(storage.accountDatabasePath);
  const accountStore = await createAccountStore({ database });
  applyDomainMigrations(database, [auditMigration]);
  const audit = createAuditService({ db: database });
  const previous = { token: process.env.NEBULA_API_TOKEN, required: process.env.NEBULA_REQUIRE_AUTH, localhost: process.env.NEBULA_AUTH_ALLOW_LOCALHOST };
  process.env.NEBULA_API_TOKEN = "audit-service-admin-secret";
  process.env.NEBULA_REQUIRE_AUTH = "true";
  process.env.NEBULA_AUTH_ALLOW_LOCALHOST = "false";
  const authGuard = createAuthGuard(accountStore, { audit });
  const jobId = "10000000-0000-4000-8000-000000000001";
  const handler = createApiHandler(storage, accountStore, authGuard, {
    audit,
    backup: {
      create: async ({ backupId }) => ({ backupId, createdAt: new Date().toISOString(), files: [], format: "nebula-backup", formatVersion: 1, includesContentMedia: false, migrations: [] }),
      inspect: async ({ backupId }) => ({ manifest: { backupId, createdAt: new Date().toISOString(), files: [], format: "nebula-backup", formatVersion: 1, includesContentMedia: false, migrations: [] }, schema: { migrations: [], tables: [] } }),
      list: async () => []
    },
    catalog: { repository: { getItem: () => null, listItems: () => [] }, scan: async () => ({ added: 0 }) },
    jobs: {
      cancel: () => ({ id: jobId, type: "scan" }), get: () => null, list: () => [],
      enqueue: () => ({ created: true, job: { id: jobId, type: "scan" } })
    }
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      applyApiCorsHeaders(request, response);
      if (handleApiPreflight(request, response)) return;
      if (!(await authGuard.authorize(request, response, url))) return;
      if (await handler(request, response)) return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    accountStore, audit, baseUrl: `http://127.0.0.1:${server.address().port}`, database,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      accountStore.close();
      for (const [key, value] of [["NEBULA_API_TOKEN", previous.token], ["NEBULA_REQUIRE_AUTH", previous.required], ["NEBULA_AUTH_ALLOW_LOCALHOST", previous.localhost]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  };
};

test("audit migration, redaction, retention, filtering, and cursor pagination stay bounded", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-audit-domain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = await openNebulaDatabase(path.join(root, "audit.sqlite"));
  t.after(() => database.close());
  applyDomainMigrations(database, [auditMigration]);
  applyDomainMigrations(database, [auditMigration]);
  let sequence = 0;
  const now = Date.parse("2026-07-11T12:00:00.000Z");
  const audit = createAuditService({ db: database, maxEvents: 100, now: () => now, retentionDays: 30, uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` });
  audit.record({ actor: { kind: "account", principalId: "owner-id", role: "owner" }, eventType: "account.login", occurredAt: "2026-01-01T00:00:00.000Z", outcome: "success", metadata: { password: "never", token: "never", path: "/media/private.mp4", error: "raw", transport: "cookie" } });
  for (let index = 0; index < 105; index += 1) {
    audit.record({ actor: { kind: index % 2 ? "service" : "account", principalId: index % 2 ? "service-token" : "owner-id", role: index % 2 ? "service-admin" : "owner" }, eventType: index % 2 ? "backup.inspected" : "job.enqueued", occurredAt: new Date(now + index).toISOString(), outcome: index % 3 ? "success" : "failure", target: { type: "job", id: `job-${index}` }, metadata: { jobType: "scan", requestedBy: "manual", password: "secret", filename: "private.mp4", authHeader: "Bearer secret" } });
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 100);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE occurred_at < '2026-06-11'").get().count, 0);
  const first = audit.list({ eventType: "job.enqueued", limit: 7, outcome: "success" });
  assert.equal(first.events.length, 7);
  assert.ok(first.nextCursor);
  assert.deepEqual(first.events[0].metadata, { jobType: "scan", requestedBy: "manual" });
  const second = audit.list({ cursor: first.nextCursor, eventType: "job.enqueued", limit: 7, outcome: "success" });
  assert.equal(second.events.length, 7);
  assert.equal(new Set([...first.events, ...second.events].map(({ id }) => id)).size, 14);
  assert.doesNotMatch(JSON.stringify([first, second]), /secret|private\.mp4|Bearer|password|filename|authHeader|raw/);
  database.prepare(`INSERT INTO audit_events
    (id, event_type, actor_kind, occurred_at, outcome, target_type, target_id, metadata_json)
    VALUES ('manual-row', 'account.login', 'system', ?, 'success', 'media', 'Movies/private.mp4', ?)`)
    .run(new Date(now + 1000).toISOString(), JSON.stringify({ password: "secret", transport: "cookie", error: "raw" }));
  const defensiveRead = audit.list({ eventType: "account.login", limit: 1 });
  assert.deepEqual(defensiveRead.events[0].metadata, { transport: "cookie" });
  assert.equal(defensiveRead.events[0].target.id, null);
  assert.doesNotMatch(JSON.stringify(defensiveRead), /private\.mp4|secret|raw/);
  assert.throws(() => audit.list({ cursor: "broken" }), /Invalid audit cursor/);
});

test("audit API allows owners and service admins, denies members, and captures safe auth actions", async (t) => {
  const api = await startServer();
  t.after(() => api.close());
  const ownerResponse = await requestJson(`${api.baseUrl}/api/auth/setup`, { body: { clientType: "native", displayName: "Owner", password: ownerPassword, username: "owner" }, method: "POST" });
  const owner = await ownerResponse.json();
  await api.accountStore.createMember({ displayName: "Member", password: memberPassword, username: "member" });
  const member = await requestJson(`${api.baseUrl}/api/auth/login`, { body: { clientType: "native", password: memberPassword, username: "member" }, method: "POST" }).then((response) => response.json());

  const denied = await requestJson(`${api.baseUrl}/api/admin/audit`, { bearer: member.sessionToken });
  assert.equal(denied.status, 403);
  const ownerList = await requestJson(`${api.baseUrl}/api/admin/audit?eventType=account.owner_setup&limit=1`, { bearer: owner.sessionToken });
  assert.equal(ownerList.status, 200);
  const ownerBody = await ownerList.json();
  assert.equal(ownerBody.events[0].actor.principalId, owner.user.id);
  assert.equal(ownerBody.events[0].target.id, owner.user.id);
  assert.deepEqual(ownerBody.events[0].metadata, { clientType: "native" });
  assert.equal((await requestJson(`${api.baseUrl}/api/jobs`, { bearer: owner.sessionToken, body: { type: "scan", payload: { contentPath: "Movies/private.mp4", token: "never" } }, method: "POST" })).status, 202);
  assert.equal((await requestJson(`${api.baseUrl}/api/catalog/scan`, { bearer: owner.sessionToken, body: {}, method: "POST" })).status, 202);
  assert.equal((await requestJson(`${api.baseUrl}/api/admin/backups`, { bearer: owner.sessionToken, body: { backupId: "safe-backup-id", backupPath: "/private/backup" }, method: "POST" })).status, 201);
  const adminEvents = await requestJson(`${api.baseUrl}/api/admin/audit?actorKind=account&limit=100`, { bearer: owner.sessionToken }).then((response) => response.json());
  for (const eventType of ["job.enqueued", "catalog.scan_requested", "backup.created"]) assert.ok(adminEvents.events.some((event) => event.eventType === eventType));
  assert.doesNotMatch(JSON.stringify(adminEvents), /Movies\/private|\/private\/backup|never/);
  const serviceList = await requestJson(`${api.baseUrl}/api/admin/audit?outcome=denied`, { bearer: "audit-service-admin-secret" });
  assert.equal(serviceList.status, 200);
  assert.ok((await serviceList.json()).events.some(({ eventType }) => eventType === "auth.access_denied"));
  assert.doesNotMatch(JSON.stringify(api.database.prepare("SELECT metadata_json FROM audit_events").all()), /correct horse|member password|sessionToken|csrf|cookie|authorization/i);
});

test("best-effort recording cannot surface storage failures", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-audit-best-effort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = await openNebulaDatabase(path.join(root, "audit.sqlite"));
  applyDomainMigrations(database, [auditMigration]);
  const audit = createAuditService({ db: database });
  database.close();
  assert.equal(audit.recordBestEffort({ actor: { kind: "system" }, eventType: "job.enqueued", outcome: "success" }), false);
});

test("cluster operations audit events retain only allowlisted aggregate reasons", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-audit-cluster-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = await openNebulaDatabase(path.join(root, "audit.sqlite"));
  t.after(() => database.close());
  applyDomainMigrations(database, [auditMigration]);
  const audit = createAuditService({ db: database });
  audit.record({
    actor: { kind: "system" }, eventType: "cluster.readiness_changed", outcome: "failure",
    metadata: { endpoint: "https://secret.ts.net", nodeId: "node-secret", path: "/private/media.mp4", reason: "cluster-degraded" }
  });
  audit.record({
    actor: { kind: "system" }, eventType: "cluster.clock_skew_detected", outcome: "failure",
    metadata: { grant: "grant-secret", reason: "clock-skew", skewMs: 999_999 }
  });
  assert.deepEqual(audit.list({ eventType: "cluster.readiness_changed" }).events[0].metadata, { reason: "cluster-degraded" });
  assert.deepEqual(audit.list({ eventType: "cluster.clock_skew_detected" }).events[0].metadata, { reason: "clock-skew" });
  assert.doesNotMatch(JSON.stringify(database.prepare("SELECT metadata_json FROM audit_events").all()), /secret|private|skewMs|999999/);
});
