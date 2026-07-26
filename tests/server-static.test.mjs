import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStaticHandler } from "../server/static.mjs";

const fixture = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-static-"));
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "index.html"), "<!doctype html><title>Nebula</title>");
  await writeFile(path.join(root, "assets", "app-abc123.js"), "export const ready = true;");
  const handler = createStaticHandler({ root });
  const server = createServer((request, response) => void handler(request, response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
};

test("production static handler serves immutable assets and SPA fallback without traversal", async (t) => {
  const origin = await fixture(t);
  const asset = await fetch(`${origin}/assets/app-abc123.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control"), /immutable/);
  assert.match(asset.headers.get("content-type"), /text\/javascript/);

  const route = await fetch(`${origin}/studio/albums`);
  assert.equal(route.status, 200);
  assert.match(route.headers.get("cache-control"), /no-cache/);
  assert.match(await route.text(), /Nebula/);

  const traversal = await fetch(`${origin}/%2e%2e%2fpackage.json`);
  assert.equal(traversal.status, 400);
});
