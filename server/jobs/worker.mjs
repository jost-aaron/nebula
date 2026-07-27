const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class JobCancelledError extends Error {
  constructor() {
    super("Job cancellation was requested.");
    this.code = "JOB_CANCELLED";
  }
}

export const createJobsWorker = ({
  repository,
  handlers,
  cancellationPollIntervalMs = 250,
  concurrency = 2,
  heartbeatIntervalMs = 5_000,
  retryDelay = (attempt) => 1_000 * (2 ** (attempt - 1)),
  now = () => Date.now()
} = {}) => {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("Worker concurrency must be a positive integer.");
  if (!Number.isFinite(cancellationPollIntervalMs) || cancellationPollIntervalMs < 50) throw new TypeError("Worker cancellation poll interval must be at least 50 milliseconds.");
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs < 100) throw new TypeError("Worker heartbeat interval must be at least 100 milliseconds.");
  if (!repository || typeof repository.claimNext !== "function") throw new TypeError("A jobs repository is required.");
  let stopping = false;
  let loops = [];
  let heartbeatTimer = null;
  let cancellationTimer = null;
  const activeControllers = new Map();
  const snapshot = {
    active: 0,
    heartbeatAt: now(),
    running: false
  };

  const heartbeat = () => {
    snapshot.heartbeatAt = now();
  };

  const runJob = async (job) => {
    snapshot.active += 1;
    heartbeat();
    const controller = new AbortController();
    activeControllers.set(job.id, controller);
    const handler = handlers?.[job.type];
    if (typeof handler !== "function") {
      repository.failAttempt(job.id, { code: "NO_HANDLER", message: `No handler is registered for ${job.type}.`, retryAt: now() });
      activeControllers.delete(job.id);
      snapshot.active = Math.max(0, snapshot.active - 1);
      heartbeat();
      return;
    }
    const throwIfCancelled = () => {
      if (controller.signal.aborted || repository.isCancellationRequested(job.id)) throw new JobCancelledError();
    };
    const context = {
      enqueue: (request) => repository.enqueue(request),
      isCancellationRequested: () => controller.signal.aborted || repository.isCancellationRequested(job.id),
      reportProgress: (progress, currentStage = null) => {
        if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new RangeError("Job progress must be between 0 and 1.");
        throwIfCancelled();
        heartbeat();
        return repository.updateProgress(job.id, { progress, currentStage });
      },
      signal: controller.signal,
      throwIfCancelled
    };
    try {
      throwIfCancelled();
      const result = await handler(job, context);
      throwIfCancelled();
      repository.succeed(job.id, result ?? null);
    } catch (error) {
      if (error instanceof JobCancelledError || repository.isCancellationRequested(job.id)) repository.cancelRunning(job.id);
      else repository.failAttempt(job.id, {
        code: typeof error.code === "string" ? error.code : "JOB_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryAt: now() + retryDelay(job.attempt)
      });
    } finally {
      activeControllers.delete(job.id);
      snapshot.active = Math.max(0, snapshot.active - 1);
      heartbeat();
    }
  };

  const runOnce = async () => {
    const claimed = [];
    while (claimed.length < concurrency) {
      const job = repository.claimNext();
      if (!job) break;
      claimed.push(job);
    }
    await Promise.all(claimed.map(runJob));
    return claimed.length;
  };

  const start = ({ pollIntervalMs = 250 } = {}) => {
    if (loops.length) return;
    stopping = false;
    snapshot.running = true;
    heartbeat();
    heartbeatTimer = setInterval(heartbeat, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    cancellationTimer = setInterval(() => {
      for (const [jobId, controller] of activeControllers) {
        if (repository.isCancellationRequested(jobId)) controller.abort(new JobCancelledError());
      }
    }, cancellationPollIntervalMs);
    cancellationTimer.unref?.();
    repository.recoverInterrupted();
    loops = Array.from({ length: concurrency }, (_, workerIndex) => (async () => {
      // With at least two workers, keep one admission lane available for
      // latency-sensitive, user-requested rendition work. Maintenance cannot
      // consume every worker, while ten-minute aging in the repository still
      // prevents starvation within each lane.
      const lane = concurrency > 1 && workerIndex === concurrency - 1 ? "interactive" : "any";
      while (!stopping) {
        heartbeat();
        const job = repository.claimNext({ lane });
        if (job) await runJob(job);
        else await sleep(pollIntervalMs);
      }
    })());
  };

  const stop = async ({ abortAfterMs = 20_000, drainTimeoutMs = 30_000 } = {}) => {
    if (!Number.isFinite(abortAfterMs) || abortAfterMs < 0) throw new TypeError("abortAfterMs must be a non-negative number.");
    if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs <= 0 || drainTimeoutMs < abortAfterMs) {
      throw new TypeError("drainTimeoutMs must be positive and not less than abortAfterMs.");
    }
    stopping = true;
    const abortTimer = setTimeout(() => {
      for (const controller of activeControllers.values()) controller.abort(new JobCancelledError());
    }, abortAfterMs);
    abortTimer.unref?.();
    let timeout = null;
    try {
      await Promise.race([
        Promise.all(loops),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Object.assign(new Error("Jobs worker did not drain before shutdown deadline."), { code: "WORKER_DRAIN_TIMEOUT" })), drainTimeoutMs);
          timeout.unref?.();
        })
      ]);
      loops = [];
    } finally {
      clearTimeout(abortTimer);
      if (timeout) clearTimeout(timeout);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (cancellationTimer) clearInterval(cancellationTimer);
      heartbeatTimer = null;
      cancellationTimer = null;
      snapshot.running = false;
      heartbeat();
    }
  };

  return {
    recover: repository.recoverInterrupted,
    runOnce,
    snapshot: () => ({ ...snapshot }),
    start,
    stop
  };
};
