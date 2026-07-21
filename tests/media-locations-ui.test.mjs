import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(file, import.meta.url), "utf8");

test("owner settings expose persistent multi-folder media location controls", async () => {
  const [panel, admin, api, main] = await Promise.all([
    read("../src/settings/renderSettingsPanel.ts"), read("../src/settings/mediaLocationsAdmin.ts"),
    read("../src/api/mediaLocationsApi.ts"), read("../src/main.ts")
  ]);
  assert.match(panel, /data-diagnostic-tab="media-locations"/);
  assert.match(panel, /renderMediaLocationsAdmin\(\)/);
  assert.match(admin, /Movies[\s\S]*TV Shows[\s\S]*Music/);
  assert.match(admin, /data-media-location-form/);
  assert.match(admin, /data-media-location-remove/);
  assert.match(api, /POST[\s\S]*DELETE/);
  assert.match(main, /bindMediaLocationsAdmin/);
});

test("cinema alphabet rail follows the real grid scroll surface without duplicate binding", async () => {
  const [cinema, styles] = await Promise.all([read("../src/cinema/renderCinemaView.ts"), read("../src/styles.css")]);
  assert.match(cinema, /data-cinema-alphabet-rail/);
  assert.match(cinema, /data-cinema-sort-letter/);
  assert.match(cinema, /const scrollHost = library;/);
  assert.match(cinema, /\^\[A-Z\]\$[\s\S]*?\? firstCharacter : "#"/);
  assert.match(cinema, /alphabetScrollHost === scrollHost && refreshAlphabetRail/);
  assert.match(cinema, /requestAnimationFrame\(update\)/);
  assert.match(styles, /\.cinema-alphabet-rail span\.active[\s\S]*?transform: scale\(1\.35\)/);
  assert.match(styles, /\.cinema-alphabet-rail \{[\s\S]*?position: sticky/);
  assert.match(styles, /span\[data-distance="1"\]/);
});
