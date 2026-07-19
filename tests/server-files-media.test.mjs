import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApiHandler } from "../server/api.mjs";
import { createStorage } from "../server/storage.mjs";

const startApi = async (options = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-test-"));
  const storage = await createStorage({ contentRoot: root });
  const handler = createApiHandler(storage, null, null, options);
  const server = createServer(async (request, response) => {
    if (!(await handler(request, response))) {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    root,
    storage,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { force: true, recursive: true });
    }
  };
};

const postJson = (url, body) => fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

test("Studio reconciles newly discovered audio before returning stable playback IDs", async (t) => {
  let reconciled = false;
  let scans = 0;
  const itemId = randomUUID();
  const sourceId = randomUUID();
  const repository = {
    listArtwork: () => [],
    listExternalIds: () => [],
    listItems: () => reconciled ? [{
      id: itemId,
      itemType: "track",
      mediaKind: "audio",
      metadata: {},
      sortTitle: "track",
      title: "track",
      source: {
        availability: "available",
        id: sourceId,
        itemId,
        modifiedMs: 1,
        path: "track.mp3",
        size: 5
      }
    }] : []
  };
  const api = await startApi({ catalog: { repository, scan: async () => { scans += 1; reconciled = true; } } });
  t.after(() => api.close());
  await writeFile(path.join(api.root, "track.mp3"), "audio");

  for (let request = 0; request < 2; request += 1) {
    const response = await fetch(`${api.baseUrl}/api/music/library`);
    assert.equal(response.status, 200);
    const entry = (await response.json()).entries[0];
    assert.equal(entry.id, itemId);
    assert.equal(entry.sourceId, sourceId);
  }
  assert.equal(scans, 1);
});

test("resumable uploads reject extra chunks and reserve destinations", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const created = await postJson(`${api.baseUrl}/api/files/uploads`, { name: "bounded.bin", path: "", size: 4, chunkSize: 2 });
  assert.equal(created.status, 201);
  const session = await created.json();

  const competing = await postJson(`${api.baseUrl}/api/files/uploads`, { name: "bounded.bin", path: "", size: 4, chunkSize: 2 });
  assert.equal(competing.status, 409);

  const extra = await fetch(`${api.baseUrl}/api/files/uploads/${session.id}/chunks/2`, { method: "PUT", body: Buffer.from("xx") });
  assert.equal(extra.status, 400);
  assert.deepEqual(await readdir(path.join(api.storage.uploadRoot, session.id, "chunks")), []);
});

test("competing completions never clobber a destination and clean temporary files", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const ids = [randomUUID(), randomUUID()];

  for (const [index, id] of ids.entries()) {
    const sessionPath = path.join(api.storage.uploadRoot, id);
    await mkdir(path.join(sessionPath, "chunks"), { recursive: true });
    await writeFile(path.join(sessionPath, "metadata.json"), JSON.stringify({
      chunkSize: 3, id, name: "race.bin", path: "", size: 3, target: "race.bin", reservation: `legacy-${id}`
    }));
    await writeFile(path.join(sessionPath, "chunks", "part-00000000"), index === 0 ? "one" : "two");
  }

  const results = await Promise.all(ids.map((id) => postJson(`${api.baseUrl}/api/files/uploads/${id}/complete`, {})));
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  assert.ok(["one", "two"].includes(await readFile(path.join(api.root, "race.bin"), "utf8")));
  assert.equal((await readdir(api.root)).some((name) => name.includes(".uploading-")), false);
});

test("Cinema and Studio implement single byte ranges consistently", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  await writeFile(path.join(api.root, "movie.mp4"), "0123456789");
  await writeFile(path.join(api.root, "track.mp3"), "abcdefghij");
  await writeFile(path.join(api.root, "empty.mp4"), "");

  for (const endpoint of ["cinema/media?path=movie.mp4", "music/media?path=track.mp3"]) {
    for (const [range, expectedRange, expectedBody] of [
      ["bytes=2-4", "bytes 2-4/10", 3],
      ["bytes=7-", "bytes 7-9/10", 3],
      ["bytes=-4", "bytes 6-9/10", 4]
    ]) {
      const response = await fetch(`${api.baseUrl}/api/${endpoint}`, { headers: { range } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-range"), expectedRange);
      assert.equal((await response.arrayBuffer()).byteLength, expectedBody);
    }

    for (const range of ["bytes=10-", "bytes=4-2", "bytes=0-1,3-4", "items=0-1", "bytes=-0"]) {
      const response = await fetch(`${api.baseUrl}/api/${endpoint}`, { headers: { range } });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get("content-range"), "bytes */10");
    }
  }

  const empty = await fetch(`${api.baseUrl}/api/cinema/media?path=empty.mp4`, { headers: { range: "bytes=0-" } });
  assert.equal(empty.status, 416);
  assert.equal(empty.headers.get("content-range"), "bytes */0");
  const wholeEmpty = await fetch(`${api.baseUrl}/api/cinema/media?path=empty.mp4`);
  assert.equal(wholeEmpty.status, 200);
  assert.equal((await wholeEmpty.arrayBuffer()).byteLength, 0);
});
