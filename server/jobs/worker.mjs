const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class JobCancelledError extends Error {
  constructor() {
    super("Job cancellation was requested.");
    this.code = "JOB_CANCELLED";
  }
}

export const createJobsWorker = ({ repository, handlers, concurrency = 2, retryDelay = (attempt) => 1_000 * (2 ** (attempt - 1)), now = () => Date.now() } = {}) => {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("Worker concurrency must be a positive integer.");
  if (!repository || typeof repository.claimNext !== "function") throw new TypeError("A jobs repository is required.");
  let stopping = false;
  let loops = [];

  const runJob = async (job) => {
    const handler = handlers?.[job.type];
    if (typeof handler !== "function") {
      repository.failAttempt(job.id, { code: "NO_HANDLER", message: `No handler is registered for ${job.type}.`, retryAt: now() });
      return;
    }
    const throwIfCancelled = () => {
      if (repository.isCancellationRequested(job.id)) throw new JobCancelledError();
    };
    const context = {
      enqueue: (request) => repository.enqueue(request),
      isCancellationRequested: () => repository.isCancellationRequested(job.id),
      reportProgress: (progress, currentStage = null) => {
        if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new RangeError("Job progress must be between 0 and 1.");
        throwIfCancelled();
        return repository.updateProgress(job.id, { progress, currentStage });
      },
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
    repository.recoverInterrupted();
    loops = Array.from({ length: concurrency }, async () => {
      while (!stopping) {
        const job = repository.claimNext();
        if (job) await runJob(job);
        else await sleep(pollIntervalMs);
      }
    });
  };

  const stop = async () => {
    stopping = true;
    await Promise.all(loops);
    loops = [];
  };

  return { recover: repository.recoverInterrupted, runOnce, start, stop };
};
