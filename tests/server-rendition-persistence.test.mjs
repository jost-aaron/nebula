import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRenditionStore, migrateRenditionsSchema } from "../server/renditions/index.mjs";
import { createTranscodeService } from "../server/transcode/index.mjs";

const ids = { itemId: "item-1", sourceId: "source-1" };
const profilePlan = () => ({
  decision: "transcode", ...ids,
  output: {
    audioCodec: "aac", bitrate: 2_000_000, container: "mpegts", height: 480,
    profileId: "480p", protocol: "hls", videoCodec: "h264", width: 854
  },
  reasons: []
});

const scopeFor = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-rendition-persistence-"));
  const contentRoot = path.join(root, "content");
  const dataRoot = path.join(root, "data");
  const outputRoot = path.join(dataRoot, "delivery-cache", "transcode");
  await mkdir(contentRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(contentRoot, "movie.mp4"), "source");
  const database = new DatabaseSync(path.join(root, "test.sqlite"));
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE media_sources (id TEXT PRIMARY KEY, content_revision INTEGER NOT NULL);");
  database.prepare("INSERT INTO media_sources (id, content_revision) VALUES (?, ?)").run(ids.sourceId, 1);
  migrateRenditionsSchema(database);
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  return { contentRoot, dataRoot, database, outputRoot, root };
};

const writeCompleteHls = async (directory, marker = "segment") => {
  await writeFile(path.join(directory, "master.m3u8"), "#EXTM3U\nmedia.m3u8\n");
  await writeFile(path.join(directory, "segment-00000.ts"), marker);
  await writeFile(path.join(directory, "media.m3u8"), "#EXTM3U\n#EXTINF:4,\nsegment-00000.ts\n#EXT-X-ENDLIST\n");
  return { masterPlaylist: path.join(directory, "master.m3u8"), mediaPlaylist: path.join(directory, "media.m3u8") };
};

const serviceFor = (scope, { revision = 1, runner, shouldPersistRendition, uuid } = {}) => {
  const store = createRenditionStore({ database: scope.database, dataRoot: scope.dataRoot });
  const service = createTranscodeService({
    contentRoot: scope.contentRoot,
    outputRoot: scope.outputRoot,
    renditionStore: store,
    resolveSource: async () => ({ ...ids, availability: "available", contentRevision: revision, id: ids.sourceId, path: "movie.mp4" }),
    runner,
    shouldPersistRendition,
    uuid
  });
  return { service, store };
};

test("interactive profile output remains disposable when caching is disabled", async (t) => {
  const scope = await scopeFor(t);
  const worker = serviceFor(scope, {
    runner: async (_input, directory) => writeCompleteHls(directory, "disposable"),
    shouldPersistRendition: () => false,
    uuid: () => "disposable-session"
  });
  const session = await worker.service.createSession(profilePlan(), { userId: "alice" });
  await session.completion;
  const asset = await session.resolveAsset("segment-00000.ts");
  assert.equal(asset.includes(`${path.sep}delivery-cache${path.sep}`), true);
  assert.equal(scope.database.prepare("SELECT COUNT(*) AS count FROM media_renditions").get().count, 0);
  await session.cleanup();
  assert.equal(await access(asset).then(() => true, () => false), false);
  await worker.service.shutdown();
});

test("completed profile renditions survive delivery cleanup and transcode service restart", async (t) => {
  const scope = await scopeFor(t);
  let runs = 0;
  const runner = async (_input, directory) => { runs += 1; return writeCompleteHls(directory, `run-${runs}`); };
  const first = serviceFor(scope, { runner, uuid: () => "session-one" });
  const built = await first.service.createSession(profilePlan(), { userId: "alice" });
  await built.completion;
  const persistedMaster = await built.resolveAsset("master.m3u8");
  assert.equal(persistedMaster.includes(`${path.sep}renditions${path.sep}`), true);
  await built.cleanup();
  assert.equal(await access(persistedMaster).then(() => true, () => false), true);
  await first.service.shutdown();

  const restarted = serviceFor(scope, { runner, uuid: () => "session-two" });
  const reused = await restarted.service.createSession(profilePlan(), { userId: "bob" });
  assert.equal(reused.reused, true);
  assert.equal(runs, 1);
  assert.equal(await readFile(await reused.resolveAsset("segment-00000.ts"), "utf8"), "run-1");
  await reused.cleanup();
  await restarted.service.shutdown();
});

test("source revision changes never reuse an older rendition", async (t) => {
  const scope = await scopeFor(t);
  let runs = 0;
  const runner = async (_input, directory) => { runs += 1; return writeCompleteHls(directory, `revision-run-${runs}`); };
  const first = serviceFor(scope, { revision: 1, runner, uuid: () => "revision-one" });
  const old = await first.service.createSession(profilePlan(), { userId: "alice" }); await old.completion; await old.cleanup(); await first.service.shutdown();
  scope.database.prepare("UPDATE media_sources SET content_revision = 2 WHERE id = ?").run(ids.sourceId);
  const second = serviceFor(scope, { revision: 2, runner, uuid: () => "revision-two" });
  const current = await second.service.createSession(profilePlan(), { userId: "alice" }); await current.completion;
  assert.equal(current.reused, false);
  assert.equal(runs, 2);
  assert.equal(scope.database.prepare("SELECT COUNT(*) AS count FROM media_renditions").get().count, 2);
  await current.cleanup(); await second.service.shutdown();
});

test("missing or corrupt ready assets fail closed and rebuild", async (t) => {
  const scope = await scopeFor(t);
  let runs = 0;
  const runner = async (_input, directory) => { runs += 1; return writeCompleteHls(directory, `verified-${runs}`); };
  const first = serviceFor(scope, { runner, uuid: () => "corrupt-one" });
  const built = await first.service.createSession(profilePlan(), { userId: "alice" }); await built.completion;
  await writeFile(await built.resolveAsset("segment-00000.ts"), "tampered");
  await built.cleanup(); await first.service.shutdown();

  const second = serviceFor(scope, { runner, uuid: () => "corrupt-two" });
  const rebuilt = await second.service.createSession(profilePlan(), { userId: "alice" }); await rebuilt.completion;
  assert.equal(rebuilt.reused, false);
  assert.equal(runs, 2);
  assert.equal(await readFile(await rebuilt.resolveAsset("segment-00000.ts"), "utf8"), "verified-2");
  const row = scope.database.prepare("SELECT state, error_code FROM media_renditions WHERE source_id = ? AND source_revision = 1").get(ids.sourceId);
  assert.deepEqual({ ...row }, { error_code: null, state: "ready" });
  await rebuilt.cleanup(); await second.service.shutdown();
});

test("fresh persistent builds remain progressively playable before atomic publication", async (t) => {
  const scope = await scopeFor(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = serviceFor(scope, {
    uuid: () => "progressive",
    runner: async (_input, directory, { onReady }) => {
      await writeFile(path.join(directory, "master.m3u8"), "#EXTM3U\nmedia.m3u8\n");
      await writeFile(path.join(directory, "segment-00000.ts"), "progressive");
      await writeFile(path.join(directory, "media.m3u8"), "#EXTM3U\nsegment-00000.ts\n");
      onReady();
      await gate;
      await writeFile(path.join(directory, "media.m3u8"), "#EXTM3U\nsegment-00000.ts\n#EXT-X-ENDLIST\n");
      return { masterPlaylist: path.join(directory, "master.m3u8") };
    }
  });
  const session = await worker.service.createSession(profilePlan(), { userId: "alice" });
  while (session.status !== "ready") await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await session.resolveAsset("segment-00000.ts")).includes(`${path.sep}delivery-cache${path.sep}`), true);
  assert.equal(scope.database.prepare("SELECT state FROM media_renditions").get().state, "building");
  release(); await session.completion;
  assert.equal((await session.resolveAsset("segment-00000.ts")).includes(`${path.sep}renditions${path.sep}`), true);
  assert.equal(scope.database.prepare("SELECT state FROM media_renditions").get().state, "ready");
  await session.cleanup(); await worker.service.shutdown();
});

test("concurrent requests serialize one profile build and reuse its verified result", async (t) => {
  const scope = await scopeFor(t);
  let release; let runs = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = serviceFor(scope, {
    runner: async (_input, directory) => { runs += 1; await gate; return writeCompleteHls(directory, "shared"); },
    uuid: (() => { let value = 0; return () => `concurrent-${++value}`; })()
  });
  const first = await worker.service.createSession(profilePlan(), { userId: "alice" });
  const second = await worker.service.createSession(profilePlan(), { userId: "bob" });
  release();
  await Promise.all([first.completion, second.completion]);
  assert.equal(runs, 1);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(await readFile(await second.resolveAsset("segment-00000.ts"), "utf8"), "shared");
  await Promise.all([first.cleanup(), second.cleanup()]); await worker.service.shutdown();
});

test("rendition lookup never bypasses current source authorization", async (t) => {
  const scope = await scopeFor(t);
  const allowed = serviceFor(scope, { runner: async (_input, directory) => writeCompleteHls(directory), uuid: () => "allowed" });
  const built = await allowed.service.createSession(profilePlan(), { userId: "alice" }); await built.completion; await built.cleanup(); await allowed.service.shutdown();
  const store = createRenditionStore({ database: scope.database, dataRoot: scope.dataRoot });
  const denied = createTranscodeService({
    contentRoot: scope.contentRoot, outputRoot: scope.outputRoot, renditionStore: store,
    resolveSource: async () => null, runner: async () => { throw new Error("must not run"); }
  });
  await assert.rejects(denied.createSession(profilePlan(), { userId: "mallory" }), { code: "missing_source" });
  await denied.shutdown();
});

test("unsafe persisted storage keys never escape the data rendition root", async (t) => {
  const scope = await scopeFor(t);
  const outside = path.join(scope.root, "outside");
  await mkdir(outside); await writeCompleteHls(outside, "outside-safe");
  const worker = serviceFor(scope, { runner: async (_input, directory) => writeCompleteHls(directory), uuid: () => "safe-key" });
  const session = await worker.service.createSession(profilePlan(), { userId: "alice" }); await session.completion; await session.cleanup(); await worker.service.shutdown();
  scope.database.prepare("UPDATE media_renditions SET storage_key = ?").run(outside);
  const restarted = serviceFor(scope, { runner: async (_input, directory) => writeCompleteHls(directory, "rebuilt"), uuid: () => "safe-key-two" });
  const rebuilt = await restarted.service.createSession(profilePlan(), { userId: "alice" }); await rebuilt.completion;
  assert.equal(rebuilt.reused, false);
  assert.equal(await readFile(path.join(outside, "segment-00000.ts"), "utf8"), "outside-safe");
  await rebuilt.cleanup(); await restarted.service.shutdown();
});
