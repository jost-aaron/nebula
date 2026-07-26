import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(file, import.meta.url), "utf8");

test("Cinema and Studio load as lifecycle-safe app chunks", async () => {
  const [main, cinema] = await Promise.all([
    read("../src/main.ts"),
    read("../src/cinema/renderCinemaView.ts")
  ]);

  assert.doesNotMatch(main, /from "\.\/cinema\/renderCinemaView"/);
  assert.doesNotMatch(main, /from "\.\/studio\/renderStudioView"/);
  assert.match(main, /import\("\.\/cinema\/renderCinemaView"\)/);
  assert.match(main, /import\("\.\/studio\/renderStudioView"\)/);
  assert.match(main, /const launchGeneration = \+\+activeAppLaunchGeneration/);
  assert.match(main, /launchGeneration !== activeAppLaunchGeneration/);
  assert.match(main, /activeAppLaunchGeneration \+= 1/);
  assert.match(main, /data-app-module-retry/);
  assert.match(main, /disposeActiveApp = mediaModule\.bindCinemaView/);
  assert.match(main, /disposeActiveApp = mediaModule\.bindStudioView/);
  assert.match(cinema, /import "\.\/cinemaBrand\.css"/);
});

test("Cinema defers the HLS engine until an HLS delivery is attached", async () => {
  const [cinema, playback, support] = await Promise.all([
    read("../src/cinema/renderCinemaView.ts"),
    read("../src/cinema/hlsPlayback.ts"),
    read("../src/cinema/hlsSupport.ts")
  ]);

  assert.doesNotMatch(cinema, /import \{[^}]*createHlsPlayback[^}]*\} from "\.\/hlsPlayback"/);
  assert.match(cinema, /created\.plan\.output\.protocol === "hls"[\s\S]*import\("\.\/hlsPlayback"\)/);
  assert.match(cinema, /import type \{ HlsPlaybackHandle \} from "\.\/hlsPlayback"/);
  assert.match(playback, /from "hls\.js"/);
  assert.doesNotMatch(support, /from "hls\.js"/);
});

test("large media browse surfaces have an explicit finite DOM bound", async () => {
  const [cinema, studio] = await Promise.all([
    read("../src/cinema/renderCinemaView.ts"),
    read("../src/studio/renderStudioView.ts")
  ]);

  for (const source of [cinema, studio]) {
    assert.match(source, /const libraryBrowseLimit = 600/);
    assert.match(source, /library\.page\.hasMore && entries\.length >= libraryBrowseLimit/);
    assert.match(source, /Search narrows the full library without growing this view further/);
  }
  assert.match(cinema, /Math\.min\(60, Math\.max\(1, libraryBrowseLimit/);
  assert.match(studio, /Math\.min\(100, Math\.max\(1, libraryBrowseLimit/);
});
