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
  assert.match(cinema, /const marker = hostBounds\.top \+ 1/);
  assert.match(cinema, /const windowSize = 9/);
  assert.match(cinema, /letter\.hidden = index < windowStart \|\| index >= windowEnd/);
  assert.match(cinema, /class="cinema-library-stage"/);
  assert.doesNotMatch(cinema, /--cinema-alphabet-scroll-offset/);
  assert.match(styles, /\.cinema-alphabet-rail span\.active[\s\S]*?transform: scale\(1\.55\)/);
  assert.doesNotMatch(styles, /transition:[^;]*font-size/);
  assert.match(styles, /\.cinema-alphabet-rail \{[\s\S]*?height: 100%[\s\S]*?justify-content: space-around/);
  assert.match(styles, /\.cinema-library-stage \{[\s\S]*?overflow: hidden/);
  assert.doesNotMatch(styles, /translateY\(var\(--cinema-alphabet-scroll-offset/);
  assert.match(styles, /span\[data-distance="1"\]/);
});

test("Cinema distinguishes initial loading, genuine empty, and failed library states", async () => {
  const [cinema, styles] = await Promise.all([read("../src/cinema/renderCinemaView.ts"), read("../src/styles.css")]);
  assert.match(cinema, /role="status" aria-label="Loading Cinema library"/);
  assert.match(cinema, /Loading your library/);
  assert.match(cinema, /No \$\{escapeHtml\(categoryLabel\(activeCategory\)\.toLowerCase\(\)\)\} found/);
  assert.match(cinema, /let libraryError: string \| null = null/);
  assert.match(styles, /@keyframes cinema-library-spin/);
});
