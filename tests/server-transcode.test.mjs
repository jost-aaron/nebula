import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildTranscodeArguments, createTranscodeService, runFfmpegTranscode } from "../server/transcode/index.mjs";
import { getRenditionProfile } from "../server/renditions/index.mjs";

const ids = { itemId: "10000000-0000-4000-8000-000000000001", sourceId: "20000000-0000-4000-8000-000000000001" };
const plan = (overrides = {}) => ({
  decision: "transcode", ...ids,
  output: { audioCodec: "aac", container: "mpegts", protocol: "hls", videoCodec: "h264" },
  reasons: [{ code: "VIDEO_CODEC_UNSUPPORTED", message: "fixture", streamIndex: 0 }], ...overrides
});
const workspace = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-transcode-test-"));
  const contentRoot = path.join(root, "content"); const outputRoot = path.join(root, "transcode");
  await mkdir(contentRoot); await mkdir(outputRoot); await writeFile(path.join(outputRoot, "stale.tmp"), "stale");
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  return { root, contentRoot, outputRoot };
};
const serviceFor = (roots, options = {}) => createTranscodeService({
  ...roots, resolveSource: async (identity, context) => {
    assert.deepEqual(identity, ids); assert.equal(context?.userId, "user-a");
    return { id: ids.sourceId, itemId: ids.itemId, availability: "available", path: "incompatible.avi" };
  }, ...options
});

test("Docker FFmpeg transcodes an actual incompatible-codec fixture to isolated H.264/AAC MPEG-TS HLS", async (t) => {
  assert.equal(spawnSync("ffmpeg", ["-version"], { shell: false }).status, 0);
  const roots = await workspace(t); const input = path.join(roots.contentRoot, "incompatible.avi");
  const fixture = JSON.parse(await readFile(path.resolve("tests/fixtures/transcode/incompatible-codec.json"), "utf8"));
  const generated = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=96x64:rate=12", "-f", "lavfi", "-i", "sine=frequency=880", "-t", String(fixture.durationSeconds), "-c:v", fixture.videoCodec, "-c:a", fixture.audioCodec, "-f", fixture.container, input], { shell: false });
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const sourceProbe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", input], { encoding: "utf8", shell: false });
  assert.match(sourceProbe.stdout, /mpeg4/); assert.match(sourceProbe.stdout, /mp2/);
  const service = serviceFor(roots); const session = await service.createSession(plan(), { userId: "user-a" });
  await session.completion; assert.equal(session.status, "ready");
  const master = await session.resolveAsset("master.m3u8"); const media = await session.resolveAsset("media.m3u8");
  assert.match(await readFile(master, "utf8"), /media\.m3u8/);
  const mediaText = await readFile(media, "utf8"); assert.match(mediaText, /#EXT-X-ENDLIST/);
  const segmentName = mediaText.match(/segment-\d{5}\.ts/)?.[0]; assert.ok(segmentName);
  const segment = await session.resolveAsset(segmentName);
  const outputProbe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", segment], { encoding: "utf8", shell: false });
  assert.match(outputProbe.stdout, /h264/); assert.match(outputProbe.stdout, /aac/);
  await session.cleanup(); await assert.rejects(access(master)); await service.shutdown();
});

test("Docker FFmpeg produces bounded 240p and 360p HLS renditions", async (t) => {
  const roots = await workspace(t);
  const input = path.join(roots.contentRoot, "widescreen.mp4");
  const generated = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=960x540:rate=12", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", input], { shell: false });
  assert.equal(generated.status, 0, generated.stderr?.toString());

  for (const [profileId, limits, expected] of [
    ["240p", { height: 238, width: 426 }, { height: 238, width: 424 }],
    ["360p", { height: 360, width: 640 }, { height: 360, width: 640 }]
  ]) {
    const profile = getRenditionProfile(profileId);
    assert.ok(profile);
    const output = path.join(roots.outputRoot, profileId);
    await mkdir(output);
    await runFfmpegTranscode(input, output, {
      maxHeight: limits.height,
      maxWidth: limits.width,
      outputCheckMs: 10,
      renditionProfile: profile,
      segmentDuration: 1
    });
    const playlist = await readFile(path.join(output, "media.m3u8"), "utf8");
    const segment = path.join(output, playlist.match(/segment-\d{5}\.ts/)?.[0] ?? "");
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", segment], { encoding: "utf8", shell: false });
    assert.equal(probe.status, 0, probe.stderr);
    const stream = JSON.parse(probe.stdout).streams[0];
    assert.deepEqual({ codec: stream.codec_name, height: stream.height, width: stream.width }, { codec: "h264", ...expected });
    assert.match(await readFile(path.join(output, "master.m3u8"), "utf8"), new RegExp(`BANDWIDTH=${profile.totalBitrate}`));
  }
});

test("plans and catalog sources fail closed before FFmpeg", async (t) => {
  const roots = await workspace(t); await writeFile(path.join(roots.contentRoot, "incompatible.avi"), "media");
  const service = serviceFor(roots);
  await assert.rejects(service.createSession(null, {}), { code: "invalid_plan" });
  await assert.rejects(service.createSession(plan({ decision: "remux" }), {}), { code: "invalid_plan" });
  await assert.rejects(service.createSession(plan({ output: { protocol: "hls", container: "fmp4", videoCodec: "h264", audioCodec: "aac" } }), {}), { code: "unsupported_output" });
  await assert.rejects(service.createSession(plan({ output: { protocol: "hls", container: "mpegts", videoCodec: "h264", audioCodec: "aac", bitrate: 3_000_000, height: 720, profileId: "720p", width: 1280 } }), {}), { code: "unsupported_output" });
  for (const source of [null, { id: ids.sourceId, itemId: ids.itemId, availability: "missing", path: "incompatible.avi" }, { id: "wrong", itemId: ids.itemId, availability: "available", path: "incompatible.avi" }]) {
    const candidate = createTranscodeService({ ...roots, resolveSource: async () => source });
    await assert.rejects(candidate.createSession(plan(), {}), { code: "missing_source" }); await candidate.shutdown();
  }
  const missing = createTranscodeService({ ...roots, resolveSource: async () => ({ id: ids.sourceId, itemId: ids.itemId, availability: "available", path: "missing.avi" }) });
  await assert.rejects(missing.createSession(plan(), {}), { code: "missing_source" });
  await Promise.all([service.shutdown(), missing.shutdown()]);
});

test("source and asset traversal, symlinks, and unknown asset names are rejected", async (t) => {
  const roots = await workspace(t); const outside = path.join(roots.root, "outside.avi"); await writeFile(outside, "outside");
  for (const sourcePath of ["../outside.avi", "/etc/passwd"]) {
    const service = createTranscodeService({ ...roots, resolveSource: async () => ({ id: ids.sourceId, itemId: ids.itemId, availability: "available", path: sourcePath }) });
    await assert.rejects(service.createSession(plan(), {}), { code: "unsafe_path" }); await service.shutdown();
  }
  await symlink(outside, path.join(roots.contentRoot, "incompatible.avi"));
  const symlinked = serviceFor(roots); await assert.rejects(symlinked.createSession(plan(), { userId: "user-a" }), { code: "unsafe_path" }); await symlinked.shutdown();

  await writeFile(path.join(roots.contentRoot, "incompatible.avi"), "media").catch(() => {});
  const service = serviceFor(roots, { runner: async (_input, directory) => {
    await writeFile(path.join(directory, "master.m3u8"), "master"); await writeFile(path.join(directory, "media.m3u8"), "media");
    return { masterPlaylist: path.join(directory, "master.m3u8") };
  } });
  // Replace the symlink with a regular in-root source.
  await import("node:fs/promises").then(async ({ rm }) => { await rm(path.join(roots.contentRoot, "incompatible.avi")); await writeFile(path.join(roots.contentRoot, "incompatible.avi"), "media"); });
  const session = await service.createSession(plan(), { userId: "user-a" }); await session.completion;
  for (const name of ["../master.m3u8", "nested/media.m3u8", "anything.txt", "segment-1.ts"]) await assert.rejects(session.resolveAsset(name), { code: "unsafe_asset" });
  await service.shutdown();
});

test("runner is shell-free, no-overwrite, bounded, and reports missing FFmpeg", async (t) => {
  const roots = await workspace(t); const input = path.join(roots.contentRoot, "incompatible.avi"); await writeFile(input, "bad");
  const args = buildTranscodeArguments(input, roots.outputRoot, { segmentDuration: 4 });
  assert.deepEqual(args.slice(0, 6), ["-nostdin", "-v", "error", "-n", "-i", input]); assert.ok(args.includes("--")); assert.ok(args.includes("libx264")); assert.ok(args.includes("aac"));
  await assert.rejects(runFfmpegTranscode(input, roots.outputRoot, { binary: "/not/a/real/ffmpeg" }), { code: "ffmpeg_unavailable" });
  await writeFile(path.join(roots.outputRoot, "media.m3u8"), "existing");
  await assert.rejects(runFfmpegTranscode(input, roots.outputRoot, { maxStderrBytes: 24 }), (error) => error.code === "ffmpeg_failed" && Buffer.byteLength(error.stderr) <= 24);
  assert.equal(await readFile(path.join(roots.outputRoot, "media.m3u8"), "utf8"), "existing");
});

test("runner applies the server-produced bitrate ceiling without shell interpolation", () => {
  const args = buildTranscodeArguments("/input", "/output", { maxBitrate: 4_000_000 });
  const valueAfter = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(valueAfter("-b:v"), "3672000");
  assert.equal(valueAfter("-maxrate"), "3672000");
  assert.equal(valueAfter("-bufsize"), "7344000");
  assert.equal(valueAfter("-b:a"), "128000");
});

test("runner applies exact rendition limits, no-upscale dimensions, and progressive HLS publication", () => {
  const renditionProfile = {
    audioBitrate: 128_000, audioChannels: 2, maxFrameRate: 60,
    totalBitrate: 4_000_000, videoBitrate: 3_600_000
  };
  const args = buildTranscodeArguments("/input", "/output", {
    maxBitrate: 9_000_000, maxHeight: 721, maxWidth: 1281, renditionProfile, segmentDuration: 4,
    subtitleFilter: "subtitles=fixture.srt"
  });
  const valueAfter = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(valueAfter("-b:v"), "3600000");
  assert.equal(valueAfter("-b:a"), "128000");
  assert.equal(valueAfter("-fpsmax"), "60");
  assert.equal(valueAfter("-force_key_frames"), "expr:gte(t,n_forced*4)");
  assert.equal(valueAfter("-hls_playlist_type"), "event");
  assert.equal(valueAfter("-hls_flags"), "independent_segments+temp_file");
  assert.match(valueAfter("-vf"), /subtitles=fixture\.srt,scale=w=1280:h=720/);
});

test("transcode sessions become playable after the first atomic segment while completion keeps running", async (t) => {
  const roots = await workspace(t); await writeFile(path.join(roots.contentRoot, "incompatible.avi"), "media");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = serviceFor(roots, { runner: async (_input, directory, { onReady }) => {
    await writeFile(path.join(directory, "master.m3u8"), "#EXTM3U\nmedia.m3u8\n");
    await writeFile(path.join(directory, "segment-00000.ts"), "first");
    await writeFile(path.join(directory, "media.m3u8"), "#EXTM3U\nsegment-00000.ts\n");
    onReady();
    await gate;
    return { masterPlaylist: path.join(directory, "master.m3u8"), mediaPlaylist: path.join(directory, "media.m3u8") };
  } });
  const session = await service.createSession(plan(), { userId: "user-a" });
  while (session.status !== "ready") await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await readFile(await session.resolveAsset("segment-00000.ts"), "utf8"), "first");
  assert.equal((await service.status()).active.software, 1);
  release();
  await session.completion;
  assert.equal(session.status, "ready");
  await service.shutdown();
});

test("runner enforces timeout, output byte, segment, and cancellation limits", async (t) => {
  const roots = await workspace(t);
  const binary = path.resolve("tests/fixtures/transcode/fake-ffmpeg.mjs");
  for (const [name, options, code] of [
    ["timeout.avi", { timeoutMs: 15 }, "timeout"],
    ["output-limit.avi", { maxOutputBytes: 8 }, "output_limit"],
    ["segment-limit.avi", { maxSegments: 1 }, "segment_limit"]
  ]) {
    const input = path.join(roots.contentRoot, name); const directory = path.join(roots.outputRoot, name); await writeFile(input, "fixture"); await mkdir(directory);
    await assert.rejects(runFfmpegTranscode(input, directory, { binary, outputCheckMs: 5, ...options }), { code });
  }
  const input = path.join(roots.contentRoot, "cancel.avi"); const directory = path.join(roots.outputRoot, "cancel"); await writeFile(input, "fixture"); await mkdir(directory);
  const controller = new AbortController(); const completion = runFfmpegTranscode(input, directory, { binary, signal: controller.signal }); controller.abort();
  await assert.rejects(completion, { code: "cancelled" });
});

test("runner rejects a successful process that never publishes a playable segment", async (t) => {
  const roots = await workspace(t);
  const input = path.join(roots.contentRoot, "empty.avi"); const directory = path.join(roots.outputRoot, "empty");
  await writeFile(input, "fixture"); await mkdir(directory);
  await assert.rejects(runFfmpegTranscode(input, directory, { binary: path.resolve("tests/fixtures/transcode/fake-ffmpeg.mjs") }), { code: "output_failed" });
});

test("cancellation, timeout, and limits remove terminal partial output", async (t) => {
  const roots = await workspace(t); await writeFile(path.join(roots.contentRoot, "incompatible.avi"), "media");
  for (const mode of ["cancelled", "timeout", "output_limit", "segment_limit"]) {
    const service = serviceFor(roots, { runner: async (_input, directory, { signal }) => {
      await writeFile(path.join(directory, "segment-00000.ts"), "partial");
      return new Promise((_resolve, reject) => {
        if (mode === "cancelled") signal.addEventListener("abort", () => reject(new (class extends Error { code = "cancelled"; })()), { once: true });
        else reject(Object.assign(new Error(mode), { code: mode }));
      });
    } });
    const session = await service.createSession(plan(), { userId: "user-a" }); if (mode === "cancelled") session.cancel();
    await assert.rejects(session.completion, { code: mode }); assert.equal(session.status, mode === "cancelled" ? "cancelled" : "failed");
    await assert.rejects(access(path.join(roots.outputRoot, session.id))); await service.shutdown();
  }
});

test("bounded concurrency, startup recovery, cleanup, and session isolation", async (t) => {
  const roots = await workspace(t); await writeFile(path.join(roots.contentRoot, "incompatible.avi"), "media");
  let active = 0; let maximum = 0; const releases = [];
  const service = serviceFor(roots, { concurrency: 2, uuid: (() => { let value = 0; return () => `session-${++value}`; })(), runner: (_input, directory, { signal }) => new Promise((resolve, reject) => {
    active += 1; maximum = Math.max(maximum, active);
    Promise.all([writeFile(path.join(directory, "master.m3u8"), path.basename(directory)), writeFile(path.join(directory, "media.m3u8"), "media")]).then(() => {
      releases.push(() => { active -= 1; resolve({ masterPlaylist: path.join(directory, "master.m3u8") }); });
    });
    signal.addEventListener("abort", () => { active -= 1; reject(Object.assign(new Error("cancelled"), { code: "cancelled" })); }, { once: true });
  }) });
  await service.initialize(); await assert.rejects(access(path.join(roots.outputRoot, "stale.tmp")));
  const sessions = await Promise.all([1, 2, 3].map(() => service.createSession(plan(), { userId: "user-a" })));
  await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(maximum, 2); assert.equal(sessions.filter((item) => item.status === "queued").length, 1);
  releases.shift()(); await Promise.race(sessions.map((item) => item.completion)); await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await readFile(await sessions[0].resolveAsset("master.m3u8"), "utf8"), sessions[0].id);
  await assert.rejects(sessions[0].resolveAsset("segment-00000.ts"), { code: "missing_asset" });
  assert.equal(sessions.filter((item) => item.status === "running").length, 2);
  await service.shutdown(); assert.equal(service.getSession(sessions[0].id), null); await assert.rejects(access(roots.outputRoot));
});

test("duplicate session IDs cannot share cache directories", async (t) => {
  const roots = await workspace(t); await writeFile(path.join(roots.contentRoot, "incompatible.avi"), "media");
  const service = serviceFor(roots, { uuid: () => "same", runner: async (_input, directory) => {
    await writeFile(path.join(directory, "master.m3u8"), "master"); return { masterPlaylist: path.join(directory, "master.m3u8") };
  } });
  const first = await service.createSession(plan(), { userId: "user-a" }); await assert.rejects(service.createSession(plan(), { userId: "user-a" }), { code: "session_collision" });
  await first.completion; await service.shutdown();
});

test("preferred hardware failure retries software once with complete cache cleanup", async (t) => {
  const roots = await workspace(t); await writeFile(path.join(roots.contentRoot, "incompatible.avi"), "media");
  const attempts = [];
  const service = serviceFor(roots, {
    acceleration: { async decide() { return { backend: "nvenc", outcome: "hardware", reason: "available", required: false }; }, async status() { return {}; } },
    runner: async (_input, directory, options) => {
      attempts.push(options.profile.backend);
      if (attempts.length === 1) { await writeFile(path.join(directory, "partial.ts"), "partial"); throw Object.assign(new Error("hardware failed /dev/gpu secret"), { code: "ffmpeg_failed" }); }
      assert.equal(await access(path.join(directory, "partial.ts")).then(() => true, () => false), false);
      await writeFile(path.join(directory, "master.m3u8"), "master"); return { masterPlaylist: path.join(directory, "master.m3u8") };
    }
  });
  const session = await service.createSession(plan(), { userId: "user-a" }); await session.completion;
  assert.deepEqual(attempts, ["nvenc", "software"]); assert.deepEqual(session.acceleration, { backend: "software", outcome: "fallback", reason: "hardware_job_failed" });
  await service.shutdown();
});

test("required backend failure occurs before session publication and never runs software", async (t) => {
  const roots = await workspace(t); await writeFile(path.join(roots.contentRoot, "incompatible.avi"), "media"); let runs = 0;
  const service = serviceFor(roots, { acceleration: { async decide() { return { backend: "software", outcome: "failed", reason: "required_backend_unavailable", required: true }; }, async status() { return {}; } }, runner: async () => { runs += 1; } });
  await assert.rejects(service.createSession(plan(), { userId: "user-a" }), { code: "required_backend_unavailable" }); assert.equal(runs, 0); await service.shutdown();
});
