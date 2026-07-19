import { lookup as dnsLookup } from "node:dns/promises";
import { ProxyAgent } from "undici";
import { validateClusterEndpoint, validateClusterPairingResponse } from "./protocol.mjs";

const error = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });
const tailscaleIpv4 = (address) => {
  const parts = String(address).split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
};
const tailscaleIpv6 = (address) => String(address).toLowerCase().startsWith("fd7a:115c:a1e0:");
export const isTailscaleAddress = (address) => tailscaleIpv4(address) || tailscaleIpv6(address);

export const validateClusterProxyUrl = (value) => {
  if (value === undefined || value === null || value === "") return null;
  let proxy;
  try { proxy = new URL(value); } catch { throw error(500, "invalid_cluster_proxy", "The cluster proxy configuration is invalid."); }
  if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1" || proxy.port !== "1055" || proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash) {
    throw error(500, "invalid_cluster_proxy", "The cluster proxy must be the fixed local Tailscale userspace proxy.");
  }
  return proxy.origin;
};

const readBounded = async (response, limit) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) {
      await response.body?.cancel?.().catch?.(() => {});
      throw error(502, "invalid_shard_response", "The shard pairing response was too large.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
};

export const createClusterPairingClient = ({ allowDirect = false, fetcher = null, lookup = dnsLookup, timeoutMs = 10_000, maxResponseBytes = 64 * 1024, proxyUrl = process.env.NEBULA_CLUSTER_HTTP_PROXY } = {}) => {
  const proxy = validateClusterProxyUrl(proxyUrl);
  if (!proxy && !allowDirect) throw error(500, "cluster_proxy_required", "The fixed Tailscale userspace proxy is required.");
  const dispatcher = !fetcher && proxy ? new ProxyAgent(proxy) : null;
  const transport = fetcher ?? ((url, options) => fetch(url, { ...options, ...(dispatcher ? { dispatcher } : {}) }));
  return ({
  async pair({ endpoint, pairingCode, localIdentity }) {
    const origin = validateClusterEndpoint(endpoint);
    const hostname = new URL(origin).hostname;
    if (!proxy) {
      let addresses;
      try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
      catch { throw error(502, "shard_unreachable", "The shard hostname could not be resolved."); }
      if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address }) => !isTailscaleAddress(address))) {
        throw error(400, "non_tailnet_endpoint", "The shard endpoint did not resolve exclusively to Tailscale addresses.");
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await transport(`${origin}/api/shard/v1/pair`, {
        body: JSON.stringify({ clusterId: localIdentity.clusterId, pairingCode, requester: localIdentity.descriptor }),
        headers: { "content-type": "application/json" }, method: "POST", redirect: "error", signal: controller.signal
      });
    } catch { throw error(502, "shard_unreachable", "The shard pairing request failed."); }
    finally { clearTimeout(timer); }
    const declared = Number(response.headers?.get?.("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > maxResponseBytes) throw error(502, "invalid_shard_response", "The shard pairing response was too large.");
    const raw = await readBounded(response, maxResponseBytes);
    let value;
    try { value = JSON.parse(raw.toString("utf8")); } catch { throw error(502, "invalid_shard_response", "The shard pairing response was invalid."); }
    if (!response.ok) throw error(response.status === 401 ? 401 : 502, value?.code ?? "pairing_failed", "The shard rejected the pairing request.");
    const accepted = validateClusterPairingResponse(value);
    if (accepted.clusterId !== localIdentity.clusterId) throw error(409, "cluster_mismatch", "The shard joined a different cluster.");
    if (validateClusterEndpoint(accepted.node.endpoint) !== origin) throw error(409, "endpoint_mismatch", "The shard returned a different endpoint.");
    return accepted;
  }
  });
};
