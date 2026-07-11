import { spawn } from "node:child_process";
import { ProbeError, classifyProbeFailure } from "./errors.mjs";

export const FFPROBE_ARGUMENTS = Object.freeze([
  "-v", "error", "-show_format", "-show_streams", "-show_chapters", "-print_format", "json"
]);

export const runFfprobe = (inputPath, {
  binary = "ffprobe",
  maxOutputBytes = 4 * 1024 * 1024,
  timeoutMs = 15_000
} = {}) => new Promise((resolve, reject) => {
  const child = spawn(binary, [...FFPROBE_ARGUMENTS, "--", inputPath], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let settled = false;
  let exceeded = false;
  let timedOut = false;
  let timer;
  const finish = (action) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    action();
  };
  const collect = (target) => (chunk) => {
    if (exceeded) return;
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) {
      exceeded = true;
      child.kill("SIGKILL");
      return;
    }
    target.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  child.on("error", (error) => finish(() => reject(classifyProbeFailure({ error }))));
  child.on("close", (code, signal) => finish(() => {
    const errorText = Buffer.concat(stderr).toString("utf8");
    if (exceeded) return reject(new ProbeError("output_limit", "FFprobe exceeded its output limit.", { stderr: errorText }));
    if (timedOut) return reject(new ProbeError("timeout", "FFprobe timed out.", { retryable: true, stderr: errorText }));
    if (code !== 0) return reject(classifyProbeFailure({ code, stderr: errorText }));
    try {
      resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
    } catch (error) {
      reject(new ProbeError("invalid_output", "FFprobe returned invalid JSON.", { cause: error, stderr: errorText }));
    }
  }));
  timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  timer.unref?.();
});
