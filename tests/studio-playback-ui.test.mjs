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
    assert.match(studio, new RegExp(`report\\(\\"${event}\\"\\)`));
  }
  assert.match(studio, /role="dialog" aria-modal="true"/);
  assert.match(studio, /data-studio-action="resume-play"/);
  assert.match(studio, /data-studio-action="restart-play"/);
  assert.match(studio, /Continue Listening/);
  assert.match(studio, /Listening History/);
  assert.match(main, /personalPlayback: !isGuest/);
  assert.match(css, /\.studio-resume-sheet[\s\S]*place-items: center/);
});
