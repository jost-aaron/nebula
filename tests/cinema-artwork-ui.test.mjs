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
