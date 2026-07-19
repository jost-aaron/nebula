import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [source, styles] = await Promise.all([
  readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8")
]);

test("the browser shell exposes a supported full-app fullscreen mode", () => {
  assert.match(source, /id="browser-fullscreen"[^>]+aria-label="Enter fullscreen"/);
  assert.match(source, /document\.documentElement as BrowserFullscreenElement/);
  assert.match(source, /page\.requestFullscreen\(\{ navigationUI: "hide" \}\)/);
  assert.match(source, /document\.exitFullscreen/);
  assert.match(source, /webkitRequestFullscreen/);
  assert.match(source, /webkitExitFullscreen/);
  assert.match(source, /browserFullscreenButton\.hidden = !browserFullscreenSupported\(\)/);
  assert.match(source, /document\.addEventListener\("fullscreenchange", syncBrowserFullscreenControl\)/);
  assert.match(source, /active \? "Exit fullscreen" : "Fullscreen"/);
  assert.match(styles, /\.fullscreen-command \{[\s\S]*?cursor: pointer/);
  assert.match(styles, /\.fullscreen-command\.active/);
});
