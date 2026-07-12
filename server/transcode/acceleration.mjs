import { spawn } from "node:child_process";

export const ACCELERATION_MODES = new Set(["disabled", "auto", "software-only", "prefer-vaapi", "require-vaapi", "prefer-nvenc", "require-nvenc", "prefer-videotoolbox", "require-videotoolbox"]);
const BACKENDS = Object.freeze({
  vaapi: { encoder: "h264_vaapi", deviceType: "vaapi", pixelFormat: "nv12", deviceRequired: true },
  nvenc: { encoder: "h264_nvenc", deviceType: "cuda", pixelFormat: "yuv420p", deviceRequired: false },
  videotoolbox: { encoder: "h264_videotoolbox", deviceType: "videotoolbox", pixelFormat: "nv12", deviceRequired: false }
});
const SAFE_REASONS = new Set(["disabled", "software_selected", "available", "encoder_missing", "device_unavailable", "self_test_failed", "probe_failed", "unsupported_codec", "required_backend_unavailable"]);

export const normalizeAccelerationMode = (value) => ACCELERATION_MODES.has(String(value ?? "").toLowerCase()) ? String(value).toLowerCase() : "software-only";
export const normalizeProbeOutput = (value) => {
  const encoders = new Set(String(value ?? "").split(/\r?\n/).map((line) => /^\s*[A-Z.]{6}\s+([a-zA-Z0-9_]+)\s/.exec(line)?.[1]).filter(Boolean));
  return Object.fromEntries(Object.entries(BACKENDS).map(([name, definition]) => [name, { ...definition, encoderDetected: encoders.has(definition.encoder) }]));
};
const safeReason = (reason) => SAFE_REASONS.has(reason) ? reason : "probe_failed";
const publicBackend = (name, value) => ({
  name, available: value?.available === true, encoderDetected: value?.encoderDetected === true,
  deviceDetected: value?.deviceDetected === true, selfTest: value?.selfTest === "passed" ? "passed" : value?.selfTest === "failed" ? "failed" : "not-run",
  reason: safeReason(value?.reason), codecs: ["h264"], pixelFormats: value?.pixelFormat ? [value.pixelFormat] : [], resolutionLimits: null
});

const execute = (binary, args, { timeoutMs = 5_000, spawnProcess = spawn } = {}) => new Promise((resolve) => {
  let output = ""; let settled = false;
  const child = spawnProcess(binary, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const finish = (result) => { if (settled) return; settled = true; clearTimeout(timeout); resolve(result); };
  const collect = (chunk) => { if (output.length < 256 * 1024) output += chunk.toString("utf8", 0, Math.max(0, 256 * 1024 - output.length)); };
  child.stdout?.on("data", collect); child.stderr?.on("data", collect);
  child.on("error", () => finish({ ok: false, output: "" }));
  child.on("close", (code) => finish({ ok: code === 0, output }));
  const timeout = setTimeout(() => { child.kill("SIGKILL"); finish({ ok: false, output: "" }); }, timeoutMs); timeout.unref?.();
});

export const createAccelerationProbe = ({ binary = "ffmpeg", accessDevice = async () => false, executeCommand = execute, platform = process.platform } = {}) => async () => {
  const encoderProbe = await executeCommand(binary, ["-hide_banner", "-encoders"], { timeoutMs: 5_000 });
  const normalized = normalizeProbeOutput(encoderProbe.output);
  const backends = {};
  for (const [name, definition] of Object.entries(normalized)) {
    let deviceAccessible = !definition.deviceRequired;
    if (name === "vaapi") deviceAccessible = await accessDevice("vaapi").catch(() => false);
    const candidate = encoderProbe.ok && definition.encoderDetected && deviceAccessible;
    let selfTest = "not-run";
    if (candidate) {
      const args = ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=size=128x72:rate=1:duration=1"];
      if (name === "vaapi") args.push("-vaapi_device", "/dev/dri/renderD128", "-vf", "format=nv12,hwupload");
      args.push("-frames:v", "1", "-c:v", definition.encoder, "-f", "null", "-");
      selfTest = (await executeCommand(binary, args, { timeoutMs: 8_000 })).ok ? "passed" : "failed";
    }
    const available = candidate && selfTest === "passed";
    const deviceDetected = definition.deviceRequired ? deviceAccessible : available;
    const reason = !encoderProbe.ok ? "probe_failed" : !definition.encoderDetected ? "encoder_missing" : !deviceAccessible ? "device_unavailable" : available ? "available" : "self_test_failed";
    backends[name] = publicBackend(name, { ...definition, available, deviceDetected, selfTest, reason });
  }
  return { backends, platform: platform === "linux" ? "linux" : "other" };
};

export const selectAcceleration = ({ capability, mode, videoCodec = "h264" }) => {
  const configuredMode = normalizeAccelerationMode(mode);
  if (videoCodec !== "h264") return { backend: "software", outcome: "software", reason: "unsupported_codec", required: false };
  if (["disabled", "software-only"].includes(configuredMode)) return { backend: "software", outcome: "software", reason: configuredMode === "disabled" ? "disabled" : "software_selected", required: false };
  const match = /^(prefer|require)-(.+)$/.exec(configuredMode);
  const required = match?.[1] === "require";
  const candidates = match ? [match[2]] : ["nvenc", "vaapi", "videotoolbox"];
  const selected = candidates.find((name) => capability?.backends?.[name]?.available === true);
  if (selected) return { backend: selected, outcome: "hardware", reason: "available", required };
  return { backend: "software", outcome: required ? "failed" : "fallback", reason: required ? "required_backend_unavailable" : "software_selected", required };
};

export const createAccelerationManager = ({ mode = "software-only", probe = createAccelerationProbe(), now = () => Date.now(), ttlMs = 5 * 60_000 } = {}) => {
  let configuredMode = normalizeAccelerationMode(mode); let cached = null; let probing = null;
  const refresh = async ({ force = false } = {}) => {
    if (!force && cached && now() - cached.probedAtMs < ttlMs) return cached;
    if (probing) return probing;
    probing = Promise.resolve().then(probe).catch(() => ({ backends: {}, platform: "other" })).then((value) => (cached = { ...value, probedAt: new Date(now()).toISOString(), probedAtMs: now() })).finally(() => { probing = null; });
    return probing;
  };
  const decide = async (plan) => selectAcceleration({ capability: await refresh(), mode: configuredMode, videoCodec: plan?.output?.videoCodec });
  const status = async () => { const capability = await refresh(); const decision = selectAcceleration({ capability, mode: configuredMode }); return { mode: configuredMode, selectedBackend: decision.backend, decision: decision.outcome, reason: decision.reason, lastProbeAt: capability.probedAt, backends: Object.values(capability.backends ?? {}).map((entry) => publicBackend(entry.name, entry)) }; };
  return { decide, refresh: () => refresh({ force: true }), setMode(value) { if (!ACCELERATION_MODES.has(String(value ?? "").toLowerCase())) throw Object.assign(new Error("Invalid acceleration mode."), { status: 400, code: "invalid_acceleration_mode", expose: true }); configuredMode = String(value).toLowerCase(); return configuredMode; }, status };
};

export const accelerationRunnerProfile = (backend) => backend === "vaapi"
  ? { backend, encoder: "h264_vaapi", inputArguments: ["-vaapi_device", "/dev/dri/renderD128"], videoFilter: "format=nv12,hwupload", pixelFormat: null, preset: null }
  : backend === "nvenc" ? { backend, encoder: "h264_nvenc", inputArguments: [], videoFilter: null, pixelFormat: "yuv420p", preset: "p4" }
    : backend === "videotoolbox" ? { backend, encoder: "h264_videotoolbox", inputArguments: [], videoFilter: null, pixelFormat: "nv12", preset: null }
      : { backend: "software", encoder: "libx264", inputArguments: [], videoFilter: null, pixelFormat: "yuv420p", preset: "veryfast" };
