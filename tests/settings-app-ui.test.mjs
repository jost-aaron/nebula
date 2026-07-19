import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panel = await readFile(new URL("../src/settings/renderSettingsPanel.ts", import.meta.url), "utf8");
const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../src/settings/settingsApp.css", import.meta.url), "utf8");

test("Settings is a focused application shell with grouped navigation and a curated overview", () => {
  assert.match(panel, /settings-masthead/);
  assert.match(panel, /settings-sidebar/);
  assert.match(panel, /settings-workspace/);
  for (const group of ["Start", "Server", "System"]) assert.match(panel, new RegExp(`<small>${group}<\\/small>`));
  assert.match(panel, /data-diagnostic-section="overview"/);
  assert.match(panel, /data-settings-jump="remote-access"/);
  assert.match(main, /all: \["overview"\]/);
  assert.match(main, /data-settings-view-title/);
  assert.match(main, /aria-current/);
  assert.match(main, /ArrowDown/);
  assert.match(main, /data-settings-jump/);
});

test("Settings keeps large controls and a bounded responsive workspace", () => {
  assert.match(css, /\.settings-categories button \{[\s\S]*?min-height: 46px/);
  assert.match(css, /\.settings-layout \{[^}]*grid-template-columns: 270px minmax\(0, 1fr\)/);
  assert.match(css, /\.settings-workspace \{[^}]*min-width: 0/);
  assert.match(css, /\[data-diagnostic-section\]\[hidden\] \{ display: none !important; \}/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /\.settings-layout \{ grid-template-columns: minmax\(0, 1fr\); grid-template-rows: auto minmax\(0, 1fr\); \}/);
  assert.match(css, /safe-area-inset-top/);
});
