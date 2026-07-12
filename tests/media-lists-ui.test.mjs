import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Cinema and Studio expose stable-ID playlist integration with a 390px responsive contract", async () => {
  const [cinema, studio, css, api] = await Promise.all([
    readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/api/mediaListsApi.ts", import.meta.url), "utf8")
  ]);
  assert.match(cinema, /data-cinema-action="save-playlist"/);
  assert.match(studio, /data-studio-action="save-playlist"/);
  assert.match(cinema, /entry\.id/);
  assert.match(studio, /selected\.id/);
  assert.match(api, /itemId/);
  assert.doesNotMatch(api, /\bpath\b/);
  assert.match(css, /@media \(max-width: 430px\)/);
  assert.match(css, /save-playlist/);
});
