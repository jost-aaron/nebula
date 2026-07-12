import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const source = await readFile(new URL("../src/settings/transcodeAccelerationAdmin.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../src/settings/transcodeAccelerationAdmin.css", import.meta.url), "utf8");
const settings = await readFile(new URL("../src/settings/renderSettingsPanel.ts", import.meta.url), "utf8");
test("owner-only Settings surface reports mode, backend, self-test, counts, probe time, and remediation", () => {
  assert.match(settings, /showJobsAdmin \? `<button type="button" data-diagnostic-tab="transcode-acceleration"/);
  assert.match(source, /Configured mode/); assert.match(source, /Selected backend/); assert.match(source, /Self-test decision/); assert.match(source, /Active jobs/); assert.match(source, /Last probe/); assert.match(source, /Docker Desktop on macOS/);
});
test("transcode controls stack at phone width", () => { assert.match(css, /@media \(max-width:760px\)/); assert.match(css, /grid-template-columns:1fr/); });
