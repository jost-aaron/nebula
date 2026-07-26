import assert from "node:assert/strict";
import test from "node:test";
import { readRuntimeConfig } from "../server/runtimeConfig.mjs";

test("runtime config applies conservative defaults and parses bounded overrides", () => {
  const defaults = readRuntimeConfig({});
  assert.equal(defaults.port, 5173);
  assert.equal(defaults.jobConcurrency, 1);
  assert.equal(defaults.jobHistoryDays, 30);
  assert.equal(defaults.startupScanDelayMs, 120_000);
  assert.equal(defaults.production, false);

  const configured = readRuntimeConfig({
    PORT: "8080",
    NODE_ENV: "production",
    NEBULA_EXTERNAL_HTTPS: "true",
    NEBULA_MEDIA_JOB_CONCURRENCY: "2",
    NEBULA_JOB_HISTORY_DAYS: "60",
    NEBULA_JOB_HISTORY_RETAIN: "500",
    NEBULA_STARTUP_SCAN_DELAY_MS: "0"
  });
  assert.equal(configured.port, 8080);
  assert.equal(configured.production, true);
  assert.equal(configured.externalHttps, true);
  assert.equal(configured.jobConcurrency, 2);
  assert.equal(configured.jobHistoryRetain, 500);
  assert.equal(configured.startupScanDelayMs, 0);
});

test("runtime config rejects malformed or unsafe values at startup", () => {
  assert.throws(() => readRuntimeConfig({ PORT: "not-a-port" }), /PORT must be an integer/);
  assert.throws(() => readRuntimeConfig({ NEBULA_EXTERNAL_HTTPS: "yes" }), /must be true or false/);
  assert.throws(() => readRuntimeConfig({ NEBULA_MEDIA_JOB_CONCURRENCY: "8" }), /between 1 and 2/);
  assert.throws(() => readRuntimeConfig({ NEBULA_AUDIT_RETENTION_DAYS: "0" }), /between 1 and 3650/);
  assert.throws(() => readRuntimeConfig({ NEBULA_STARTUP_SCAN_DELAY_MS: "600001" }), /between 0 and 600000/);
});
