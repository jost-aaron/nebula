import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Cinema source loading cannot cancel its own delivery session", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.doesNotMatch(source, /addEventListener\("emptied", stopPlayback/);
  assert.match(source, /Ready\. Press Play to start playback\./);
  assert.match(source, /window\.addEventListener\("pagehide", stopPlayback/);
  assert.match(source, /class="cinema-play-orb"[^>]+aria-label="Play"/);
  assert.match(styles, /\.cinema-video-stage \.cinema-play-orb \{[\s\S]*?opacity: 1;[\s\S]*?pointer-events: auto;/);
  assert.match(styles, /\.cinema-video-stage\.is-playing \.cinema-play-orb \{[\s\S]*?opacity: 0;[\s\S]*?pointer-events: none;/);
});

test("Cinema owns the resume decision inside an accessible app dialog", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.doesNotMatch(source, /window\.confirm\(/);
  assert.match(source, /class="cinema-resume-dialog" role="dialog" aria-modal="true"/);
  assert.match(source, /data-cinema-action="resume-play"[^>]*autofocus/);
  assert.match(source, /data-cinema-action="restart-play"/);
  assert.match(source, /data-cinema-action="close-resume"/);
  assert.match(source, /event\.key === "Escape"[\s\S]*?closeResumePrompt\(\)/);
  assert.match(source, /openPlayer\(false, Number\.isFinite\(chapterTime\) \? chapterTime : 0\)/);
  assert.match(styles, /\.cinema-editor-sheet\.cinema-resume-sheet \{[\s\S]*?align-items: center;/);
  assert.match(styles, /\.cinema-resume-dialog \{[\s\S]*?width: min\(540px, 100%\)/);
  assert.match(styles, /@media \(max-width: 640px\) \{[\s\S]*?\.cinema-resume-actions \{[\s\S]*?grid-template-columns: 1fr;/);
});
