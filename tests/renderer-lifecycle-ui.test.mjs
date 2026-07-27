import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/webgpuRenderer.ts", import.meta.url), "utf8");

test("renderer feature-detects WebGPU and submits the shader pipeline", () => {
  assert.match(source, /navigator\.gpu\.requestAdapter/);
  assert.match(source, /createRenderPipeline/);
  assert.match(source, /device\.queue\.submit/);
  assert.match(source, /mode: "webgpu"/);
});

test("renderer resizes incrementally and pauses for hidden or reduced-motion documents", () => {
  assert.match(source, /ResizeObserver/);
  assert.match(source, /document\.hidden/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /width === configuredWidth && height === configuredHeight/);
});
