import { ProxyAgent } from "undici";
import { validateClusterEndpoint, validateClusterDelegatedMediaGrant } from "./protocol.mjs";
import { validateClusterProxyUrl } from "./client.mjs";
import { CLUSTER_GRANT_VALIDATION_PATH } from "./grants.mjs";

const error = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });
const readJson = async (response, limit) => {
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > limit) throw error(502, "invalid_shard_response", "The shard grant response exceeded its size limit.");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw error(502, "invalid_shard_response", "The shard grant response was invalid."); }
};

export const createClusterGrantClient = ({
  allowDirect = false, fetcher = null, maxResponseBytes = 64 * 1024,
  proxyUrl = process.env.NEBULA_CLUSTER_HTTP_PROXY, timeoutMs = 10_000
} = {}) => {
  const proxy = validateClusterProxyUrl(proxyUrl);
  if (!proxy && !allowDirect) throw error(500, "cluster_proxy_required", "The fixed Tailscale userspace proxy is required.");
  const dispatcher = !fetcher && proxy ? new ProxyAgent(proxy) : null;
  const transport = fetcher ?? ((url, options) => fetch(url, { ...options, ...(dispatcher ? { dispatcher } : {}) }));
  return {
    async activate({ endpoint, envelope, grant }) {
      const origin = validateClusterEndpoint(endpoint);
      validateClusterDelegatedMediaGrant(grant);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
      let response;
      try {
        response = await transport(`${origin}${CLUSTER_GRANT_VALIDATION_PATH}`, {
          body: JSON.stringify({ envelope, grant }), headers: { "content-type": "application/json" },
          method: "POST", redirect: "error", signal: controller.signal
        });
      } catch { throw error(502, "shard_unreachable", "The shard grant request failed."); }
      finally { clearTimeout(timer); }
      const value = await readJson(response, maxResponseBytes);
      if (!response.ok) throw error(response.status >= 400 && response.status < 500 ? response.status : 502, value?.code ?? "grant_rejected", "The shard rejected delegated playback.");
      if (!value || Object.keys(value).sort().join(",") !== "expiresAt,grantId,mediaTicket"
        || value.grantId !== grant.grantId || typeof value.mediaTicket !== "string"
        || !/^[A-Za-z0-9_-]{32,256}$/.test(value.mediaTicket) || value.expiresAt !== grant.expiresAt) {
        throw error(502, "invalid_shard_response", "The shard grant response shape was invalid.");
      }
      return value;
    }
  };
};
