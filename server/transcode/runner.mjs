import { spawn } from "node:child_process";
import path from "node:path";
import { readdir, stat, writeFile } from "node:fs/promises";
import { TranscodeError, transcodeFailure } from "./errors.mjs";

export const buildTranscodeArguments = (inputPath, outputDirectory, { maxBitrate = null, segmentDuration = 6 } = {}) => {
  const rate = Number.isFinite(maxBitrate) ? Math.floor(maxBitrate) : null;
  const elementaryBudget = rate === null ? null : Math.floor(rate * 0.95);
  const audioRate = elementaryBudget === null ? null : Math.max(16_000, Math.min(128_000, Math.floor(elementaryBudget * 0.12)));
  const videoRate = elementaryBudget === null ? null : Math.max(16_000, elementaryBudget - audioRate);
  return [
    "-nostdin", "-v", "error", "-n", "-i", inputPath,
    "-map", "0:v:0?", "-map", "0:a:0?", "-sn",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    ...(videoRate === null ? [] : ["-b:v", String(videoRate), "-maxrate", String(videoRate), "-bufsize", String(videoRate * 2)]),
    "-c:a", "aac", "-ac", "2", ...(audioRate === null ? [] : ["-b:a", String(audioRate)]),
    "-f", "hls", "-hls_time", String(segmentDuration), "-hls_list_size", "0",
    "-hls_playlist_type", "vod", "-hls_segment_type", "mpegts",
    "-hls_segment_filename", path.join(outputDirectory, "segment-%05d.ts"),
    "--", path.join(outputDirectory, "media.m3u8")
  ];
};

const inspectOutput = async (outputDirectory) => {
  let bytes = 0; let segments = 0;
  for (const entry of await readdir(outputDirectory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    bytes += (await stat(path.join(outputDirectory, entry.name))).size;
    if (/^segment-\d{5}\.ts$/.test(entry.name)) segments += 1;
  }
  return { bytes, segments };
};

export const runFfmpegTranscode = (inputPath, outputDirectory, {
  binary = "ffmpeg", maxOutputBytes = 64 * 1024 * 1024 * 1024, maxSegments = 20_000,
  maxBitrate = null, maxStderrBytes = 256 * 1024, outputCheckMs = 250, segmentDuration = 6,
  signal, timeoutMs = 2 * 60 * 60 * 1000
} = {}) => new Promise((resolve, reject) => {
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) throw new RangeError("maxOutputBytes must be positive.");
  if (!Number.isInteger(maxSegments) || maxSegments < 1) throw new RangeError("maxSegments must be a positive integer.");
  if (!Number.isFinite(segmentDuration) || segmentDuration <= 0) throw new RangeError("segmentDuration must be positive.");
  const child = spawn(binary, buildTranscodeArguments(inputPath, outputDirectory, { maxBitrate, segmentDuration }), {
    shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true
  });
  const stderr = []; let stderrBytes = 0; let settled = false; let outcome = null;
  const finish = (action) => {
    if (settled) return; settled = true; clearTimeout(timeout); clearInterval(outputCheck);
    signal?.removeEventListener("abort", abort); action();
  };
  const stop = (next) => { if (!outcome) { outcome = next; child.kill("SIGKILL"); } };
  const abort = () => stop("cancelled");
  child.stderr.on("data", (chunk) => {
    if (stderrBytes >= maxStderrBytes) return;
    const accepted = chunk.subarray(0, maxStderrBytes - stderrBytes); stderr.push(accepted); stderrBytes += accepted.length;
  });
  child.on("error", (error) => finish(() => reject(transcodeFailure({ error }))));
  child.on("close", async (code) => {
    if (!outcome) {
      const output = await inspectOutput(outputDirectory);
      if (output.bytes > maxOutputBytes) outcome = "output_limit";
      else if (output.segments > maxSegments) outcome = "segment_limit";
    }
    const errorText = Buffer.concat(stderr).toString("utf8");
    if (outcome === "cancelled") return finish(() => reject(new TranscodeError("cancelled", "Transcode was cancelled.", { stderr: errorText })));
    if (outcome === "timeout") return finish(() => reject(new TranscodeError("timeout", "Transcode timed out.", { retryable: true, stderr: errorText })));
    if (outcome === "output_limit") return finish(() => reject(new TranscodeError("output_limit", "Transcode exceeded its output limit.", { stderr: errorText })));
    if (outcome === "segment_limit") return finish(() => reject(new TranscodeError("segment_limit", "Transcode exceeded its segment limit.", { stderr: errorText })));
    if (code !== 0) return finish(() => reject(transcodeFailure({ code, stderr: errorText })));
    writeFile(path.join(outputDirectory, "master.m3u8"), `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=${maxBitrate ?? 5_000_000},CODECS=\"avc1.42e01e,mp4a.40.2\"\nmedia.m3u8\n`, { flag: "wx" })
      .then(() => finish(() => resolve({ masterPlaylist: path.join(outputDirectory, "master.m3u8"), mediaPlaylist: path.join(outputDirectory, "media.m3u8") })))
      .catch((error) => finish(() => reject(new TranscodeError("output_failed", "The HLS master playlist could not be created.", { cause: error }))));
  });
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => stop("timeout"), timeoutMs); timeout.unref?.();
  const outputCheck = setInterval(async () => {
    const output = await inspectOutput(outputDirectory);
    if (output.bytes > maxOutputBytes) stop("output_limit");
    else if (output.segments > maxSegments) stop("segment_limit");
  }, outputCheckMs); outputCheck.unref?.();
});
