import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClusterIngressRoutes } from "../server/cluster/index.mjs";

const listen = async (route) => {
  const server = createServer((request, response) => { void route(request, response, new URL(request.url, "http://localhost")); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
};

test("shard ingress accepts signed grant envelopes and range-streams only resolved sources", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-cluster-media-"));
  await writeFile(path.join(root, "fixture.mp4"), Buffer.from("0123456789"));
  let accepted = null;
  const grants = {
    accept(value) { accepted = value; return { expiresAt: "2026-07-19T12:10:00.000Z", grantId: "grant_fixture_01", mediaTicket: "ticket_fixture_01" }; },
    resolve({ grantId, method, ticket }) {
      if (grantId !== "grant_fixture_01" || method !== "GET" || ticket !== "ticket_fixture_01") throw Object.assign(new Error("Not found"), { status: 404, code: "delegated_media_not_found", expose: true });
      return { clientOrigin: "https://home.tail024251.ts.net", source: { path: "fixture.mp4" } };
    }
  };
  const route = createClusterIngressRoutes({ contentRoot: root, grants, service: {} });
  const server = await listen(route);
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });

  const grantResponse = await fetch(`${server.origin}/api/shard/v1/playback/grants/validate`, { body: JSON.stringify({ envelope: { opaque: true }, grant: { opaque: true } }), headers: { "content-type": "application/json" }, method: "POST" });
  assert.equal(grantResponse.status, 201);
  assert.deepEqual(accepted, { envelope: { opaque: true }, grant: { opaque: true } });

  const media = await fetch(`${server.origin}/api/shard/v1/media/grant_fixture_01/file?ticket=ticket_fixture_01`, { headers: { origin: "https://home.tail024251.ts.net", range: "bytes=2-5" } });
  assert.equal(media.status, 206);
  assert.equal(await media.text(), "2345");
  assert.equal(media.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(media.headers.get("access-control-allow-origin"), "https://home.tail024251.ts.net");
  assert.equal(media.headers.get("cache-control"), "private, no-store");

  const denied = await fetch(`${server.origin}/api/shard/v1/media/grant_fixture_01/file?ticket=wrong`);
  assert.equal(denied.status, 404);
  const arbitrary = await fetch(`${server.origin}/api/shard/v1/media/grant_fixture_01/../../files`);
  assert.equal(arbitrary.status, 404);
});
