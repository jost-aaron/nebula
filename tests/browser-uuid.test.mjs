import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBrowserUuid } from "../src/shared/browserUuid.ts";

test("browser UUIDs prefer the platform implementation", () => {
  let fallbackCalled = false;
  const value = createBrowserUuid({
    getRandomValues: () => { fallbackCalled = true; throw new Error("fallback should not run"); },
    randomUUID: () => "platform-uuid"
  });
  assert.equal(value, "platform-uuid");
  assert.equal(fallbackCalled, false);
});

test("browser UUIDs use an RFC 4122 v4 getRandomValues fallback", () => {
  const value = createBrowserUuid({
    getRandomValues: (bytes) => {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
      return bytes;
    }
  });
  assert.equal(value, "00010203-0405-4607-8809-0a0b0c0d0e0f");
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("Cinema and Studio avoid secure-context-only randomUUID calls", async () => {
  const sources = await Promise.all([
    readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8")
  ]);
  for (const source of sources) {
    assert.match(source, /createBrowserUuid/);
    assert.doesNotMatch(source, /crypto\.randomUUID/);
  }
});
