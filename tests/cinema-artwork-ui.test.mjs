import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(file, import.meta.url), "utf8");

test("Cinema keeps queued titles visible and distinguishes active artwork processing", async () => {
  const [cinema, styles, types] = await Promise.all([
    read("../src/cinema/renderCinemaView.ts"),
    read("../src/cinema/cinemaBrand.css"),
    read("../src/shared/cinemaTypes.ts")
  ]);

  assert.match(types, /artworkState: "failed" \| "missing" \| "processing" \| "queued" \| "ready"/);
  assert.match(cinema, /entry\.artworkState === "processing"[\s\S]*Generating title card/);
  assert.match(cinema, /cinema-artwork-processing-overlay/);
  assert.match(cinema, /entry\.artworkState === "queued"[\s\S]*Queued for artwork/);
  assert.match(cinema, /const tmdbUserScore[\s\S]*TMDB users \$\{entry\.rating\}\/10/);
  assert.match(cinema, /const renderCardFacts[\s\S]*cinema-card-facts/);
  assert.match(cinema, /const renderTitleFacts[\s\S]*cinema-title-score[\s\S]*TMDB user score/);
  assert.match(cinema, /TMDB user score[\s\S]*Runtime/);
  assert.match(cinema, /series\.runtimeSeconds[\s\S]*total/);
  assert.match(cinema, /data-cinema-artwork-state="\$\{entry\.artworkState\}"/);
  assert.match(cinema, /getCinemaArtworkStatus\(sourceIds\)/);
  assert.match(cinema, /window\.setTimeout\(\(\) => void refreshArtworkStates\(\), 400\)/);
  assert.match(cinema, /artworkQueueActive = status\.activity\.queued > 0/);
  assert.match(cinema, /data-cinema-artwork-activity/);
  assert.match(cinema, /status\.dataset\.artworkSignature === signature/);
  assert.match(cinema, /activity\.processing\.kind === "metadata"/);
  assert.match(cinema, /Matching with TMDB/);
  assert.match(cinema, /Generating title card/);
  assert.match(cinema, /if \(poster\.dataset\.cinemaPoster\) return/);
  assert.match(styles, /\.cinema-artwork-orbit::before[\s\S]*animation: cinema-artwork-spin/);
  assert.match(styles, /\.cinema-artwork-queued img[\s\S]*opacity:/);
  assert.match(styles, /\.cinema-poster \{[\s\S]*background-size: contain[\s\S]*background-repeat: no-repeat/);
  assert.match(styles, /\.cinema-card-facts \{[\s\S]*position: absolute/);
  assert.match(styles, /\.cinema-title-facts \{[\s\S]*display: flex/);
  assert.match(styles, /\.cinema-title-facts \.cinema-title-score strong \{[\s\S]*color: var\(--cinema-amber-bright\)/);
  assert.match(styles, /\.cinema-artwork-activity \.cinema-artwork-orbit/);
  assert.match(styles, /\.cinema-artwork-activity \{[\s\S]*?position: sticky[\s\S]*?top: 0/);
  assert.match(styles, /@keyframes cinema-artwork-activity-sweep/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*animation: none/);
});

test("Cinema navigates television as series, then seasons, then episodes", async () => {
  const cinema = await readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/cinema/cinemaBrand.css", import.meta.url), "utf8");
  assert.match(cinema, /data-cinema-season/);
  assert.match(cinema, /view = "season-detail"/);
  assert.match(cinema, /renderSeasonDetail/);
  assert.match(cinema, /data-cinema-action="series"/);
  assert.match(cinema, /cinema-hero-back/);
  assert.match(styles, /\.cinema-season-library \.cinema-grid[\s\S]*grid-auto-flow: row[\s\S]*repeat\(auto-fill/);
});

test("Cinema contains title actions and keeps chapter status in the metadata panel", async () => {
  const cinema = await readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/cinema/cinemaBrand.css", import.meta.url), "utf8");
  assert.match(cinema, /cinema-detail-lower[\s\S]*renderNextUpQueue[\s\S]*cinema-title-controls[\s\S]*renderPlaybackSettings[\s\S]*renderChapterStrip[\s\S]*cinema-meta-list/);
  assert.match(styles, /max-width: 980px[\s\S]*cinema-title-panel \.cinema-actions[\s\S]*repeat\(2/);
  assert.match(styles, /\.cinema-title-panel \.cinema-actions \{[\s\S]*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.cinema-title-panel \.cinema-actions button \{[\s\S]*min-width: 0[\s\S]*white-space: normal[\s\S]*overflow-wrap: anywhere/);
  assert.match(styles, /cinema-title-controls > \.cinema-catalog-note/);
  assert.match(styles, /\.cinema-detail-lower \{[\s\S]*grid-template-columns: minmax\(0, 1\.95fr\) minmax\(340px, 0\.9fr\)/);
  assert.match(styles, /\.cinema-shell:has\(\[data-cinema-view="title-detail"\]\) \.cinema-content \{[\s\S]*overflow-y: auto/);
  assert.match(styles, /\.cinema-title-detail \{[\s\S]*height: max-content[\s\S]*grid-template-rows: auto auto/);
});
