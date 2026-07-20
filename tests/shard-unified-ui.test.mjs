import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Cinema and Studio route direct remote playback through cluster sessions", async () => {
  const [cinema, cinemaApi, studio, musicApi, styles] = await Promise.all([
    readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/api/cinemaApi.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/api/musicApi.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(cinema, /aria-label="Available on"/);
  assert.match(cinema, /createClusterCinemaDelivery/);
  assert.match(cinemaApi, /\/api\/cluster\/playback-sessions/);
  assert.match(cinema, /!selected\.streamUrl && !selected\.federation/);
  assert.match(studio, /aria-label="Available on"/);
  assert.match(studio, /createClusterMusicDelivery/);
  assert.match(musicApi, /\/api\/cluster\/playback-sessions/);
  assert.match(styles, /\.cinema-shard-availability/);
  assert.match(styles, /\.studio-shard-availability/);
  assert.match(styles, /@media \(max-width: 720px\)/);
});
