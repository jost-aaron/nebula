import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { TranscodeError } from "./errors.mjs";
import { resolveTranscodeAssetPath, resolveTranscodeSourcePath } from "./path.mjs";
import { runFfmpegTranscode } from "./runner.mjs";

class Semaphore {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new RangeError("concurrency must be between 1 and 32.");
    this.limit = limit; this.active = 0; this.waiting = [];
  }
  async run(action, signal) {
    if (this.active >= this.limit) await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      const abort = () => { this.waiting = this.waiting.filter((item) => item !== entry); reject(new TranscodeError("cancelled", "Transcode was cancelled.")); };
      entry.resolve = () => { signal?.removeEventListener("abort", abort); resolve(); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else this.waiting.push(entry);
    });
    this.active += 1;
    try { return await action(); } finally { this.active -= 1; this.waiting.shift()?.resolve(); }
  }
}

const validatePlan = (plan) => {
  if (!plan || plan.decision !== "transcode") throw new TranscodeError("invalid_plan", "A server-produced transcode playback plan is required.");
  if (typeof plan.itemId !== "string" || !plan.itemId || typeof plan.sourceId !== "string" || !plan.sourceId) throw new TranscodeError("invalid_plan", "The transcode plan requires itemId and sourceId.");
  const output = plan.output;
  if (output?.protocol !== "hls" || output?.container !== "mpegts" || output?.videoCodec !== "h264" || output?.audioCodec !== "aac") {
    throw new TranscodeError("unsupported_output", "This service supports H.264/AAC MPEG-TS HLS output only.");
  }
};

export const createTranscodeService = ({
  concurrency = 2, contentRoot, outputRoot, resolveSource,
  runner = runFfmpegTranscode, runnerOptions, uuid = randomUUID
} = {}) => {
  if (!contentRoot || !outputRoot) throw new TypeError("contentRoot and outputRoot are required.");
  if (typeof resolveSource !== "function") throw new TypeError("resolveSource must be a function.");
  const semaphore = new Semaphore(concurrency); const sessions = new Map(); let closed = false;
  const initialize = async () => { await rm(outputRoot, { recursive: true, force: true }); await mkdir(outputRoot, { recursive: true }); };
  const initialized = initialize();
  const createSession = async (plan, authorizationContext, { signal } = {}) => {
    validatePlan(plan);
    if (closed) throw new TranscodeError("service_closed", "The transcode service is shut down.");
    await initialized;
    const source = await resolveSource({ itemId: plan.itemId, sourceId: plan.sourceId }, authorizationContext);
    if (!source || source.id !== plan.sourceId || source.itemId !== plan.itemId || source.availability !== "available") {
      throw new TranscodeError("missing_source", "The requested catalog source is missing or unavailable.");
    }
    const inputPath = await resolveTranscodeSourcePath(contentRoot, source.path);
    const id = uuid();
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || sessions.has(id)) throw new TranscodeError("session_collision", "A unique transcode session could not be allocated.");
    const directory = path.join(outputRoot, id); const controller = new AbortController();
    const forwardAbort = () => controller.abort(); signal?.addEventListener("abort", forwardAbort, { once: true });
    const state = { status: "queued", playlistPath: null, error: null };
    const session = {
      id, itemId: plan.itemId, sourceId: plan.sourceId,
      get status() { return state.status; }, get playlistPath() { return state.playlistPath; }, get error() { return state.error; },
      cancel: () => controller.abort(),
      resolveAsset: (assetName) => resolveTranscodeAssetPath(directory, assetName),
      cleanup: async () => { controller.abort(); try { await session.completion; } catch {} await rm(directory, { recursive: true, force: true }); sessions.delete(id); }
    };
    session.completion = semaphore.run(async () => {
      state.status = "running"; await mkdir(directory, { recursive: false });
      try {
        if (controller.signal.aborted) throw new TranscodeError("cancelled", "Transcode was cancelled.");
        const result = await runner(inputPath, directory, { ...runnerOptions, maxBitrate: plan.output.bitrate ?? runnerOptions?.maxBitrate ?? null, signal: controller.signal });
        state.status = "ready"; state.playlistPath = result.masterPlaylist; return session;
      } finally { signal?.removeEventListener("abort", forwardAbort); }
    }, controller.signal).catch(async (error) => {
      state.error = error; state.status = error?.code === "cancelled" ? "cancelled" : "failed";
      await rm(directory, { recursive: true, force: true }); throw error;
    });
    sessions.set(id, session); return session;
  };
  const shutdown = async () => {
    closed = true; for (const session of sessions.values()) session.cancel();
    await Promise.allSettled([...sessions.values()].map((session) => session.completion));
    await rm(outputRoot, { recursive: true, force: true }); sessions.clear();
  };
  return { createSession, getSession: (id) => sessions.get(id) ?? null, initialize: () => initialized, shutdown };
};
