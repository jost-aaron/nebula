import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeliveryService } from "../server/playback/delivery.mjs";

const user = (userId) => ({ type: "user", userId });
const capabilities = { audioCodecs: ["aac"], containers: ["mp4"], deviceId: "browser", maxAudioChannels: null, maxBitrate: null, maxHeight: null, maxWidth: null, subtitleFormats: [], supportsHls: true, videoCodecs: ["h264"] };
const request = { capabilities, itemId: "item-1", sourceId: "source-1", plan: { decision: "transcode" } };
const plan = (decision) => ({ decision, itemId: "item-1", sourceId: "source-1", output: decision === "transcode" ? { audioCodec: "aac", container: "mpegts", protocol: "hls", videoCodec: "h264" } : { audioCodec: "aac", container: "mp4", protocol: "file", videoCodec: "h264" }, reasons: [] });

const fixture = async (decision = "direct-play", options = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-delivery-"));
  await mkdir(path.join(root, "Movies"));
  await writeFile(path.join(root, "Movies", "movie.mp4"), "movie-bytes");
  let plannedRequest; let transcodeOptions; let cleaned = 0; let released = 0;
  const worker = {
    status: "ready", outputPath: path.join(root, "Movies", "movie.mp4"), completion: Promise.resolve(),
    cancel() {}, async cleanup() { cleaned += 1; }, async resolveAsset(name) { return path.join(root, name); }
  };
  const service = createDeliveryService({
    contentRoot: root,
    planner: { async plan(value) { plannedRequest = value; return options.plan ?? plan(decision); } },
    policy: options.policy ?? { admit() { let done = false; return { maxProducedBitrate: null, release() { if (!done) { done = true; released += 1; } } }; } },
    remuxService: { async createSession() { return worker; } },
    resolveSource: async () => ({ availability: "available", id: "source-1", itemId: "item-1", path: "Movies/movie.mp4" }),
    transcodeService: { async createSession(_plan, _principal, value) { transcodeOptions = value; return worker; } },
    ttlMs: options.ttlMs ?? 60_000, now: options.now, uuid: () => "delivery-1"
  });
  return { cleaned: () => cleaned, plannedRequest: () => plannedRequest, released: () => released, root, service, transcodeOptions: () => transcodeOptions };
};

test("delivery replans from IDs and capabilities, binds ownership, and exposes no filesystem paths", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const created = await value.service.create(request, user("alice"));
  assert.deepEqual(value.plannedRequest(), { capabilities, itemId: "item-1", sourceId: "source-1" });
  assert.equal(created.plan.decision, "direct-play");
  assert.equal(created.session.deliveryUrl, "/api/playback/delivery-sessions/delivery-1/file");
  assert.equal(JSON.stringify(created).includes(value.root), false);
  assert.throws(() => value.service.get("delivery-1", user("bob")), { status: 404 });
  const asset = await value.service.resolveFile("delivery-1", user("alice"));
  assert.equal(asset.path, path.join(value.root, "Movies", "movie.mp4"));
  await value.service.shutdown();
});

test("remux and transcode sessions route through only the server-produced plan", async (t) => {
  for (const decision of ["remux", "transcode"]) {
    const value = await fixture(decision); t.after(() => rm(value.root, { recursive: true, force: true }));
    const created = await value.service.create(request, user("alice"));
    assert.equal(created.session.decision, decision);
    assert.match(created.session.deliveryUrl, decision === "transcode" ? /master\.m3u8$/ : /\/file$/);
    if (decision === "transcode") assert.equal(await value.service.resolveHlsAsset("delivery-1", "segment-00000.ts", user("alice")), path.join(value.root, "segment-00000.ts"));
    await value.service.cancel("delivery-1", user("alice"));
    assert.equal(value.cleaned(), 1);
    assert.equal(value.released(), 1);
  }
});

test("delivery forwards quality, reports its profile, and extends active session expiry", async (t) => {
  let clock = 1_000;
  const profilePlan = plan("transcode");
  profilePlan.output.profileId = "720p";
  const value = await fixture("transcode", { now: () => clock, plan: profilePlan, ttlMs: 100 });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const quality = { mode: "profile", profileId: "720p" };
  const created = await value.service.create({ ...request, quality }, user("alice"));
  assert.deepEqual(value.plannedRequest(), { capabilities, itemId: "item-1", quality, sourceId: "source-1" });
  assert.equal(created.session.profileId, "720p");
  clock = 1_050;
  assert.equal(value.service.get("delivery-1", user("alice")).expiresAt, new Date(1_150).toISOString());
  clock = 1_101;
  assert.equal(value.service.get("delivery-1", user("alice")).status, "ready");
  await value.service.shutdown();
});

test("delivery applies policy constraints before profile planning and never mutates fixed profiles", async (t) => {
  let admitted;
  const fixedPlan = plan("transcode");
  fixedPlan.output = { ...fixedPlan.output, bitrate: 2_000_000, profileId: "480p" };
  const policy = {
    admit(value) { admitted = value; return { maxProducedBitrate: 1_500_000, release() {} }; },
    constraints() { return { maxBitrate: 3_000_000, maxConcurrentStreams: null }; }
  };
  const value = await fixture("transcode", { plan: fixedPlan, policy });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const created = await value.service.create(request, user("alice"));
  assert.equal(value.plannedRequest().capabilities.maxBitrate, 3_000_000);
  assert.equal(admitted.fixedProfile, true);
  assert.equal(created.plan.output.bitrate, 2_000_000);
  await value.service.shutdown();
});

test("resumed transcodes wait for a complete playlist and reject malformed positions", async (t) => {
  const value = await fixture("transcode"); t.after(() => rm(value.root, { recursive: true, force: true }));
  await value.service.create({ ...request, startPositionSeconds: 186 }, user("alice"));
  assert.deepEqual(value.transcodeOptions(), { requireCompleteBeforeReady: true });
  await value.service.shutdown();

  const invalid = await fixture("transcode"); t.after(() => rm(invalid.root, { recursive: true, force: true }));
  await assert.rejects(invalid.service.create({ ...request, startPositionSeconds: -1 }, user("alice")), { code: "invalid_start_position" });
  await invalid.service.shutdown();
});

test("explicit playback completion releases generated policy accounting", async (t) => {
  const value = await fixture("transcode"); t.after(() => rm(value.root, { recursive: true, force: true }));
  await value.service.create(request, user("alice"));
  await value.service.complete("delivery-1", user("alice"));
  assert.equal(value.released(), 1);
  assert.throws(() => value.service.get("delivery-1", user("alice")), { code: "session_not_found" });
});

test("expiry and shutdown cancel generated delivery artifacts", async (t) => {
  let clock = 1_000;
  const value = await fixture("remux", { now: () => clock, ttlMs: 100 }); t.after(() => rm(value.root, { recursive: true, force: true }));
  await value.service.create(request, user("alice"));
  clock = 1_101;
  assert.throws(() => value.service.get("delivery-1", user("alice")), { status: 410 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.cleaned(), 1);
  assert.equal(value.released(), 1);
  await value.service.shutdown();
});

test("worker failure and server shutdown release generated policy accounting exactly once", async (t) => {
  const failed = await fixture("transcode"); t.after(() => rm(failed.root, { recursive: true, force: true }));
  const rejection = Promise.reject(Object.assign(new Error("worker failed"), { code: "ffmpeg_failed" }));
  const failingService = createDeliveryService({
    contentRoot: failed.root,
    planner: { async plan() { return plan("transcode"); } },
    policy: { admit() { let done = false; return { maxProducedBitrate: null, release() { if (!done) { done = true; failed.serviceRelease = (failed.serviceRelease ?? 0) + 1; } } }; } },
    resolveSource: async () => null,
    remuxService: {},
    transcodeService: { async createSession() { return { status: "running", completion: rejection, cancel() {}, async cleanup() { await rejection.catch(() => {}); } }; } },
    uuid: () => "failed-delivery"
  });
  await failingService.create(request, user("alice"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failed.serviceRelease, 1);
  await failingService.shutdown();
  assert.equal(failed.serviceRelease, 1);

  const active = await fixture("remux"); t.after(() => rm(active.root, { recursive: true, force: true }));
  await active.service.create(request, user("alice"));
  await active.service.shutdown();
  assert.equal(active.released(), 1);
});

test("service principals and unsupported plans cannot create account delivery sessions", async (t) => {
  const value = await fixture("unsupported"); t.after(() => rm(value.root, { recursive: true, force: true }));
  await assert.rejects(() => value.service.create(request, { type: "service", userId: null }), { status: 403 });
  await assert.rejects(() => value.service.create(request, user("alice")), { status: 422 });
  await value.service.shutdown();
});
