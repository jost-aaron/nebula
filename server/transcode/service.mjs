import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { TranscodeError } from "./errors.mjs";
import { resolveTranscodeAssetPath, resolveTranscodeSourcePath } from "./path.mjs";
import { runFfmpegTranscode } from "./runner.mjs";
import { accelerationRunnerProfile } from "./acceleration.mjs";
import { getRenditionProfile } from "../renditions/profiles.mjs";

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
  if (output.profileId) {
    const profile = getRenditionProfile(output.profileId);
    if (!profile || output.bitrate !== profile.totalBitrate
      || !Number.isInteger(output.width) || output.width < 2 || output.width > profile.maxWidth
      || !Number.isInteger(output.height) || output.height < 2 || output.height > profile.maxHeight) {
      throw new TranscodeError("unsupported_output", "The rendition plan does not match its server-owned profile.");
    }
  }
};

export const createTranscodeService = ({
  concurrency = 2, contentRoot, outputRoot, resolveSource,
  acceleration = null, resolveSubtitle = null, runner = runFfmpegTranscode, runnerOptions, uuid = randomUUID
} = {}) => {
  if (!contentRoot || !outputRoot) throw new TypeError("contentRoot and outputRoot are required.");
  if (typeof resolveSource !== "function") throw new TypeError("resolveSource must be a function.");
  const semaphore = new Semaphore(concurrency); const sessions = new Map(); let closed = false;
  const active = { hardware: 0, software: 0 }; const outcomes = new Map();
  const record = (backend, outcome) => outcomes.set(`${backend}:${outcome}`, (outcomes.get(`${backend}:${outcome}`) ?? 0) + 1);
  const initialize = async () => { await rm(outputRoot, { recursive: true, force: true }); await mkdir(outputRoot, { recursive: true }); };
  const initialized = initialize();
  const createSession = async (plan, authorizationContext, { requireCompleteBeforeReady = false, signal } = {}) => {
    validatePlan(plan);
    if (closed) throw new TranscodeError("service_closed", "The transcode service is shut down.");
    await initialized;
    const source = await resolveSource({ itemId: plan.itemId, sourceId: plan.sourceId }, authorizationContext);
    if (!source || source.id !== plan.sourceId || source.itemId !== plan.itemId || source.availability !== "available") {
      throw new TranscodeError("missing_source", "The requested catalog source is missing or unavailable.");
    }
    const inputPath = await resolveTranscodeSourcePath(contentRoot, source.path);
    let subtitleFilter = null;
    if (plan.output?.subtitle?.delivery === "burn-in") {
      if (typeof resolveSubtitle !== "function") throw new TranscodeError("subtitle_unavailable", "The selected subtitle cannot be burned in.");
      const subtitle = await resolveSubtitle({ itemId: plan.itemId, sourceId: plan.sourceId, subtitleId: plan.output.subtitle.id }, authorizationContext);
      const escaped = (value) => String(value).replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'").replaceAll(",", "\\,").replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll(";", "\\;");
      subtitleFilter = subtitle?.kind === "sidecar" ? `subtitles=filename='${escaped(subtitle.path)}'` : subtitle?.kind === "embedded" && Number.isInteger(subtitle.streamIndex) ? `subtitles=filename='${escaped(inputPath)}':si=${subtitle.streamIndex}` : null;
      if (!subtitleFilter) throw new TranscodeError("subtitle_unavailable", "The selected subtitle cannot be burned in.");
    }
    const id = uuid();
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || sessions.has(id)) throw new TranscodeError("session_collision", "A unique transcode session could not be allocated.");
    const accelerationDecision = acceleration ? await acceleration.decide(plan) : { backend: "software", outcome: "software", reason: "software_selected", required: false };
    if (accelerationDecision.outcome === "failed") {
      const error = new TranscodeError("required_backend_unavailable", "The required transcoding backend is unavailable.");
      error.status = 503; error.expose = true; throw error;
    }
    const directory = path.join(outputRoot, id); const controller = new AbortController();
    const forwardAbort = () => controller.abort(); signal?.addEventListener("abort", forwardAbort, { once: true });
    const state = { status: "queued", playlistPath: null, error: null, acceleration: accelerationDecision };
    const session = {
      id, itemId: plan.itemId, sourceId: plan.sourceId,
      get status() { return state.status; }, get playlistPath() { return state.playlistPath; }, get error() { return state.error; },
      get acceleration() { return { backend: state.acceleration.backend, outcome: state.acceleration.outcome, reason: state.acceleration.reason }; },
      cancel: () => controller.abort(),
      resolveAsset: (assetName) => resolveTranscodeAssetPath(directory, assetName),
      cleanup: async () => { controller.abort(); try { await session.completion; } catch {} await rm(directory, { recursive: true, force: true }); sessions.delete(id); }
    };
    session.completion = semaphore.run(async () => {
      state.status = "running"; await mkdir(directory, { recursive: false });
      try {
        if (controller.signal.aborted) throw new TranscodeError("cancelled", "Transcode was cancelled.");
        const run = async (backend) => {
          const kind = backend === "software" ? "software" : "hardware"; active[kind] += 1;
          const renditionProfile = getRenditionProfile(plan.output.profileId);
          try { return await runner(inputPath, directory, {
            ...runnerOptions,
            maxBitrate: plan.output.bitrate ?? runnerOptions?.maxBitrate ?? null,
            maxHeight: plan.output.height ?? null,
            maxWidth: plan.output.width ?? null,
            onReady: () => { if (!requireCompleteBeforeReady && state.status === "running") state.status = "ready"; },
            profile: accelerationRunnerProfile(backend),
            renditionProfile,
            segmentDuration: renditionProfile?.segmentDurationSeconds ?? runnerOptions?.segmentDuration,
            signal: controller.signal,
            subtitleFilter
          }); }
          finally { active[kind] -= 1; }
        };
        let result;
        try { result = await run(state.acceleration.backend); record(state.acceleration.backend, "success"); }
        catch (error) {
          const retryableHardwareFailure = state.status !== "ready" && state.acceleration.backend !== "software" && !state.acceleration.required && ["ffmpeg_failed", "ffmpeg_unavailable", "output_failed"].includes(error?.code);
          record(state.acceleration.backend, retryableHardwareFailure ? "fallback" : "failure");
          if (!retryableHardwareFailure) throw error;
          await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: false });
          state.acceleration = { backend: "software", outcome: "fallback", reason: "hardware_job_failed", required: false };
          result = await run("software"); record("software", "success");
        }
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
  const status = async () => ({ ...(acceleration ? await acceleration.status() : { mode: "software-only", selectedBackend: "software", decision: "software", reason: "software_selected", lastProbeAt: null, backends: [] }), active: { ...active }, outcomes: [...outcomes.entries()].map(([key, count]) => { const [backend, outcome] = key.split(":"); return { backend, outcome, count }; }) });
  return { createSession, getSession: (id) => sessions.get(id) ?? null, initialize: () => initialized, shutdown, status };
};
