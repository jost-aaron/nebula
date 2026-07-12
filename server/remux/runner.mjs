import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { RemuxError, remuxFailure } from "./errors.mjs";

export const buildRemuxArguments = (inputPath, outputPath) => [
  "-nostdin", "-v", "error", "-n", "-i", inputPath,
  "-map", "0:v?", "-map", "0:a?", "-c", "copy", "-sn", "--", outputPath
];

export const runFfmpegRemux = (inputPath, outputPath, {
  binary = "ffmpeg",
  maxOutputBytes = 64 * 1024 * 1024 * 1024,
  maxStderrBytes = 256 * 1024,
  signal,
  timeoutMs = 30 * 60 * 1000,
  outputCheckMs = 250
} = {}) => new Promise((resolve, reject) => {
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) throw new RangeError("maxOutputBytes must be positive.");
  const child = spawn(binary, buildRemuxArguments(inputPath, outputPath), {
    shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true
  });
  const stderr = [];
  let stderrBytes = 0;
  let settled = false;
  let outcome = null;
  const finish = (action) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearInterval(outputCheck);
    signal?.removeEventListener("abort", abort);
    action();
  };
  const stop = (nextOutcome) => {
    if (outcome) return;
    outcome = nextOutcome;
    child.kill("SIGKILL");
  };
  const abort = () => stop("cancelled");
  child.stderr.on("data", (chunk) => {
    if (stderrBytes >= maxStderrBytes) return;
    const accepted = chunk.subarray(0, maxStderrBytes - stderrBytes);
    stderr.push(accepted);
    stderrBytes += accepted.length;
  });
  child.on("error", (error) => finish(() => reject(remuxFailure({ error }))));
  child.on("close", async (code) => {
    if (!outcome) {
      try { if ((await stat(outputPath)).size > maxOutputBytes) outcome = "output_limit"; } catch {}
    }
    finish(() => {
    const errorText = Buffer.concat(stderr).toString("utf8");
    if (outcome === "cancelled") return reject(new RemuxError("cancelled", "Remux was cancelled.", { stderr: errorText }));
    if (outcome === "timeout") return reject(new RemuxError("timeout", "Remux timed out.", { retryable: true, stderr: errorText }));
    if (outcome === "output_limit") return reject(new RemuxError("output_limit", "Remux exceeded its output limit.", { stderr: errorText }));
    if (code !== 0) return reject(remuxFailure({ code, stderr: errorText }));
    resolve({ outputPath });
    });
  });
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => stop("timeout"), timeoutMs);
  timeout.unref?.();
  const outputCheck = setInterval(async () => {
    try { if ((await stat(outputPath)).size > maxOutputBytes) stop("output_limit"); } catch {}
  }, outputCheckMs);
  outputCheck.unref?.();
});
