import { ProxyAgent } from "undici";
import { validateClusterEndpoint } from "./protocol.mjs";
import { validateClusterProxyUrl } from "./client.mjs";

export const CLUSTER_DELIVERY_PATH = "/api/shard/v1/playback/delivery";
export const CLUSTER_DELIVERY_STATUS_PATH = "/api/shard/v1/playback/delivery/status";
export const CLUSTER_DELIVERY_CANCEL_PATH = "/api/shard/v1/playback/delivery/cancel";
const error = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });
const readJson = async (response, limit, signal) => {
  const body = response.body;
  if (!body) throw error(502, "invalid_shard_response", "The shard delivery response was invalid.");
  const reader = body.getReader();
  const chunks = []; let size = 0; let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
    rejectAbort(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw signal.reason;
      if (done) break;
      const bytes = Buffer.from(value); size += bytes.length;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw error(502, "invalid_shard_response", "The shard delivery response exceeded its size limit.");
      }
      chunks.push(bytes);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw error(502, "invalid_shard_response", "The shard delivery response was invalid."); }
};
const validateResult = (value, operation) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error(502, "invalid_shard_response", "The shard delivery response shape was invalid.");
  if (operation === "cancel") {
    if (Object.keys(value).sort().join(",") !== "cancelled,deliveryId" || value.cancelled !== true) throw error(502, "invalid_shard_response", "The shard cancellation response shape was invalid.");
    return value;
  }
  const outputKeys = new Set(["audioCodec", "bitrate", "container", "height", "profileId", "protocol", "subtitle", "videoCodec", "width"]);
  const nullableCodec = (entry) => entry === null || (typeof entry === "string" && /^[a-z0-9_,.-]{1,64}$/.test(entry));
  const nullableDimension = (entry) => entry === undefined || entry === null || (Number.isSafeInteger(entry) && entry > 0 && entry <= 16_384);
  const subtitle = value.output?.subtitle;
  const validSubtitle = subtitle === undefined || subtitle === null || (subtitle && typeof subtitle === "object" && !Array.isArray(subtitle)
    && Object.keys(subtitle).sort().join(",") === "delivery,format,id"
    && typeof subtitle.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(subtitle.id)
    && new Set(["burn-in", "embedded", "sidecar"]).has(subtitle.delivery)
    && (subtitle.format === null || (typeof subtitle.format === "string" && /^[a-z0-9_.-]{1,32}$/.test(subtitle.format))));
  const validReason = (reason) => reason && typeof reason === "object" && !Array.isArray(reason)
    && Object.keys(reason).every((key) => new Set(["code", "message", "streamIndex"]).has(key))
    && typeof reason.code === "string" && reason.code.length <= 96
    && typeof reason.message === "string" && reason.message.length <= 512
    && (reason.streamIndex === null || (Number.isSafeInteger(reason.streamIndex) && reason.streamIndex >= 0));
  if (Object.keys(value).sort().join(",") !== "decision,deliveryId,output,reasons,status"
    || typeof value.deliveryId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value.deliveryId)
    || !new Set(["direct-play", "remux", "transcode"]).has(value.decision)
    || !new Set(["queued", "running", "ready", "failed", "cancelled", "expired"]).has(value.status)
    || !value.output || typeof value.output !== "object" || Array.isArray(value.output)
    || Object.keys(value.output).some((key) => !outputKeys.has(key))
    || !nullableCodec(value.output.audioCodec) || !nullableCodec(value.output.videoCodec) || !nullableCodec(value.output.container)
    || (value.output.bitrate !== null && (!Number.isSafeInteger(value.output.bitrate) || value.output.bitrate < 0 || value.output.bitrate > 1_000_000_000_000))
    || !nullableDimension(value.output.width) || !nullableDimension(value.output.height)
    || (value.output.profileId !== undefined && value.output.profileId !== null && !new Set(["240p", "360p", "480p", "720p", "1080p"]).has(value.output.profileId))
    || !validSubtitle
    || !new Set(["file", "hls"]).has(value.output.protocol)
    || !Array.isArray(value.reasons) || value.reasons.length > 32 || !value.reasons.every(validReason)) {
    throw error(502, "invalid_shard_response", "The shard delivery response shape was invalid.");
  }
  return value;
};

export const createClusterDeliveryClient = ({
  allowDirect = false, fetcher = null, maxResponseBytes = 64 * 1024,
  proxyUrl = process.env.NEBULA_CLUSTER_HTTP_PROXY, timeoutMs = 10_000, trust,
  clearTimeoutFn = clearTimeout, setTimeoutFn = setTimeout
} = {}) => {
  if (!trust) throw new TypeError("Cluster trust is required.");
  const proxy = validateClusterProxyUrl(proxyUrl);
  if (!proxy && !allowDirect) throw error(500, "cluster_proxy_required", "The fixed Tailscale userspace proxy is required.");
  const dispatcher = !fetcher && proxy ? new ProxyAgent(proxy) : null;
  const transport = fetcher ?? ((url, options) => fetch(url, { ...options, ...(dispatcher ? { dispatcher } : {}) }));
  const call = async (endpoint, path, payload, operation) => {
    const origin = validateClusterEndpoint(endpoint);
    const envelope = trust.signRequest({ body: payload, method: "POST", path });
    const controller = new AbortController();
    const timer = setTimeoutFn(() => controller.abort(), timeoutMs); timer.unref?.();
    let response; let value;
    try {
      response = await transport(`${origin}${path}`, {
        body: JSON.stringify({ envelope, payload }), headers: { "content-type": "application/json" },
        method: "POST", redirect: "error", signal: controller.signal
      });
      value = await readJson(response, maxResponseBytes, controller.signal);
    } catch (cause) {
      if (cause?.code === "invalid_shard_response") throw cause;
      throw error(502, "shard_unreachable", "The shard delivery request failed.");
    } finally { clearTimeoutFn(timer); }
    if (!response.ok) throw error(response.status >= 400 && response.status < 500 ? response.status : 502, value?.code ?? "shard_delivery_failed", "The shard rejected the delivery request.");
    if (!value || Object.keys(value).sort().join(",") !== "envelope,payload") throw error(502, "invalid_shard_response", "The shard delivery response was not signed.");
    const peer = trust.verifyRequest(value.envelope, value.payload, { method: "POST", path });
    if (validateClusterEndpoint(peer.endpoint) !== origin) throw error(409, "endpoint_mismatch", "The shard delivery response came from another endpoint.");
    return validateResult(value.payload, operation);
  };
  return {
    cancel: (endpoint, payload) => call(endpoint, CLUSTER_DELIVERY_CANCEL_PATH, payload, "cancel"),
    create: (endpoint, payload) => call(endpoint, CLUSTER_DELIVERY_PATH, payload, "create"),
    get: (endpoint, payload) => call(endpoint, CLUSTER_DELIVERY_STATUS_PATH, payload, "get")
  };
};
