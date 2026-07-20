import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the browser never forwards ticket-bearing media URLs as referrers", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>/);
});
