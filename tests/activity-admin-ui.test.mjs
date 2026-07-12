import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/activity-admin/renderActivityAdmin.ts", import.meta.url), "utf8");
const api = await readFile(new URL("../src/api/auditApi.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../src/activity-admin/activityAdmin.css", import.meta.url), "utf8");
const settings = await readFile(new URL("../src/settings/renderSettingsPanel.ts", import.meta.url), "utf8");
const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");

test("desktop activity surface has pagination and all required filters", () => {
  assert.match(api, /\/api\/admin\/audit\?/);
  for (const control of ["event", "outcome", "actor", "principal", "from", "to", "more"]) assert.match(source, new RegExp(`data-activity-${control}`));
  assert.match(source, /nextCursor/);
  assert.match(source, /Load more/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});

test("activity is owner-only in Settings and its lifecycle is disposed", () => {
  assert.match(settings, /showJobsAdmin \? `<button type="button" data-diagnostic-tab="activity">Activity<\/button>`/);
  assert.match(settings, /showJobsAdmin \? renderActivityAdmin\(\)/);
  assert.match(main, /bindActivityAdmin\(appSurface\)/);
  assert.match(main, /disposeActivity\(\)/);
});

test("390x844 activity layout is single-column without horizontal overflow", () => {
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /\.activity-filters, \.activity-card-details \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /\.activity-admin \{[^}]*min-width: 0/);
  assert.match(css, /\.activity-filters label \{ min-width: 0/);
  assert.match(css, /\.activity-header > button, \.activity-more \{ width: 100%; \}/);
  assert.match(css, /\.activity-admin\[hidden\] \{ display: none; \}/);
});
