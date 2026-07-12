import assert from "node:assert/strict";
import test from "node:test";
import {
  createCatalogCheck,
  createDatabaseCheck,
  createDiskCheck,
  createObservabilityRoutes,
  createObservabilityService,
  createWorkerCheck,
  renderPrometheusMetrics
} from "../server/observability/index.mjs";

const responseCapture = () => {
  let body = "";
  let headers = {};
  let status = 0;
  return {
    end(value = "") { body += value; },
    result: () => ({ body, headers, status }),
    writeHead(value, fields) { status = value; headers = fields; }
  };
};

test("readiness checks cover database, worker, catalog, and disk failure states without raw errors", async () => {
  const secret = "/Users/alice/content/private-film.mkv?token=hunter2";
  const checks = [
    { name: "database", run: createDatabaseCheck({ database: { prepare() { throw new Error(secret); } } }) },
    { name: "jobs_worker", run: createWorkerCheck({ now: () => 40_001, staleAfterMs: 30_000, snapshot: () => ({ active: 4, heartbeatAt: 1, running: true }) }) },
    { name: "catalog", run: createCatalogCheck({ now: () => 100, snapshot: () => ({ failedScans: 1, pendingProbes: 7, scanningRoots: 2 }) }) },
    { name: "content_disk", run: createDiskCheck({ directory: secret, minimumFreeBytes: 100, name: "content_disk", stat: async () => ({ bavail: 2, blocks: 20, bsize: 10 }) }) }
  ];
  const service = createObservabilityService({ checks, now: () => 50_000 });
  const state = await service.readiness();
  assert.equal(state.ready, false);
  assert.deepEqual(state.components.map(({ name, ready, reason }) => ({ name, ready, reason })), [
    { name: "database", ready: false, reason: "query_failed" },
    { name: "jobs_worker", ready: false, reason: "stale" },
    { name: "catalog", ready: false, reason: "scan_failed" },
    { name: "content_disk", ready: false, reason: "low_space" }
  ]);
  assert.doesNotMatch(JSON.stringify(state), /alice|private-film|hunter2/);
});

test("unknown reasons, measurement keys, and non-finite values are bounded", async () => {
  const service = createObservabilityService({ checks: [{
    name: "database",
    run: async () => ({ ready: false, reason: "user-bob-session-123", measurements: { "path/name": 3, count: Infinity, validCount: 2 } })
  }] });
  assert.deepEqual((await service.readiness()).components[0], {
    measurements: { validCount: 2 }, name: "database", ready: false, reason: "unavailable"
  });
});

test("Prometheus output has only bounded component and storage labels", () => {
  const output = renderPrometheusMetrics({ uptimeSeconds: 12.5, readiness: { components: [
    { name: "jobs_worker", ready: true, measurements: { active: 2, heartbeatAgeSeconds: 0.25 } },
    { name: "catalog", ready: true, measurements: { failedScans: 0, pendingProbes: 3, scanningRoots: 1 } },
    { name: "cache_disk", ready: false, measurements: { freeBytes: 10, totalBytes: 100 } }
  ] } });
  assert.match(output, /nebula_component_ready\{component="jobs_worker"\} 1/);
  assert.match(output, /nebula_disk_free_bytes\{storage="cache"\} 10/);
  assert.match(output, /nebula_catalog_pending_probes 3/);
  assert.doesNotMatch(output, /id=|path=|user=|session=|filename=/);
  assert.equal(output.match(/# HELP nebula_component_ready/g)?.length, 1);
  assert.ok(output.endsWith("\n"));
});

test("routes keep liveness and opaque readiness public while protecting diagnostics and metrics", async () => {
  const service = createObservabilityService({
    checks: [{ name: "database", run: async () => ({ ready: false, reason: "query_failed" }) }],
    now: () => 10_000,
    startedAt: 0
  });
  const route = createObservabilityRoutes({ service, isAdmin: (request) => request.admin === true });

  const live = responseCapture();
  assert.equal(await route({ method: "GET" }, live, new URL("http://nebula/healthz")), true);
  assert.deepEqual(JSON.parse(live.result().body), { live: true });

  const ready = responseCapture();
  await route({ method: "GET" }, ready, new URL("http://nebula/readyz"));
  assert.equal(ready.result().status, 503);
  assert.deepEqual(JSON.parse(ready.result().body), { ready: false });
  assert.doesNotMatch(ready.result().body, /database|query/);

  const denied = responseCapture();
  await route({ method: "GET" }, denied, new URL("http://nebula/metrics"));
  assert.equal(denied.result().status, 403);

  const details = responseCapture();
  await route({ method: "GET", admin: true }, details, new URL("http://nebula/api/admin/observability/readiness"));
  assert.equal(details.result().status, 503);
  assert.equal(JSON.parse(details.result().body).components[0].reason, "query_failed");

  const metrics = responseCapture();
  await route({ method: "GET", admin: true }, metrics, new URL("http://nebula/metrics"));
  assert.equal(metrics.result().status, 200);
  assert.match(metrics.result().headers["content-type"], /version=0.0.4/);
  assert.match(metrics.result().body, /nebula_process_uptime_seconds 10/);
});

test("successful injected checks report ready", async () => {
  const service = createObservabilityService({ checks: [
    { name: "database", run: createDatabaseCheck({ database: { prepare: () => ({ get: () => ({ healthy: 1 }) }) } }) },
    { name: "jobs_worker", run: createWorkerCheck({ now: () => 1_000, snapshot: () => ({ active: 0, heartbeatAt: 900, running: true }) }) },
    { name: "catalog", run: createCatalogCheck({ now: () => 1_000, snapshot: () => ({ failedScans: 0, lastCompletedAt: 900, pendingProbes: 0, scanningRoots: 0 }) }) },
    { name: "cache_disk", run: createDiskCheck({ directory: "/ignored", minimumFreeBytes: 1, name: "cache_disk", stat: async () => ({ bavail: 2, blocks: 4, bsize: 10 }) }) }
  ] });
  assert.equal((await service.readiness()).ready, true);
});
