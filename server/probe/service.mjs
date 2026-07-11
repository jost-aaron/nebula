import { normalizeFfprobe } from "./normalize.mjs";
import { resolveProbePath } from "./path.mjs";
import { runFfprobe } from "./runner.mjs";
import { ProbeError } from "./errors.mjs";

class Semaphore {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new RangeError("concurrency must be between 1 and 32.");
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
  }

  async run(action) {
    if (this.active >= this.limit) await new Promise((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await action();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export const createProbeService = ({
  catalogWriter,
  concurrency = 2,
  contentRoot,
  resolveSource,
  runner = runFfprobe,
  runnerOptions
}) => {
  if (!contentRoot) throw new TypeError("contentRoot is required.");
  if (typeof resolveSource !== "function") throw new TypeError("resolveSource must be a function.");
  if (typeof catalogWriter?.putProbeResult !== "function") throw new TypeError("catalogWriter.putProbeResult must be a function.");
  const semaphore = new Semaphore(concurrency);

  return {
    probeSource: (sourceId) => semaphore.run(async () => {
      const source = await resolveSource(sourceId);
      if (!source || source.availability === "missing") {
        throw new ProbeError("missing", `Unknown or missing catalog source: ${sourceId}`, { retryable: true });
      }
      const absolutePath = await resolveProbePath(contentRoot, source.path);
      const result = normalizeFfprobe(await runner(absolutePath, runnerOptions));
      await catalogWriter.putProbeResult(sourceId, result);
      return result;
    })
  };
};
