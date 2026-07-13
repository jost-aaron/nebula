import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("Cinema exposes Auto, Original, and fixed profile controls with actual delivery status", () => {
  assert.match(source, /data-cinema-player-quality/);
  for (const value of ["auto", "original", "480p", "720p", "1080p"]) assert.match(source, new RegExp(value));
  assert.match(source, /quality:\s*preference/);
  assert.match(source, /qualityResultLabel\(preference, created\.plan\)/);
  assert.match(source, /data-cinema-quality-result/);
});

test("Cinema uses native-or-MSE HLS and tears it down with delivery lifecycle", () => {
  assert.match(source, /supportsHlsPlayback\(player\)/);
  assert.match(source, /createHlsPlayback\(/);
  assert.match(source, /hlsPlayback\?\.destroy\(\)/);
  assert.match(source, /startPositionSeconds:\s*targetPosition/);
});

test("quality controls remain reachable in the phone player layout", () => {
  const finalPhoneOverride = styles.lastIndexOf("@media (max-width: 700px)");
  const oldHiddenRule = styles.lastIndexOf(".cinema-player-header .cinema-player-quality {\n    display: none");
  assert.ok(finalPhoneOverride > oldHiddenRule);
  assert.match(styles.slice(finalPhoneOverride), /\.cinema-player-header \.cinema-player-quality[\s\S]*display:\s*grid/);
});
