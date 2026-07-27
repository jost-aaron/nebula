import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [files, main, party, studio, cinema, focus] = await Promise.all([
  readFile(new URL("../src/files/fileBrowser.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/party/renderPartyView.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/shared/dialogFocus.ts", import.meta.url), "utf8")
]);

test("Files consumes bounded server pages without replacing existing entries", () => {
  assert.match(files, /nextCursor\?: string/);
  assert.match(files, /total\?: number/);
  assert.match(files, /limit=120/);
  assert.match(files, /entries = append \? \[\.\.\.entries, \.\.\.listing\.entries\] : listing\.entries/);
  assert.match(files, /data-file-load-more/);
  assert.match(files, /Showing \$\{entries\.length\} of \$\{total\}/);
});

test("active applications receive controller focus, activation, and cancellable Back", () => {
  assert.match(main, /command\.source === "gamepad"/);
  assert.match(main, /new KeyboardEvent\("keydown", \{ bubbles: true, cancelable: true, key: "Escape" \}\)/);
  assert.match(main, /if \(escape\.defaultPrevented\) return/);
  assert.match(main, /focusable\[nextIndex\]\?\.focus/);
  assert.match(main, /active\?\.click\(\)/);
});

test("Party and Studio dialogs trap focus and restore their invoking control", () => {
  assert.match(focus, /event\.key !== "Tab"/);
  assert.match(focus, /event\.shiftKey/);
  assert.match(focus, /trigger\?\.isConnected/);
  assert.match(party, /dialogFocus\.activate\(trigger/);
  assert.match(party, /dialogFocus\.deactivate/);
  assert.match(party, /dialogFocus\.handleKeydown/);
  assert.match(studio, /dialogFocus\.activate\(trigger/);
  assert.match(studio, /dialogFocus\.deactivate/);
  assert.match(studio, /dialogFocus\.handleKeydown/);
});

test("large changing Party regions are not live regions and message history is a log", () => {
  assert.match(party, /data-party-messages role="log" aria-live="off"/);
  assert.doesNotMatch(party, /data-party-conversations aria-live/);
  assert.match(party, /data-party-live role="status" aria-live="polite"/);
  assert.doesNotMatch(main, /class="home" aria-live/);
  assert.doesNotMatch(main, /class="app-surface"[^>]*aria-live/);
});

test("Cinema and Studio import bounded Lucide icon maps", () => {
  assert.doesNotMatch(cinema, /import \{ createElement, icons \} from "lucide"/);
  assert.doesNotMatch(studio, /import \{ createElement, icons \} from "lucide"/);
  assert.match(cinema, /const cinemaIcons: Record<string, IconNode>/);
  assert.match(studio, /const studioIcons: Record<string, IconNode>/);
});
