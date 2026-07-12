import assert from "node:assert/strict";
import test from "node:test";
import { buildTranscodeArguments, createAccelerationManager, createAccelerationProbe, normalizeAccelerationMode, normalizeProbeOutput, selectAcceleration } from "../server/transcode/index.mjs";
import { renderTranscodeAccelerationMetrics } from "../server/observability/metrics.mjs";

test("capability normalization is bounded and malformed output is unavailable", () => {
  assert.equal(normalizeAccelerationMode("AUTO"), "auto");
  assert.equal(normalizeAccelerationMode("--inject"), "software-only");
  const parsed = normalizeProbeOutput(" V..... h264_nvenc NVIDIA encoder\nmalformed /private/media-name");
  assert.equal(parsed.nvenc.encoderDetected, true);
  assert.equal(parsed.vaapi.encoderDetected, false);
});

test("mode selection supports preference, require failures, unsupported codecs, and fallback", () => {
  const capability = { backends: { nvenc: { available: true }, vaapi: { available: false } } };
  assert.deepEqual(selectAcceleration({ capability, mode: "auto" }), { backend: "nvenc", outcome: "hardware", reason: "available", required: false });
  assert.equal(selectAcceleration({ capability, mode: "prefer-vaapi" }).outcome, "fallback");
  assert.deepEqual(selectAcceleration({ capability, mode: "require-vaapi" }), { backend: "software", outcome: "failed", reason: "required_backend_unavailable", required: true });
  assert.equal(selectAcceleration({ capability, mode: "auto", videoCodec: "hevc" }).reason, "unsupported_codec");
});

test("probe requires encoder, device, and a bounded real self-test", async () => {
  const calls = [];
  const probe = createAccelerationProbe({ platform: "linux", accessDevice: async () => true, executeCommand: async (_binary, args) => {
    calls.push(args);
    if (args.includes("-encoders")) return { ok: true, output: " V..... h264_vaapi VAAPI\n V..... h264_nvenc NVENC" };
    return { ok: args.includes("h264_vaapi"), output: "/dev/dri and driver details must not escape" };
  } });
  const result = await probe();
  assert.equal(result.backends.vaapi.available, true);
  assert.equal(result.backends.nvenc.available, false);
  assert.equal(JSON.stringify(result).includes("/dev/dri"), false);
  assert.ok(calls.every((args) => Array.isArray(args)));
});

test("detection failure is cached, refreshable, and never blocks software mode", async () => {
  let count = 0;
  const manager = createAccelerationManager({ mode: "software-only", now: () => 10, probe: async () => { count += 1; throw new Error("ffmpeg missing /secret"); } });
  assert.equal((await manager.decide({ output: { videoCodec: "h264" } })).backend, "software");
  await manager.status(); assert.equal(count, 1);
  await manager.refresh(); assert.equal(count, 2);
  assert.equal(JSON.stringify(await manager.status()).includes("secret"), false);
});

test("runner arguments are fixed server-authored arrays and preserve bitrate and filters", () => {
  const args = buildTranscodeArguments("/safe/input", "/safe/output", { maxBitrate: 2_000_000, profile: { encoder: "h264_vaapi", inputArguments: ["-vaapi_device", "/dev/dri/renderD128"], pixelFormat: null, videoFilter: "format=nv12,hwupload" }, subtitleFilter: "subtitles=trusted.srt" });
  assert.deepEqual(args.slice(0, 8), ["-nostdin", "-v", "error", "-n", "-vaapi_device", "/dev/dri/renderD128", "-i", "/safe/input"]);
  assert.ok(args.includes("h264_vaapi")); assert.ok(args.includes("subtitles=trusted.srt,format=nv12,hwupload")); assert.ok(args.includes("1772000"));
  assert.equal(args.includes("shell"), false);
});

test("acceleration metrics accept only bounded low-cardinality labels", () => {
  const metrics = renderTranscodeAccelerationMetrics({ active: { hardware: 2, software: 1 }, outcomes: [{ backend: "nvenc", outcome: "success", count: 3 }, { backend: "/dev/gpu-user-file", outcome: "session-123", count: 9 }] });
  assert.match(metrics, /backend="nvenc",outcome="success"/);
  assert.doesNotMatch(metrics, /gpu-user|session-123|\/dev\//);
});
