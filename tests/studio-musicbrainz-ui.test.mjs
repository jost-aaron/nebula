import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Studio exposes MusicBrainz review, local cover progress, and provider attribution", async () => {
  const [view, api, styles] = await Promise.all([
    readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/api/musicApi.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(view, /Incorrect match\?/);
  assert.match(view, /Search MusicBrainz/);
  assert.match(view, /No MusicBrainz matches found/);
  assert.match(view, /musicMatchSearch = \{/);
  assert.match(view, /Cover Art Archive/);
  assert.match(view, /Downloading cover/);
  assert.match(api, /\/api\/music\/metadata\/apply/);
  assert.match(api, /\/api\/music\/metadata\/candidates/);
  assert.match(styles, /\.studio-match-dialog/);
  assert.match(styles, /studio-cover-spin/);
});
