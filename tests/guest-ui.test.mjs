import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("first-run and guest dashboard expose the required focused UI contracts", async () => {
  const [ui, main, css] = await Promise.all([
    readFile(new URL("../src/account/accountUi.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(ui, /Continue as Guest/);
  assert.match(ui, /Create Owner Account/);
  assert.match(ui, /Cinema and Studio only/);
  assert.match(main, /\["cinema", "studio", "search"\]/);
  assert.match(css, /@media\s*\(max-width:\s*430px\)/);
  assert.match(css, /\.account-stage/);
});

test("guest Cinema skips personal playback synchronization", async () => {
  const [main, cinema] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8")
  ]);

  assert.match(main, /personalPlayback: !isGuest/);
  assert.match(cinema, /options\.personalPlayback === false \? \{ entries: \[\] \} : await listCinemaContinueWatching\(\)/);
  assert.match(cinema, /guest session/);
});
