import { spawn } from "node:child_process";

export const buildArtworkArguments = (inputPath, outputPath, { height = 480, seekSeconds = 12, width = 320 } = {}) => [
  "-nostdin", "-v", "error", "-ss", String(seekSeconds), "-i", inputPath,
  "-map", "0:v:0", "-frames:v", "1",
  "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
  "-q:v", "4", "-f", "image2", "-y", "--", outputPath
];

export const runArtworkCapture = (inputPath, outputPath, {
  binary = "ffmpeg", height = 480, maxStderrBytes = 128 * 1024, seekSeconds = 12,
  timeoutMs = 45_000, width = 320
} = {}) => new Promise((resolve, reject) => {
  const child = spawn(binary, buildArtworkArguments(inputPath, outputPath, { height, seekSeconds, width }), {
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
  const stderr = [];
  let stderrBytes = 0;
  let settled = false;
  let timedOut = false;
  const finish = (action) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    action();
  };
  child.stderr.on("data", (chunk) => {
    if (stderrBytes >= maxStderrBytes) return;
    const accepted = chunk.subarray(0, maxStderrBytes - stderrBytes);
    stderr.push(accepted);
    stderrBytes += accepted.length;
  });
  child.on("error", (error) => finish(() => reject(Object.assign(new Error("FFmpeg could not start artwork capture."), {
    cause: error, code: "ARTWORK_CAPTURE_START_FAILED"
  }))));
  child.on("close", (code) => finish(() => {
    const detail = Buffer.concat(stderr).toString("utf8").trim();
    if (timedOut) return reject(Object.assign(new Error("Artwork capture timed out."), { code: "ARTWORK_CAPTURE_TIMEOUT" }));
    if (code !== 0) return reject(Object.assign(new Error(detail || "FFmpeg could not capture an artwork frame."), {
      code: "ARTWORK_CAPTURE_FAILED"
    }));
    resolve({ height, width });
  }));
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref?.();
});

