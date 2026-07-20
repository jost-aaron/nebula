import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Cinema and Studio expose availability while guarding remote playback", async () => {
  const [cinema, studio, styles] = await Promise.all([
    readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(cinema, /aria-label="Available on"/);
  assert.match(cinema, /selected\.playable === false \|\| !selected\.streamUrl/);
  assert.match(studio, /aria-label="Available on"/);
  assert.match(studio, /entry\.playable === false \|\| !entry\.streamUrl/);
  assert.match(styles, /\.cinema-shard-availability/);
  assert.match(styles, /\.studio-shard-availability/);
  assert.match(styles, /@media \(max-width: 720px\)/);
});
