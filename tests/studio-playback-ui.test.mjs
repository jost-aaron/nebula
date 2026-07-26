import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Studio pagination preserves its scroll container while appending pages", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(source, /const preservedScrollTop = reset \? null : content\.scrollTop/);
  assert.match(source, /if \(preservedScrollTop !== null\) content\.scrollTop = preservedScrollTop/);
  assert.match(source, /const previousLibraryScrollTop = !selected && !isScanning \? content\.scrollTop : null/);
  assert.match(source, /const patchLibraryPage = \(\) =>/);
  assert.match(source, /const updatedIncrementally = !reset && patchLibraryPage\(\)/);
  assert.match(source, /data-studio-item-key/);
  assert.match(styles, /\.studio-content \{[\s\S]*?overflow-anchor: none/);
  assert.match(styles, /\.studio-track \{[\s\S]*?content-visibility: auto/);
});

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

test("Studio reserves a dedicated grid row for background jobs", async () => {
  const [studio, css] = await Promise.all([
    readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(
    studio,
    /studio-job-activity[\s\S]*?<main class="studio-content"/
  );
  assert.match(
    css,
    /\.studio-shell\s*\{[\s\S]*?grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto auto;/
  );
});

test("Studio browsing does not replace active playback and exposes explicit queue actions", async () => {
  const [studio, css] = await Promise.all([
    readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(
    studio,
    /const selectTrack = \(entry: MusicEntry, autoplay = false\) => \{\s*selected = entry;\s*render\(\);\s*content\.scrollTop = 0;\s*if \(autoplay\) requestSelectedPlayback\(entry\);/
  );
  assert.doesNotMatch(
    studio,
    /const selectTrack = \(entry: MusicEntry, autoplay = false\) => \{[^}]*setPlayerEntry\(entry\)/s
  );
  assert.match(studio, /const isCurrent = playingEntry\?\.path === entry\.path/);
  assert.match(studio, /data-studio-action="play-now"/);
  assert.match(studio, /data-studio-action="play-next"/);
  assert.match(studio, /data-studio-action="add-queue"/);
  assert.match(studio, /let playbackQueue: MusicEntry\[\] = \[\]/);
  assert.match(studio, /if \(playbackQueue\.length > 0\) window\.setTimeout\(\(\) => playQueuedEntry\(\), 0\)/);
  assert.match(css, /\.studio-browsing-note[\s\S]*?background: rgba\(94, 215, 165, 0\.065\)/);
  assert.match(css, /\.studio-play-now-command[\s\S]*?background: var\(--studio-amber-bright\)/);
});

test("Studio owns library request generations and does not reload history for appended pages", async () => {
  const [studio, api] = await Promise.all([
    readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/api/musicApi.ts", import.meta.url), "utf8")
  ]);

  assert.match(api, /signal\?: AbortSignal/);
  assert.match(api, /apiJson<MusicLibraryResponse>\([\s\S]*?\{ signal \}\)/);
  assert.match(api, /listStudioPlaybackHistory = \(limit = 50, signal\?: AbortSignal\)/);
  assert.match(studio, /libraryController\?\.abort\(\)/);
  assert.match(studio, /requestGeneration !== libraryGeneration/);
  assert.match(studio, /reset && personalPlayback[\s\S]*?listStudioPlaybackHistory\(50, requestController\.signal\)[\s\S]*?: Promise\.resolve\(null\)/);
});

test("Studio teardown and visualizer scheduling are bounded by the mounted active view", async () => {
  const studio = await readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8");

  assert.match(studio, /return \(\) => undefined/);
  assert.match(studio, /const dispose = \(\) =>/);
  assert.match(studio, /if \(viewDisposed\) return/);
  assert.match(studio, /viewController\.abort\(\)/);
  assert.match(studio, /return dispose/);
  assert.match(studio, /document\.visibilityState === "visible"/);
  assert.match(studio, /motionPreference\.matches/);
  assert.match(studio, /!audioPlayer\.paused/);
  assert.match(studio, /Boolean\(visualizer\)/);
  assert.doesNotMatch(studio, /if \(!visualizer \|\| !context\) \{\s*animationFrame = window\.requestAnimationFrame/);
});

test("Studio artwork uses semantic lazy decoded images instead of CSS background URLs", async () => {
  const [studio, css] = await Promise.all([
    readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(studio, /alt="\$\{escapeHtml\(`Cover art for \$\{entry\.title\}`\)\}"/);
  assert.match(studio, /loading="lazy" decoding="async"/);
  assert.doesNotMatch(studio, /background-image: url/);
  assert.match(css, /\.studio-album-art\.has-poster img \{[\s\S]*?object-fit: cover/);
});
