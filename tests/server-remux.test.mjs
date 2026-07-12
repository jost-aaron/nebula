import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRemuxArguments, createRemuxService, runFfmpegRemux } from "../server/remux/index.mjs";

const ids = { itemId: "10000000-0000-4000-8000-000000000001", sourceId: "20000000-0000-4000-8000-000000000001" };
const plan = (overrides = {}) => ({
  decision: "remux", ...ids,
  output: { audioCodec: "aac", container: "mp4", protocol: "file", videoCodec: "h264" },
  reasons: [], ...overrides
});
const workspace = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-remux-test-"));
  const contentRoot = path.join(root, "content"); const outputRoot = path.join(root, "remux");
  await mkdir(contentRoot); await mkdir(outputRoot); await writeFile(path.join(outputRoot, "stale.tmp"), "stale");
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  return { contentRoot, outputRoot };
};
const serviceFor = (roots, options = {}) => createRemuxService({
  ...roots, resolveSource: async (identity, context) => {
    assert.deepEqual(identity, ids); assert.equal(context?.userId, "user-a");
    return { id: ids.sourceId, itemId: ids.itemId, availability: "available", path: "source.mkv" };
  }, ...options
});

test("container provides FFmpeg and stream-copies incompatible MKV into MP4", async (t) => {
  assert.equal(spawnSync("ffmpeg", ["-version"], { shell: false }).status, 0);
  const roots = await workspace(t);
  const generated = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=1", "-f", "lavfi", "-i", "sine=frequency=1000", "-t", "1", "-c:v", "libx264", "-c:a", "aac", "-f", "matroska", path.join(roots.contentRoot, "source.mkv")], { shell: false });
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const service = serviceFor(roots);
  const session = await service.createSession(plan(), { userId: "user-a" });
  await session.completion;
  assert.equal(session.status, "ready");
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=format_name", "-of", "default=nw=1:nk=1", session.outputPath], { encoding: "utf8", shell: false });
  assert.equal(probe.status, 0, probe.stderr); assert.match(probe.stdout, /mp4/);
  await session.cleanup(); await assert.rejects(access(session.outputPath));
  await service.shutdown();
});

test("runner uses argument arrays, shell-safe delimiters, no overwrite, and bounded stderr", async (t) => {
  const roots = await workspace(t); const input = path.join(roots.contentRoot, "source.mkv"); const output = path.join(roots.outputRoot, "out.mp4");
  await writeFile(input, "bad"); await writeFile(output, "existing");
  assert.deepEqual(buildRemuxArguments(input, output), ["-nostdin", "-v", "error", "-n", "-i", input, "-map", "0:v?", "-map", "0:a?", "-c", "copy", "-sn", "--", output]);
  await assert.rejects(runFfmpegRemux(input, output, { maxStderrBytes: 32 }), (error) => error.code === "ffmpeg_failed" && Buffer.byteLength(error.stderr) <= 32);
  assert.equal(await readFile(output, "utf8"), "existing");
});

test("malformed plans and missing or unsafe catalog sources fail closed", async (t) => {
  const roots = await workspace(t); await writeFile(path.join(roots.contentRoot, "source.mkv"), "media");
  const service = serviceFor(roots);
  await assert.rejects(service.createSession({ decision: "direct-play" }, { userId: "user-a" }), { code: "invalid_plan" });
  await assert.rejects(service.createSession(plan({ output: { container: "webm", protocol: "file" } }), { userId: "user-a" }), { code: "unsupported_output" });
  const missing = createRemuxService({ ...roots, resolveSource: async () => null });
  await assert.rejects(missing.createSession(plan(), {}), { code: "missing_source" });
  const unsafe = createRemuxService({ ...roots, resolveSource: async () => ({ ...ids, id: ids.sourceId, itemId: ids.itemId, availability: "available", path: "../escape.mkv" }) });
  await assert.rejects(unsafe.createSession(plan(), {}), { code: "unsafe_path" });
  await Promise.all([service.shutdown(), missing.shutdown(), unsafe.shutdown()]);
});

test("FFmpeg unavailable, timeout, and cancellation remove partial output", async (t) => {
  const roots = await workspace(t); await writeFile(path.join(roots.contentRoot, "source.mkv"), "media");
  const unavailable = serviceFor(roots, { runnerOptions: { binary: "/not/a/real/ffmpeg" } });
  const failed = await unavailable.createSession(plan(), { userId: "user-a" });
  await assert.rejects(failed.completion, { code: "ffmpeg_unavailable" }); assert.equal(failed.status, "failed");
  await assert.rejects(access(path.join(roots.outputRoot, failed.id)));
  await unavailable.shutdown();

  for (const mode of ["timeout", "cancelled"]) {
    const service = serviceFor(roots, { runner: (_input, output, { signal }) => new Promise((resolve, reject) => {
      writeFile(output, "partial");
      const timer = mode === "timeout" ? setTimeout(() => reject(Object.assign(new Error("late"), { code: "timeout" })), 15) : null;
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("cancelled"), { code: "cancelled" })); }, { once: true });
    }) });
    const session = await service.createSession(plan(), { userId: "user-a" });
    if (mode === "cancelled") session.cancel();
    await assert.rejects(session.completion, { code: mode });
    assert.equal(session.status, mode === "cancelled" ? "cancelled" : "failed");
    await assert.rejects(access(path.join(roots.outputRoot, session.id)));
    await service.shutdown();
  }
});

test("service bounds concurrency and startup/shutdown clean stale and active sessions", async (t) => {
  const roots = await workspace(t); await writeFile(path.join(roots.contentRoot, "source.mkv"), "media");
  let active = 0; let maximum = 0; const releases = [];
  const service = serviceFor(roots, { concurrency: 2, uuid: (() => { let id = 0; return () => `session-${++id}`; })(), runner: (_input, output, { signal }) => new Promise((resolve, reject) => {
    active += 1; maximum = Math.max(maximum, active); writeFile(output, "partial");
    releases.push(() => { active -= 1; resolve(); });
    signal.addEventListener("abort", () => { active -= 1; reject(Object.assign(new Error("cancelled"), { code: "cancelled" })); }, { once: true });
  }) });
  await service.initialize(); await assert.rejects(access(path.join(roots.outputRoot, "stale.tmp")));
  const sessions = await Promise.all([1, 2, 3].map(() => service.createSession(plan(), { userId: "user-a" })));
  await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(maximum, 2);
  assert.equal(sessions.filter(({ status }) => status === "queued").length, 1);
  releases.shift()(); await Promise.race(sessions.map((session) => session.completion));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sessions.filter(({ status }) => status === "running").length, 2);
  await service.shutdown(); assert.equal(service.getSession(sessions[0].id), null); await assert.rejects(access(roots.outputRoot));
});
