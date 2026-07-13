import assert from "node:assert/strict";
import test from "node:test";
import { createRenditionRoutes } from "../server/renditions/routes.mjs";

const responseCapture = () => {
  let body = ""; let status = 0;
  return {
    end(value = "") { body += value; },
    json: () => JSON.parse(body),
    status: () => status,
    writeHead(value) { status = value; }
  };
};

test("rendition profile route exposes only fixed server-owned profiles", async () => {
  const route = createRenditionRoutes(); const response = responseCapture();
  assert.equal(await route({ method: "GET" }, response, new URL("http://nebula/api/renditions/profiles")), true);
  assert.equal(response.status(), 200);
  assert.deepEqual(response.json().profiles.map(({ id, maxHeight, totalBitrate }) => ({ id, maxHeight, totalBitrate })), [
    { id: "480p", maxHeight: 480, totalBitrate: 2_000_000 },
    { id: "720p", maxHeight: 720, totalBitrate: 4_000_000 },
    { id: "1080p", maxHeight: 1080, totalBitrate: 8_000_000 }
  ]);
  assert.equal(await route({ method: "POST" }, responseCapture(), new URL("http://nebula/api/renditions/profiles")), false);
});
