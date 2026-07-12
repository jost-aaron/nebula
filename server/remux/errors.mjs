export class RemuxError extends Error {
  constructor(code, message, { cause, retryable = false, stderr = "" } = {}) {
    super(message, { cause });
    this.name = "RemuxError";
    this.code = code;
    this.retryable = retryable;
    this.stderr = stderr;
  }
}

export const remuxFailure = ({ code, error, stderr = "" }) => {
  if (error?.code === "ENOENT") return new RemuxError("ffmpeg_unavailable", "FFmpeg is unavailable.", { cause: error });
  return new RemuxError("ffmpeg_failed", `FFmpeg exited with code ${code}.`, { cause: error, stderr });
};
