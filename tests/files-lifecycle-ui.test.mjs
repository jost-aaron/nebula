import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = await readFile(new URL("../src/files/fileBrowser.ts", import.meta.url), "utf8");
const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");

test("Files owns listing and preview generations and exposes teardown", () => {
  assert.match(files, /listingController\?\.abort\(\)/);
  assert.match(files, /previewController\?\.abort\(\)/);
  assert.match(files, /generation !== listingGeneration/);
  assert.match(files, /generation !== previewGeneration/);
  assert.match(files, /return \(\) => \{/);
  assert.match(files, /URL\.revokeObjectURL\(activePreviewObjectUrl\)/);
  assert.match(main, /disposeActiveApp = bindFileBrowser/);
});
