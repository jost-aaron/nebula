import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Cinema pagination appends into the real library scroller without rebuilding it", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(source, /const observerRoot = content\.querySelector<HTMLElement>\("\.cinema-library\.browsing"\) \?\? content/);
  assert.match(source, /root: scrollHost, rootMargin: "0px 0px 3200px 0px"/);
  assert.match(source, /grid\?\.insertAdjacentHTML\("beforeend", renderCinemaCards\(appendedEntries, activeCategory, playback\)\)/);
  assert.match(source, /bindLibraryPageObserver\(\);[\s\S]*?return;/);
  assert.match(source, /const previousLibraryScrollTop = view === "library" && !isScanning/);
  assert.doesNotMatch(source, /scrollHost\.scrollTop = preservedScrollTop/);
  assert.match(styles, /\.cinema-library\.browsing,[\s\S]*?overflow-anchor: none/);
});

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

test("Cinema owns its transport controls while retaining the native video engine", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(source, /<video class="cinema-player" data-cinema-player autoplay/);
  assert.doesNotMatch(source, /<video[^>]+controls/);
  assert.match(source, /data-cinema-controls/);
  assert.match(source, /data-cinema-action="player-toggle"/);
  assert.match(source, /data-cinema-action="player-mute"/);
  assert.match(source, /data-cinema-action="player-skip-back"[^>]+aria-label="Skip backward 10 seconds"/);
  assert.match(source, /data-cinema-action="player-skip-forward"[^>]+aria-label="Skip forward 10 seconds"/);
  assert.match(source, /data-cinema-seek/);
  assert.match(source, /data-cinema-volume/);
  assert.match(source, /data-cinema-action="player-subtitles"/);
  assert.match(source, /data-cinema-subtitle-menu hidden/);
  assert.match(source, /player\.buffered\.end\(index\)/);
  assert.match(source, /--cinema-buffered/);
  assert.match(source, /controlsHideTimer/);
  assert.match(source, /stage\.addEventListener\("pointermove", \(\) => \{ keyboardControlsActive = false; revealControls\(\); \}\)/);
  assert.match(source, /!player\.paused && !player\.ended && !controlsAreEngaged\(\)/);
  assert.match(source, /stage\.classList\.contains\("is-fullscreen"\) \? 1_000 : 2_500/);
  assert.match(source, /return menuOpen \|\| pointerOverTransport \|\| Boolean\(focusedControl\)/);
  assert.match(source, /transport\?\.addEventListener\("pointerleave", \(\) => \{ pointerOverTransport = false; revealControls\(\); \}\)/);
  assert.match(source, /stage\.addEventListener\("focusin", \(\) => revealControls\(keyboardControlsActive \? false : !pointerOverTransport\)\)/);
  assert.match(source, /--cinema-transport-height/);
  assert.match(source, /new ResizeObserver\(syncTransportHeight\)/);
  assert.match(source, /transportResizeObserver\?\.disconnect\(\)/);
  assert.match(source, /document\.fullscreenElement \?\? \(document as WebkitFullscreenDocument\)\.webkitFullscreenElement/);
  assert.match(source, /const toggleCinemaFullscreen = async/);
  assert.match(source, /if \(currentFullscreenElement\(\)\) \{[\s\S]*?await exitFullscreen\(\)/);
  assert.match(source, /webkitPlayer\.webkitDisplayingFullscreen/);
  assert.match(source, /webkitPlayer\.webkitExitFullscreen/);
  assert.match(source, /fullscreenElement === stage\s*\|\| Boolean\(fullscreenElement && stage\.contains\(fullscreenElement\)\)/);
  assert.match(source, /document\.addEventListener\("fullscreenchange", syncFullscreenControl\)/);
  assert.match(source, /document\.removeEventListener\("fullscreenchange", syncFullscreenControl\)/);
  assert.match(source, /document\.addEventListener\("webkitfullscreenchange", syncFullscreenControl\)/);
  assert.match(source, /document\.removeEventListener\("webkitfullscreenchange", syncFullscreenControl\)/);
  assert.match(source, /fullscreenButton\?\.addEventListener\("click", onFullscreenButtonClick\)/);
  assert.match(source, /event\.stopPropagation\(\);[\s\S]*?toggleCinemaFullscreen\(stage, player\)/);
  assert.match(source, /fullscreenButton\?\.removeEventListener\("click", onFullscreenButtonClick\)/);
  assert.match(source, /isFullscreen \? "Exit fullscreen video" : "Fullscreen video"/);
  assert.match(source, /stage\.classList\.toggle\("is-fullscreen", isFullscreen\)/);
  assert.match(source, /event\.key !== "ArrowLeft" && event\.key !== "ArrowRight"/);
  assert.match(source, /seekBySeconds\(event\.key === "ArrowLeft" \? -10 : 10\)/);
  assert.match(source, /window\.removeEventListener\("keydown", onPlayerKeyDown, true\)/);
  assert.match(styles, /\.cinema-transport/);
  assert.match(styles, /right:\s*0;[\s\S]*bottom:\s*0;[\s\S]*left:\s*0;/);
  assert.match(styles, /var\(--cinema-buffered\)/);
  assert.match(styles, /\.cinema-video-stage\.controls-hidden \.cinema-transport/);
  assert.match(styles, /\.cinema-video-stage:not\(\.controls-hidden\) \.cinema-player \{[\s\S]*?height: calc\(100% - var\(--cinema-transport-height, 0px\)\)/);
  assert.match(styles, /\.cinema-video-stage:not\(\.controls-hidden\) \.cinema-player-overlay \{[\s\S]*?bottom: var\(--cinema-transport-height, 0px\)/);
  assert.match(styles, /\.cinema-video-stage:fullscreen/);
  assert.match(styles, /\.cinema-transport-actions \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
  assert.match(source, /cinema-transport-group cinema-transport-group-center[\s\S]*?player-skip-back[\s\S]*?player-toggle[\s\S]*?player-skip-forward/);
  assert.match(source, /cinema-transport-group cinema-transport-group-right[\s\S]*?player-subtitles[\s\S]*?player-quality[\s\S]*?player-fullscreen/);
  assert.match(styles, /\.cinema-transport-group-center \{[\s\S]*?justify-content: center/);
  assert.match(styles, /\.cinema-transport-group-right \{[\s\S]*?justify-content: flex-end/);
  assert.match(styles, /\.cinema-video-stage\.is-fullscreen \.cinema-transport \.cinema-control-menu-button \{[\s\S]*?width: 36px;[\s\S]*?height: 36px;[\s\S]*?border-radius: 50%/);
  assert.match(styles, /\.cinema-video-stage\.is-fullscreen \.cinema-control-menu-button > span \{[\s\S]*?display: none/);
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
