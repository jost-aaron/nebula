import assert from "node:assert/strict";
import test from "node:test";
import { createPlaybackPlanner, planPlayback } from "../server/playback-planner/index.mjs";

const ids = { itemId: "10000000-0000-4000-8000-000000000001", sourceId: "20000000-0000-4000-8000-000000000001" };
const capabilities = (overrides = {}) => ({
  audioCodecs: ["aac", "eac3"], containers: ["mp4", "matroska"], deviceId: "living-room",
  maxAudioChannels: 8, maxBitrate: 20_000_000, maxHeight: 2160, maxWidth: 3840,
  subtitleFormats: ["srt", "webvtt"], supportsHls: true, videoCodecs: ["h264", "h265"], ...overrides
});
const request = (overrides = {}) => ({ ...ids, capabilities: capabilities(), ...overrides });
const media = (overrides = {}) => ({
  item: { id: ids.itemId }, source: { availability: "available", id: ids.sourceId, itemId: ids.itemId },
  probe: {
    format: { bitrate: 8_000_000, name: "mp4" }, probeState: "ready",
    streams: [
      { codec: "h264", default: true, height: 1080, index: 0, type: "video", width: 1920 },
      { channels: 6, codec: "eac3", default: true, index: 1, type: "audio" },
      { codec: "subrip", default: true, forced: false, index: 2, type: "subtitle" }
    ]
  }, ...overrides
});

test("direct play preserves compatible selected streams and normalizes aliases", () => {
  const result = planPlayback(request(), media());
  assert.deepEqual(result, {
    decision: "direct-play", ...ids,
    output: { audioCodec: "eac3", bitrate: 8_000_000, container: "mp4", protocol: "file", videoCodec: "h264" },
    reasons: [{ code: "DIRECT_PLAY_COMPATIBLE", message: "The original container and selected streams satisfy all client capabilities.", streamIndex: null }]
  });
});

test("container-only incompatibility produces an explainable stream-copy remux", () => {
  const result = planPlayback(request({ capabilities: capabilities({ containers: ["mp4"] }) }), media({
    ...media(), probe: { ...media().probe, format: { bitrate: 8_000_000, name: "matroska,webm" } }
  }));
  assert.equal(result.decision, "remux");
  assert.deepEqual(result.output, { audioCodec: "eac3", bitrate: 8_000_000, container: "mp4", protocol: "file", videoCodec: "h264" });
  assert.deepEqual(result.reasons.map(({ code }) => code), ["CONTAINER_UNSUPPORTED", "REMUX_PRESERVES_STREAMS"]);
});

test("codec incompatibility chooses the deterministic software HLS target", () => {
  const incompatible = media();
  incompatible.probe.streams[0].codec = "vp9";
  const result = planPlayback(request(), incompatible);
  assert.equal(result.decision, "transcode");
  assert.deepEqual(result.output, { audioCodec: "aac", bitrate: 8_000_000, container: "mpegts", protocol: "hls", videoCodec: "h264" });
  assert.deepEqual(result.reasons.map(({ code, streamIndex }) => [code, streamIndex]), [
    ["VIDEO_CODEC_UNSUPPORTED", 0], ["HLS_SOFTWARE_TRANSCODE", null]
  ]);
});

test("resolution, bitrate, and audio channel limits are all reported in stable order", () => {
  const result = planPlayback(request({ capabilities: capabilities({ maxAudioChannels: 2, maxBitrate: 4_000_000, maxHeight: 720, maxWidth: 1280 }) }), media());
  assert.equal(result.decision, "transcode");
  assert.equal(result.output.bitrate, 4_000_000);
  assert.deepEqual(result.reasons.map(({ code }) => code), [
    "VIDEO_WIDTH_EXCEEDED", "VIDEO_HEIGHT_EXCEEDED", "BITRATE_EXCEEDED", "AUDIO_CHANNELS_EXCEEDED", "HLS_SOFTWARE_TRANSCODE"
  ]);
});

test("selected incompatible subtitles require transcoding while unselected subtitles do not", () => {
  const selected = planPlayback(request({ capabilities: capabilities({ subtitleFormats: [] }) }), media());
  assert.equal(selected.decision, "transcode");
  assert.equal(selected.reasons[0].code, "SUBTITLE_FORMAT_UNSUPPORTED");
  const unselectedMedia = media();
  unselectedMedia.probe.streams[2].default = false;
  assert.equal(planPlayback(request({ capabilities: capabilities({ subtitleFormats: [] }) }), unselectedMedia).decision, "direct-play");
});

test("clients without HLS receive unsupported with every deterministic blocker", () => {
  const incompatible = media();
  incompatible.probe.streams[0].codec = "av1";
  const result = planPlayback(request({ capabilities: capabilities({ supportsHls: false, videoCodecs: ["av1"] , maxHeight: 720 }) }), incompatible);
  assert.equal(result.decision, "unsupported");
  assert.deepEqual(result.output, { audioCodec: null, bitrate: null, container: null, protocol: null, videoCodec: null });
  assert.deepEqual(result.reasons.map(({ code }) => code), ["VIDEO_HEIGHT_EXCEEDED", "HLS_UNSUPPORTED", "TRANSCODE_VIDEO_TARGET_UNSUPPORTED"]);
});

test("container incompatibility is unsupported when neither remux nor HLS is available", () => {
  const result = planPlayback(request({ capabilities: capabilities({ containers: [], supportsHls: false }) }), media());
  assert.deepEqual(result.reasons.map(({ code }) => code), ["CONTAINER_UNSUPPORTED", "HLS_UNSUPPORTED", "REMUX_CONTAINER_UNAVAILABLE"]);
});

test("remux never selects a container that cannot safely carry selected codecs", () => {
  const result = planPlayback(request({ capabilities: capabilities({ containers: ["webm"] }) }), media());
  assert.equal(result.decision, "transcode");
  assert.deepEqual(result.reasons.map(({ code }) => code), ["CONTAINER_UNSUPPORTED", "HLS_SOFTWARE_TRANSCODE"]);
});

test("malformed capabilities fail closed and do not query catalog data", async () => {
  let calls = 0;
  const planner = createPlaybackPlanner({ resolveMedia: async () => { calls += 1; return media(); } });
  const result = await planner.plan(request({ capabilities: capabilities({ maxBitrate: -1 }) }), { userId: "user-a" });
  assert.equal(result.decision, "unsupported");
  assert.equal(result.reasons[0].code, "MALFORMED_CAPABILITIES");
  assert.equal(calls, 0);
});

test("catalog and probe boundaries fail closed with exact reasons", () => {
  assert.equal(planPlayback(request(), null).reasons[0].code, "CATALOG_SOURCE_NOT_FOUND");
  assert.equal(planPlayback(request(), media({ source: { availability: "available", id: ids.sourceId, itemId: "other" } })).reasons[0].code, "CATALOG_ID_MISMATCH");
  assert.equal(planPlayback(request(), media({ source: { availability: "missing", id: ids.sourceId, itemId: ids.itemId } })).reasons[0].code, "SOURCE_UNAVAILABLE");
  assert.equal(planPlayback(request(), media({ probe: { format: null, probeState: "pending", streams: [] } })).reasons[0].code, "PROBE_DATA_UNAVAILABLE");
});

test("resolver receives authorization context and authorization errors remain authoritative", async () => {
  const context = { userId: "user-a", visibleRootIds: ["root-a"] };
  const planner = createPlaybackPlanner({ resolveMedia: async (identity, received) => {
    assert.deepEqual(identity, ids);
    assert.equal(received, context);
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  } });
  await assert.rejects(planner.plan(request(), context), { status: 403 });
});

test("audio-only sources plan without inventing a video output", () => {
  const audio = media();
  audio.probe.format.name = "flac";
  audio.probe.streams = [{ channels: 2, codec: "flac", default: true, index: 0, type: "audio" }];
  const result = planPlayback(request({ capabilities: capabilities({ audioCodecs: ["aac"], containers: ["mp4"] }) }), audio);
  assert.equal(result.decision, "transcode");
  assert.deepEqual(result.output, { audioCodec: "aac", bitrate: 8_000_000, container: "mpegts", protocol: "hls", videoCodec: null });
});
