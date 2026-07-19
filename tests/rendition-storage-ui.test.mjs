import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/settings/renditionStorageAdmin.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../src/settings/renditionStorageAdmin.css", import.meta.url), "utf8");
const settings = await readFile(new URL("../src/settings/renderSettingsPanel.ts", import.meta.url), "utf8");
const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");

test("owner Settings exposes bounded rendition storage policy and confirmed cleanup", () => {
  assert.match(settings, /showJobsAdmin \? `<button type="button" data-diagnostic-tab="rendition-storage"/);
  assert.match(source, /Confirm cleanup/);
  assert.match(source, /Pinned output will be preserved/);
  assert.doesNotMatch(source, /window\.confirm/);
  assert.match(source, /Quota bytes/);
  assert.match(source, /Scheduled profiles/);
  assert.match(main, /bindRenditionStorageAdmin/);
  assert.match(main, /disposeRenditionStorage\(\)/);
});

test("rendition storage controls stack at phone widths", () => {
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /\.rendition-storage-summary,\.rendition-storage-fields\{grid-template-columns:1fr\}/);
});
