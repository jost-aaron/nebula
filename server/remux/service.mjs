import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { RemuxError } from "./errors.mjs";
import { resolveRemuxSourcePath } from "./path.mjs";
import { runFfmpegRemux } from "./runner.mjs";

class Semaphore {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new RangeError("concurrency must be between 1 and 32.");
    this.limit = limit; this.active = 0; this.waiting = [];
  }
  async run(action, signal) {
    if (this.active >= this.limit) await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      const abort = () => { this.waiting = this.waiting.filter((value) => value !== entry); reject(new RemuxError("cancelled", "Remux was cancelled.")); };
      entry.resolve = () => { signal?.removeEventListener("abort", abort); resolve(); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else this.waiting.push(entry);
    });
    this.active += 1;
    try { return await action(); } finally { this.active -= 1; this.waiting.shift()?.resolve(); }
  }
}

const validatePlan = (plan) => {
  if (!plan || plan.decision !== "remux") throw new RemuxError("invalid_plan", "A remux playback plan is required.");
  if (typeof plan.itemId !== "string" || !plan.itemId || typeof plan.sourceId !== "string" || !plan.sourceId) throw new RemuxError("invalid_plan", "The remux plan requires itemId and sourceId.");
  if (plan.output?.protocol !== "file" || plan.output?.container !== "mp4") throw new RemuxError("unsupported_output", "This remux service currently supports MP4 file output only.");
};

export const createRemuxService = ({
  concurrency = 2, contentRoot, outputRoot, resolveSource,
  runner = runFfmpegRemux, runnerOptions, uuid = randomUUID
} = {}) => {
  if (!contentRoot || !outputRoot) throw new TypeError("contentRoot and outputRoot are required.");
  if (typeof resolveSource !== "function") throw new TypeError("resolveSource must be a function.");
  const semaphore = new Semaphore(concurrency);
  const sessions = new Map();
  let closed = false;

  const initialize = async () => { await rm(outputRoot, { recursive: true, force: true }); await mkdir(outputRoot, { recursive: true }); };
  const initialized = initialize();
  const createSession = async (plan, authorizationContext, { signal } = {}) => {
    validatePlan(plan);
    if (closed) throw new RemuxError("service_closed", "The remux service is shut down.");
    await initialized;
    const source = await resolveSource({ itemId: plan.itemId, sourceId: plan.sourceId }, authorizationContext);
    if (!source || source.id !== plan.sourceId || source.itemId !== plan.itemId || source.availability !== "available") {
      throw new RemuxError("missing_source", "The requested catalog source is missing or unavailable.");
    }
    const inputPath = await resolveRemuxSourcePath(contentRoot, source.path);
    const id = uuid();
    const directory = path.join(outputRoot, id);
    const outputPath = path.join(directory, "stream.mp4");
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const state = { id, itemId: plan.itemId, sourceId: plan.sourceId, status: "queued", outputPath: null, error: null };
    const session = {
      get id() { return id; },
      get status() { return state.status; },
      get outputPath() { return state.outputPath; },
      get error() { return state.error; },
      cancel: () => controller.abort(),
      cleanup: async () => { controller.abort(); try { await session.completion; } catch {} await rm(directory, { recursive: true, force: true }); sessions.delete(id); }
    };
    session.completion = semaphore.run(async () => {
      state.status = "running";
      await mkdir(directory, { recursive: false });
      try {
        if (controller.signal.aborted) throw new RemuxError("cancelled", "Remux was cancelled.");
        await runner(inputPath, outputPath, { ...runnerOptions, signal: controller.signal });
        state.status = "ready"; state.outputPath = outputPath;
        return session;
      } finally { signal?.removeEventListener("abort", forwardAbort); }
    }, controller.signal).catch(async (error) => {
      state.error = error; state.status = error?.code === "cancelled" ? "cancelled" : "failed";
      await rm(directory, { recursive: true, force: true });
      throw error;
    });
    sessions.set(id, session);
    return session;
  };
  const shutdown = async () => {
    closed = true;
    for (const session of sessions.values()) session.cancel();
    await Promise.allSettled([...sessions.values()].map((session) => session.completion));
    await rm(outputRoot, { recursive: true, force: true });
    sessions.clear();
  };
  return { createSession, getSession: (id) => sessions.get(id) ?? null, initialize: () => initialized, shutdown };
};
