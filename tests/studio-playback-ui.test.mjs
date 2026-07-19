import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Studio integrates personal playback history, lifecycle reporting, and an in-app resume dialog", async () => {
  const [studio, api, main, css] = await Promise.all([
    readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/api/musicApi.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(api, /\/api\/playback\/history/);
  assert.match(api, /\/api\/playback\/events/);
  for (const event of ["start", "progress", "pause", "stop", "complete"]) {
    assert.match(studio, new RegExp(`report\\([^,]+, \\"${event}\\"\\)`));
  }
  assert.match(studio, /role="dialog" aria-modal="true"/);
  assert.match(studio, /data-studio-action="resume-play"/);
  assert.match(studio, /data-studio-action="restart-play"/);
  assert.match(studio, /Continue Listening/);
  assert.match(studio, /Listening History/);
  assert.match(main, /personalPlayback: !isGuest/);
  assert.match(css, /\.studio-resume-sheet[\s\S]*place-items: center/);
});

test("Studio uses a persistent custom player and responsive mini-player instead of native controls", async () => {
  const [studio, css] = await Promise.all([
    readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(studio, /<audio data-studio-player preload="metadata"><\/audio>/);
  assert.doesNotMatch(studio, /<audio[^>]+controls/);
  assert.match(studio, /data-studio-mini-player/);
  assert.match(studio, /data-studio-action="open-player"/);
  assert.match(studio, /data-studio-action="toggle-play"/);
  assert.match(studio, /data-studio-action="toggle-mute"/);
  assert.match(studio, /data-studio-seek/);
  assert.match(studio, /playerCleanup = bindPlayer\(\)/);
  assert.match(css, /\.studio-mini-player/);
  assert.match(css, /\.studio-shell\.has-player \.studio-footer/);
  assert.match(css, /\.studio-transport/);
});
