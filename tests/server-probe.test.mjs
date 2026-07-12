import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  FFPROBE_ARGUMENTS,
  PROBE_SCHEMA_SQL,
  createProbeCatalogReader,
  createProbeCatalogWriter,
  createProbeService,
  normalizeFfprobe,
  probeMigration,
  probeMigrations,
  probeRevisionMigration,
  resolveProbePath,
  runFfprobe
} from "../server/probe/index.mjs";

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/probe/${name}`, import.meta.url), "utf8"));

test("container provides ffprobe", () => {
  const result = spawnSync("ffprobe", ["-version"], { encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ffprobe version/);
});

test("normalizes format, HDR video, audio, subtitles, and chapters", async () => {
  const result = normalizeFfprobe(await fixture("video-hdr.json"));
  assert.deepEqual(result.format, {
    name: "matroska,webm", longName: "Matroska / WebM", durationSeconds: 120.5,
    bitrate: 331950, sizeBytes: 5000000
  });
  assert.equal(result.video[0].frameRate, 24000 / 1001);
  assert.equal(result.video[0].bitDepth, 10);
  assert.deepEqual(result.video[0].hdr, { format: "hdr10", colorPrimaries: "bt2020", colorSpace: "bt2020nc", colorTransfer: "smpte2084" });
  assert.deepEqual(result.audio[0], {
    index: 1, codec: "eac3", codecLongName: "E-AC-3", title: "Main Audio", language: "eng",
    channels: 6, channelLayout: "5.1(side)", sampleRate: 48000, bitrate: 768000, default: true
  });
  assert.equal(result.subtitles[0].forced, true);
  assert.equal(result.subtitles[0].language, "spa");
  assert.deepEqual(result.chapters[1], { id: 1, startSeconds: 60.25, endSeconds: 120.5, title: "Finale" });
});

test("normalizes audio-only and sparse probe output", async () => {
  const audio = normalizeFfprobe(await fixture("audio.json"));
  assert.equal(audio.video.length, 0);
  assert.equal(audio.audio[0].channels, 2);
  assert.deepEqual(normalizeFfprobe({}), {
    format: { name: null, longName: null, durationSeconds: null, bitrate: null, sizeBytes: null },
    video: [], audio: [], subtitles: [], chapters: []
  });
});

test("path resolution rejects traversal, absolute paths, missing files, and symlink escapes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-probe-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "nebula-probe-outside-"));
  await writeFile(path.join(root, "safe.mp4"), "media");
  await writeFile(path.join(outside, "secret.mp4"), "secret");
  await symlink(path.join(outside, "secret.mp4"), path.join(root, "escape.mp4"));
  assert.equal(await resolveProbePath(root, "safe.mp4"), path.join(root, "safe.mp4"));
  await assert.rejects(resolveProbePath(root, "../secret.mp4"), { code: "unsafe_path" });
  await assert.rejects(resolveProbePath(root, path.join(root, "safe.mp4")), { code: "unsafe_path" });
  await assert.rejects(resolveProbePath(root, "missing.mp4"), { code: "missing" });
  await assert.rejects(resolveProbePath(root, "escape.mp4"), { code: "unsafe_path" });
  t.after(async () => Promise.all([
    import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })),
    import("node:fs/promises").then(({ rm }) => rm(outside, { recursive: true, force: true }))
  ]));
});

test("service bounds concurrency and persists through only the injected writer", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-probe-service-"));
  const writes = [];
  let active = 0;
  let maximum = 0;
  for (const name of ["one.mp4", "two.mp4", "three.mp4"]) await writeFile(path.join(root, name), "media");
  const service = createProbeService({
    catalogWriter: { putProbeResult: async (...args) => writes.push(args) }, concurrency: 2, contentRoot: root,
    resolveSource: async (id) => ({ id, path: id, availability: "available", contentRevision: 1 }),
    runner: async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return await fixture("audio.json");
    }
  });
  await Promise.all(["one.mp4", "two.mp4", "three.mp4"].map((id) => service.probeSource(id)));
  assert.equal(maximum, 2);
  assert.deepEqual(writes.map(([id]) => id).sort(), ["one.mp4", "three.mp4", "two.mp4"]);
  assert.ok(writes.every(([, , options]) => options.expectedContentRevision === 1));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
});

test("service captures the source revision before FFprobe starts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-probe-revision-"));
  await writeFile(path.join(root, "movie.mp4"), "media");
  let currentRevision = 4;
  let writeOptions = null;
  const service = createProbeService({
    catalogWriter: { putProbeResult: async (_sourceId, _result, options) => { writeOptions = options; } },
    contentRoot: root,
    resolveSource: async () => ({ availability: "available", contentRevision: currentRevision, path: "movie.mp4" }),
    runner: async () => {
      currentRevision = 5;
      return await fixture("audio.json");
    }
  });

  await service.probeSource("source-1");
  assert.deepEqual(writeOptions, { expectedContentRevision: 4 });
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
});

test("runner uses fixed arguments and classifies corrupt and bounded failures", async () => {
  assert.deepEqual(FFPROBE_ARGUMENTS, ["-v", "error", "-show_format", "-show_streams", "-show_chapters", "-print_format", "json"]);
  await assert.rejects(runFfprobe(new URL("./fixtures/probe/corrupt.mp4", import.meta.url).pathname), { code: "partial_or_corrupt" });
  await assert.rejects(runFfprobe("ignored", { binary: "/not/a/real/ffprobe" }), { code: "ffprobe_unavailable" });
  await assert.rejects(runFfprobe(new URL("./fixtures/probe/corrupt.mp4", import.meta.url).pathname, { maxOutputBytes: 1 }), { code: "output_limit" });
});

test("probe-v2 migration preserves legacy rows with unknown revisions idempotently", (t) => {
  assert.doesNotMatch(PROBE_SCHEMA_SQL, /PRAGMA|user_version/i);
  assert.equal(probeMigration.id, "probe-v1");
  assert.equal(probeRevisionMigration.id, "probe-v2");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON; PRAGMA user_version = 73; CREATE TABLE media_sources (id TEXT PRIMARY KEY, content_revision INTEGER NOT NULL);");
  db.prepare("INSERT INTO media_sources (id, content_revision) VALUES (?, ?)").run("source-1", 7);
  probeMigration.apply(db);
  db.prepare("INSERT INTO media_probe_results (source_id, probed_at) VALUES (?, ?)").run("source-1", "2026-07-10T00:00:00.000Z");
  probeRevisionMigration.apply(db);
  probeRevisionMigration.apply(db);

  const legacy = createProbeCatalogReader(db).get("source-1");
  assert.equal(legacy.probeState, "ready");
  assert.equal(legacy.sourceContentRevision, null);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 73);
  t.after(() => db.close());
});

test("adapter writes current revisions and atomically rejects stale probe results", async (t) => {
  assert.deepEqual(probeMigrations.map(({ id }) => id), ["probe-v1", "probe-v2"]);
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE media_sources (id TEXT PRIMARY KEY, content_revision INTEGER NOT NULL);");
  db.prepare("INSERT INTO media_sources (id, content_revision) VALUES (?, ?)").run("source-1", 1);
  for (const migration of probeMigrations) migration.apply(db);
  for (const migration of probeMigrations) migration.apply(db);
  const writer = createProbeCatalogWriter(db, { now: () => "2026-07-11T00:00:00.000Z", uuid: (() => { let id = 0; return () => `id-${++id}`; })() });
  const first = normalizeFfprobe(await fixture("video-hdr.json"));
  writer.putProbeResult("source-1", first);
  assert.equal(db.prepare("SELECT source_content_revision FROM media_probe_results").get().source_content_revision, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM media_streams").get().count, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM media_chapters").get().count, 2);
  db.prepare("UPDATE media_sources SET content_revision = 2 WHERE id = ?").run("source-1");
  writer.putProbeResult("source-1", normalizeFfprobe(await fixture("audio.json")), { expectedContentRevision: 2 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM media_streams").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM media_chapters").get().count, 0);
  assert.deepEqual({ ...db.prepare("SELECT format_name, source_content_revision FROM media_probe_results").get() }, { format_name: "flac", source_content_revision: 2 });
  assert.equal(createProbeCatalogReader(db).get("source-1").sourceContentRevision, 2);
  assert.throws(
    () => writer.putProbeResult("source-1", first, { expectedContentRevision: 1 }),
    { code: "stale_source_revision", retryable: true }
  );
  assert.deepEqual({ ...db.prepare("SELECT format_name, source_content_revision FROM media_probe_results").get() }, { format_name: "flac", source_content_revision: 2 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM media_streams").get().count, 1);
  assert.throws(() => writer.putProbeResult("missing-source", first), /Unknown catalog source/);
  t.after(() => db.close());
});
