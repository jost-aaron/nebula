export class ProbeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ProbeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.stderr = options.stderr ?? "";
  }
}

export const classifyProbeFailure = ({ code, error, stderr = "" }) => {
  if (error?.code === "ENOENT") return new ProbeError("ffprobe_unavailable", "FFprobe is not available.", { cause: error });
  const detail = stderr.trim();
  if (/no such file or directory/i.test(detail)) return new ProbeError("missing", "Media source is missing.", { stderr: detail });
  if (/moov atom not found|invalid data found|end of file|error reading header|could not find codec parameters/i.test(detail)) {
    return new ProbeError("partial_or_corrupt", "Media source is incomplete or corrupt.", { retryable: true, stderr: detail });
  }
  if (/unsupported|not implemented|unknown format/i.test(detail)) return new ProbeError("unsupported", "Media source format is unsupported.", { stderr: detail });
  return new ProbeError("probe_failed", `FFprobe exited with code ${code ?? "unknown"}.`, { stderr: detail });
};
