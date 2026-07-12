export class TranscodeError extends Error {
  constructor(code, message, { cause, retryable = false, stderr = "" } = {}) {
    super(message, { cause });
    this.name = "TranscodeError";
    this.code = code;
    this.retryable = retryable;
    this.stderr = stderr;
  }
}

export const transcodeFailure = ({ code, error, stderr = "" }) => {
  if (error?.code === "ENOENT") return new TranscodeError("ffmpeg_unavailable", "FFmpeg is unavailable.", { cause: error });
  return new TranscodeError("ffmpeg_failed", `FFmpeg exited with code ${code}.`, { cause: error, stderr });
};
