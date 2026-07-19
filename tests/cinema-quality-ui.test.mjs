import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("Cinema exposes Auto, Original, and fixed profile controls with actual delivery status", () => {
  assert.match(source, /data-cinema-player-quality/);
  assert.match(source, /data-cinema-action="player-quality"/);
  assert.match(source, /data-cinema-quality-menu hidden/);
  for (const value of ["auto", "original", "240p", "360p", "480p", "720p", "1080p"]) assert.match(source, new RegExp(value));
  assert.match(source, /quality:\s*preference/);
  assert.match(source, /qualityResultLabel\(preference, created\.plan\)/);
  assert.match(source, /data-cinema-quality-result/);
  assert.match(source, /formatBitrate\(profile\.totalBitrate\)/);
});

test("Cinema uses native-or-MSE HLS and tears it down with delivery lifecycle", () => {
  assert.match(source, /supportsHlsPlayback\(player\)/);
  assert.match(source, /createHlsPlayback\(/);
  assert.match(source, /hlsPlayback\?\.destroy\(\)/);
  assert.match(source, /startPositionSeconds:\s*targetPosition/);
});

test("quality controls remain reachable in the phone player transport", () => {
  assert.match(styles, /\.cinema-quality-menu[\s\S]*width:\s*min\(310px/);
  assert.match(styles, /\.cinema-control-menu\[hidden\][\s\S]*display:\s*none/);
  assert.match(styles, /\.cinema-transport \.cinema-control-menu-button \{[\s\S]*?width: 36px;[\s\S]*?height: 36px;[\s\S]*?border-radius: 50%/);
  assert.match(styles, /\.cinema-control-menu-button span \{[\s\S]*?display: none/);
  assert.match(styles, /@media \(max-width: 700px\) \{[\s\S]*?\.cinema-transport-actions[\s\S]*?grid-template-columns:/);
});
