import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/settings/clusterAdmin.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../src/settings/clusterAdmin.css", import.meta.url), "utf8");
const settings = await readFile(new URL("../src/settings/renderSettingsPanel.ts", import.meta.url), "utf8");
const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");

test("owner Settings exposes bounded cluster scheduling and maintenance controls", () => {
  assert.match(settings, /data-diagnostic-tab="cluster"/);
  assert.match(settings, /renderClusterAdmin\(\)/);
  assert.match(source, /Scheduling priority/);
  assert.match(source, /Stream capacity/);
  assert.match(source, /Live transcodes/);
  assert.match(source, /Drain for maintenance/);
  assert.match(source, /without changing a node's cryptographic identity/);
});

test("cluster controls poll only while visible and dispose cleanly", () => {
  assert.match(source, /window\.setInterval/);
  assert.match(source, /if \(!root\.hidden\)/);
  assert.match(source, /window\.clearInterval/);
  assert.match(main, /bindClusterAdmin/);
  assert.match(main, /disposeCluster\(\)/);
});

test("cluster controls stack without horizontal overflow on phone layouts", () => {
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /\.cluster-admin-summary, \.cluster-node-fields \{ grid-template-columns: minmax\(0,1fr\); \}/);
  assert.match(css, /\.cluster-node-card footer > div \{ width: 100%; flex-direction: column; \}/);
});
