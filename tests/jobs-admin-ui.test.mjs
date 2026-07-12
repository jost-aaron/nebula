import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/jobs-admin/renderJobsAdmin.ts", import.meta.url), "utf8");
const api = await readFile(new URL("../src/api/jobsApi.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../src/jobs-admin/jobsAdmin.css", import.meta.url), "utf8");

test("jobs admin covers the persistent lifecycle and supported API routes", () => {
  for (const state of ["queued", "running", "succeeded", "failed", "cancelled"]) assert.match(api, new RegExp(`"${state}"`));
  assert.match(api, /\/api\/jobs\?/);
  assert.match(api, /\/api\/jobs\//);
  assert.match(api, /\/cancel/);
});

test("jobs admin requires explicit cancellation confirmation", () => {
  assert.match(source, /data-jobs-request-cancel/);
  assert.match(source, /data-jobs-confirm-cancel/);
  assert.match(source, /next cancellation checkpoint/);
});

test("jobs admin exposes progress, live status, filtering, and phone layout", () => {
  assert.match(source, /role="progressbar"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /data-jobs-state/);
  assert.match(source, /data-jobs-type/);
  assert.match(css, /@media \(max-width: 560px\)/);
});
