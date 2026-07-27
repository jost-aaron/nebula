import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/party/renderPartyView.ts", import.meta.url), "utf8");

test("Party attachment previews are visibility-gated and concurrency bounded", () => {
  assert.match(source, /new IntersectionObserver/);
  assert.match(source, /rootMargin: "240px"/);
  assert.match(source, /const maxPreviewLoads = 3/);
  assert.match(source, /activePreviewLoads < maxPreviewLoads/);
});

test("Party patches resolved previews without rebuilding full lists", () => {
  const patch = source.slice(
    source.indexOf("const patchAttachmentPreviews"),
    source.indexOf("const pumpPreviewQueue")
  );
  assert.match(patch, /replaceChildren/);
  assert.doesNotMatch(patch, /renderConversationList|renderMessages|innerHTML/);
  assert.match(source, /previewObserver\?\.disconnect\(\)/);
});
