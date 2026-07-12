import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/settings/playbackPolicyAdmin.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../src/settings/playbackPolicyAdmin.css", import.meta.url), "utf8");
const settings = await readFile(new URL("../src/settings/renderSettingsPanel.ts", import.meta.url), "utf8");
const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");

test("owner Settings exposes global and account playback policies with direct-play disclosure", () => {
  assert.match(settings, /showJobsAdmin \? `<button type="button" data-diagnostic-tab="playback-policy"/);
  assert.match(settings, /renderPlaybackPolicyAdmin\(\)/);
  assert.match(source, /Direct-play limitation:/);
  assert.match(source, /data-policy-global/);
  assert.match(source, /data-policy-user/);
  assert.match(source, /Maximum bitrate \(bps\)/);
});

test("playback policy UI binds live aggregate status and disposes polling", () => {
  assert.match(source, /getPlaybackPolicyStatus/);
  assert.match(source, /window\.setInterval/);
  assert.match(source, /window\.clearInterval/);
  assert.match(main, /bindPlaybackPolicyAdmin/);
  assert.match(main, /disposePlaybackPolicy\(\)/);
});

test("playback policy controls stack without horizontal overflow at phone widths", () => {
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.playback-policy-form \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.playback-policy-summary \{ grid-template-columns: 1fr; \}/);
});
