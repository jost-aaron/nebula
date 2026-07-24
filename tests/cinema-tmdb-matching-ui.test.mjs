import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(file, import.meta.url), "utf8");

test("Cinema exposes saved TMDB alternatives and an incorrect-match correction flow", async () => {
  const [api, cinema, controller, projection, types] = await Promise.all([
    read("../src/api/cinemaApi.ts"),
    read("../src/cinema/renderCinemaView.ts"),
    read("../src/cinema/tmdbUi.ts"),
    read("../server/catalog/projections.mjs"),
    read("../src/shared/cinemaTypes.ts")
  ]);

  assert.match(api, /\/api\/cinema\/tmdb\/candidates\?path=/);
  assert.match(cinema, /Incorrect match\?/);
  assert.match(cinema, /Review \$\{entry\.tmdbMatchCandidateCount\} possible matches/);
  assert.match(controller, /getCinemaTmdbCandidates\(selected\.path\)/);
  assert.match(controller, /If this title is identified incorrectly/);
  assert.match(controller, /Current Match/);
  assert.match(cinema, /candidate\.path === updated\.path && !candidate\.series/);
  assert.match(cinema, /seriesEpisodes = seriesEpisodes\.map/);
  assert.match(cinema, /const loadLibrary = async \(reset = true, preserveSelected = false\)/);
  assert.match(cinema, /tmdbController\.apply\(actionButton\)[\s\S]*loadLibrary\(true, true\)/);
  assert.match(cinema, /view === "library" \|\| view === "watchlist"[\s\S]*\[\.\.\.entries, \.\.\.seriesEpisodes\]/);
  assert.match(projection, /tmdbMatchCandidateCount/);
  assert.match(types, /tmdbMatchStatus\?: "identified" \| "needs-review" \| "not-found"/);
});
