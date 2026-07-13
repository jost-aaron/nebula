import { spawn } from "node:child_process";
import path from "node:path";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { TranscodeError, transcodeFailure } from "./errors.mjs";

const boundedDimension = (value) => Number.isFinite(value) && value >= 2 ? Math.floor(value / 2) * 2 : null;

export const buildTranscodeArguments = (inputPath, outputDirectory, {
  maxBitrate = null, maxHeight = null, maxWidth = null, profile = {}, renditionProfile = null, segmentDuration = 6, subtitleFilter = null
} = {}) => {
  const rate = Number.isFinite(renditionProfile?.totalBitrate) ? renditionProfile.totalBitrate : Number.isFinite(maxBitrate) ? Math.floor(maxBitrate) : null;
  const elementaryBudget = rate === null ? null : Math.floor(rate * 0.95);
  const audioRate = Number.isFinite(renditionProfile?.audioBitrate) ? renditionProfile.audioBitrate
    : elementaryBudget === null ? null : Math.max(16_000, Math.min(128_000, Math.floor(elementaryBudget * 0.12)));
  const videoRate = Number.isFinite(renditionProfile?.videoBitrate) ? renditionProfile.videoBitrate
    : elementaryBudget === null ? null : Math.max(16_000, elementaryBudget - audioRate);
  const width = boundedDimension(maxWidth);
  const height = boundedDimension(maxHeight);
  const scaleFilter = width && height ? `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease:force_divisible_by=2` : null;
  const videoFilter = [subtitleFilter, scaleFilter, profile.videoFilter].filter(Boolean).join(",");
  return [
    "-nostdin", "-v", "error", "-n", ...(Array.isArray(profile.inputArguments) ? profile.inputArguments : []), "-i", inputPath,
    "-map", "0:v:0?", "-map", "0:a:0?", "-sn",
    "-c:v", profile.encoder ?? "libx264", ...(profile.preset ? ["-preset", profile.preset] : []),
    ...(videoFilter ? ["-vf", videoFilter] : []),
    ...(profile.pixelFormat === null ? [] : ["-pix_fmt", profile.pixelFormat ?? "yuv420p"]),
    ...(videoRate === null ? [] : ["-b:v", String(videoRate), "-maxrate", String(videoRate), "-bufsize", String(videoRate * 2)]),
    ...(Number.isFinite(renditionProfile?.maxFrameRate) ? ["-fpsmax", String(renditionProfile.maxFrameRate)] : []),
    "-force_key_frames", `expr:gte(t,n_forced*${segmentDuration})`,
    "-c:a", "aac", "-ac", String(renditionProfile?.audioChannels ?? 2), ...(audioRate === null ? [] : ["-b:a", String(audioRate)]),
    "-f", "hls", "-hls_time", String(segmentDuration), "-hls_list_size", "0",
    "-hls_playlist_type", "event", "-hls_segment_type", "mpegts", "-hls_flags", "independent_segments+temp_file",
    "-hls_segment_filename", path.join(outputDirectory, "segment-%05d.ts"),
    "--", path.join(outputDirectory, "media.m3u8")
  ];
};

const inspectOutput = async (outputDirectory) => {
  let bytes = 0; let mediaPlaylist = false; let segments = 0;
  for (const entry of await readdir(outputDirectory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const details = await stat(path.join(outputDirectory, entry.name)).catch(() => null);
    if (!details) continue;
    bytes += details.size;
    if (/^segment-\d{5}\.ts$/.test(entry.name)) segments += 1;
    if (entry.name === "media.m3u8") mediaPlaylist = true;
  }
  return { bytes, mediaPlaylist, segments };
};

export const runFfmpegTranscode = async (inputPath, outputDirectory, {
  binary = "ffmpeg", maxOutputBytes = 64 * 1024 * 1024 * 1024, maxSegments = 20_000,
  maxBitrate = null, maxHeight = null, maxStderrBytes = 256 * 1024, maxWidth = null,
  onReady = null, outputCheckMs = 250, profile, renditionProfile = null, segmentDuration = 6, subtitleFilter = null,
  signal, timeoutMs = 2 * 60 * 60 * 1000
} = {}) => {
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) throw new RangeError("maxOutputBytes must be positive.");
  if (!Number.isInteger(maxSegments) || maxSegments < 1) throw new RangeError("maxSegments must be a positive integer.");
  if (!Number.isFinite(segmentDuration) || segmentDuration <= 0) throw new RangeError("segmentDuration must be positive.");

  const width = boundedDimension(maxWidth); const height = boundedDimension(maxHeight);
  const masterPlaylist = path.join(outputDirectory, "master.m3u8");
  const resolution = width && height ? `,RESOLUTION=${width}x${height}` : "";
  const advertisedBitrate = renditionProfile?.totalBitrate ?? maxBitrate ?? 5_000_000;
  await writeFile(masterPlaylist, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=${advertisedBitrate}${resolution},CODECS="avc1.42e01e,mp4a.40.2"\nmedia.m3u8\n`, { flag: "wx" })
    .catch((error) => { throw new TranscodeError("output_failed", "The HLS master playlist could not be created.", { cause: error }); });

  return new Promise((resolve, reject) => {
    const child = spawn(binary, buildTranscodeArguments(inputPath, outputDirectory, { maxBitrate, maxHeight: height, maxWidth: width, profile, renditionProfile, segmentDuration, subtitleFilter }), {
      shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true
    });
    const stderr = []; let stderrBytes = 0; let settled = false; let outcome = null; let playable = false;
    const markPlayable = (output) => {
      if (settled || playable || !output.mediaPlaylist || output.segments < 1) return;
      playable = true;
      try { onReady?.(); } catch {}
    };
    const rejectCleanly = (error) => rm(masterPlaylist, { force: true }).then(() => reject(error), () => reject(error));
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
    child.on("error", (error) => finish(() => rejectCleanly(transcodeFailure({ error }))));
    child.on("close", async (code) => {
      if (settled) return;
      if (!outcome) {
        const output = await inspectOutput(outputDirectory);
        markPlayable(output);
        if (output.bytes > maxOutputBytes) outcome = "output_limit";
        else if (output.segments > maxSegments) outcome = "segment_limit";
      }
      const errorText = Buffer.concat(stderr).toString("utf8");
      if (outcome === "cancelled") return finish(() => rejectCleanly(new TranscodeError("cancelled", "Transcode was cancelled.", { stderr: errorText })));
      if (outcome === "timeout") return finish(() => rejectCleanly(new TranscodeError("timeout", "Transcode timed out.", { retryable: true, stderr: errorText })));
      if (outcome === "output_limit") return finish(() => rejectCleanly(new TranscodeError("output_limit", "Transcode exceeded its output limit.", { stderr: errorText })));
      if (outcome === "segment_limit") return finish(() => rejectCleanly(new TranscodeError("segment_limit", "Transcode exceeded its segment limit.", { stderr: errorText })));
      if (code !== 0) return finish(() => rejectCleanly(transcodeFailure({ code, stderr: errorText })));
      if (!playable) return finish(() => rejectCleanly(new TranscodeError("output_failed", "FFmpeg did not publish a playable HLS segment.", { stderr: errorText })));
      finish(() => resolve({ masterPlaylist, mediaPlaylist: path.join(outputDirectory, "media.m3u8") }));
    });
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => stop("timeout"), timeoutMs); timeout.unref?.();
    const outputCheck = setInterval(async () => {
      const output = await inspectOutput(outputDirectory);
      markPlayable(output);
      if (output.bytes > maxOutputBytes) stop("output_limit");
      else if (output.segments > maxSegments) stop("segment_limit");
    }, outputCheckMs); outputCheck.unref?.();
  });
};
