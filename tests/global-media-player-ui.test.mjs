import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Nebula keeps music and video playback alive across app navigation", async () => {
  const [main, studio, cinema, styles] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(main, /id="background-media-host"/);
  assert.match(main, /const mediaSurfaceCache = new Map/);
  assert.match(main, /cached\.element\.classList\.add\("background-media-app"\)/);
  assert.match(main, /cachedMedia\.element\.classList\.add\("foreground-media-app"\)/);
  assert.match(main, /backgroundMediaHost\.append\(element\)/);
  assert.match(main, /mediaSurfaceCache\.set\("studio", \{ dispose, element \}\)/);
  assert.match(main, /mediaSurfaceCache\.set\("cinema", \{ dispose, element \}\)/);
  assert.match(main, /document\.addEventListener\("play"[\s\S]*?media\.pause\(\)/);
  assert.match(main, /backgroundVideoReturn\.addEventListener\("click"/);
  assert.match(main, /backgroundMediaHost\.addEventListener\("pointerdown"/);
  assert.match(main, /backgroundMediaHost\.addEventListener\("pointermove"/);
  assert.match(main, /compactVideoInteractiveSelector/);
  assert.match(main, /Math\.hypot\(deltaX, deltaY\) < 5/);
  assert.match(main, /const clampCompactVideoPosition/);
  assert.match(main, /window\.addEventListener\("resize"/);
  assert.match(main, /backgroundVideoClose\.addEventListener\("click"[\s\S]*?backToTitle\.click\(\)/);
  assert.match(studio, /miniPlayer\.hidden = !playingEntry/);
  assert.match(studio, /data-studio-action="close-player"/);
  assert.match(studio, /if \(actionButton\?\.dataset\.studioAction === "close-player"\)[\s\S]*?closePlayer\(\)/);
  assert.doesNotMatch(studio, /if \(actionButton\?\.dataset\.studioAction === "home"\) \{\s*dispose\(\)/);
  assert.doesNotMatch(cinema, /if \(action === "home"\) \{\s*stopActivePlayback/);
  assert.match(styles, /\.foreground-media-app/);
  assert.match(styles, /\.studio-shell\.background-media-app \.studio-mini-player:not\(\[hidden\]\)/);
  assert.match(styles, /\.cinema-shell\.background-media-app \.cinema-video-stage/);
  assert.match(styles, /\.cinema-shell\.background-media-app \.cinema-video-stage\.dragging/);
  assert.match(styles, /cursor: grab/);
  assert.match(styles, /\.background-media-host:has\(\.studio-mini-player:not\(\[hidden\]\)\)/);
});
