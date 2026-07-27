import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApiHandler } from "../server/api.mjs";
import { createFilesRoutes } from "../server/files.mjs";
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

test("Files rejects symlink traversal on reads, writes, renames, and deletes", async (t) => {
  const api = await startApi();
  const outside = await mkdtemp(path.join(os.tmpdir(), "nebula-outside-"));
  t.after(async () => {
    await api.close();
    await rm(outside, { force: true, recursive: true });
  });
  await writeFile(path.join(outside, "secret.txt"), "outside");
  await symlink(outside, path.join(api.root, "escape"), "dir");

  const listing = await fetch(`${api.baseUrl}/api/files`).then((response) => response.json());
  assert.equal(listing.entries.some((entry) => entry.name === "escape"), false);

  for (const endpoint of [
    "/api/files/read?path=escape%2Fsecret.txt",
    "/api/files/download?path=escape%2Fsecret.txt"
  ]) {
    const response = await fetch(`${api.baseUrl}${endpoint}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "unsafe_content_path");
  }

  const create = await postJson(`${api.baseUrl}/api/files/text`, {
    content: "blocked",
    name: "created.txt",
    path: "escape"
  });
  assert.equal(create.status, 400);
  assert.equal((await create.json()).code, "unsafe_content_path");

  const renameResponse = await postJson(`${api.baseUrl}/api/files/rename`, {
    name: "renamed",
    path: "escape"
  });
  assert.equal(renameResponse.status, 400);
  assert.equal((await renameResponse.json()).code, "unsafe_content_path");

  const deleteResponse = await fetch(`${api.baseUrl}/api/files?path=escape`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 400);
  assert.equal((await deleteResponse.json()).code, "unsafe_content_path");
  assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "outside");
});

test("Files previews active content inertly and paginates deterministic bounded listings", async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  await writeFile(path.join(api.root, "active.html"), "<script>globalThis.pwned=true</script>");
  await mkdir(path.join(api.root, "folder"));
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    await writeFile(path.join(api.root, name), name);
  }

  const preview = await fetch(`${api.baseUrl}/api/files/read?path=active.html`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.match(preview.headers.get("content-security-policy"), /default-src 'none'/);

  const first = await fetch(`${api.baseUrl}/api/files?limit=2`).then((response) => response.json());
  assert.deepEqual(first.entries.map((entry) => entry.name), ["folder", "a.txt"]);
  assert.equal(first.nextCursor, "2");
  assert.equal(first.total, 5);
  const second = await fetch(`${api.baseUrl}/api/files?limit=2&cursor=${first.nextCursor}`)
    .then((response) => response.json());
  assert.deepEqual(second.entries.map((entry) => entry.name), ["active.html", "b.txt"]);
  assert.equal(second.nextCursor, "4");
});

test("Files enforces upload admission, cleans stale sessions, and returns stable errors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-files-limits-"));
  const storage = await createStorage({ contentRoot: root });
  const routes = createFilesRoutes(storage, {
    maxUploadBytes: 3,
    minimumFreeBytes: 0,
    uploadTtlMs: 60_000
  });
  const staleId = randomUUID();
  const staleReservation = "a".repeat(64);
  const stalePath = path.join(storage.uploadRoot, staleId);
  await mkdir(path.join(stalePath, "chunks"), { recursive: true });
  await mkdir(path.join(storage.uploadReservationRoot, staleReservation));
  await writeFile(path.join(stalePath, "metadata.json"), JSON.stringify({
    chunkSize: 1,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    id: staleId,
    name: "stale.bin",
    reservation: staleReservation,
    size: 1,
    target: "stale.bin",
    updatedAt: new Date(Date.now() - 120_000).toISOString()
  }));
  const server = createServer(async (request, response) => {
    try {
      if (!(await routes(request, response, new URL(request.url, "http://files.test")))) {
        response.writeHead(404).end();
      }
    } catch (error) {
      response.writeHead(error.status ?? 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: error.code, error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { force: true, recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const admitted = await postJson(`${base}/api/files/uploads`, {
    chunkSize: 1,
    name: "small.bin",
    path: "",
    size: 1
  });
  assert.equal(admitted.status, 201);
  assert.equal(await readFile(path.join(stalePath, "metadata.json")).catch(() => null), null);
  assert.equal((await readdir(storage.uploadReservationRoot)).includes(staleReservation), false);

  const stream = await fetch(`${base}/api/files/upload?path=&name=large.bin`, {
    body: "four",
    method: "PUT"
  });
  assert.equal(stream.status, 413);
  assert.equal((await stream.json()).code, "upload_too_large");
  assert.equal(await readFile(path.join(root, "large.bin")).catch(() => null), null);

  const session = await postJson(`${base}/api/files/uploads`, {
    chunkSize: 4,
    name: "large.bin",
    path: "",
    size: 4
  });
  assert.equal(session.status, 413);
  assert.equal((await session.json()).code, "upload_too_large");

  const traversal = await fetch(`${base}/api/files/read?path=..%2Foutside`);
  assert.equal(traversal.status, 400);
  assert.equal((await traversal.json()).code, "invalid_content_path");
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
