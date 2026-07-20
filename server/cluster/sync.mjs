import { ProxyAgent } from "undici";
import { randomUUID } from "node:crypto";
import { validateClusterEndpoint, validateClusterManifestPage } from "./protocol.mjs";
import { validateClusterProxyUrl } from "./client.mjs";

const error = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });
const readJson = async (response, limit) => {
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > limit) throw error(502, "invalid_shard_response", "The shard manifest response exceeded its size limit.");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw error(502, "invalid_shard_response", "The shard manifest response was invalid."); }
};

export const createClusterManifestClient = ({
  allowDirect = false, fetcher = null, maxResponseBytes = 2 * 1024 * 1024,
  proxyUrl = process.env.NEBULA_CLUSTER_HTTP_PROXY, timeoutMs = 15_000
} = {}) => {
  const proxy = validateClusterProxyUrl(proxyUrl);
  if (!proxy && !allowDirect) throw error(500, "cluster_proxy_required", "The fixed Tailscale userspace proxy is required.");
  const dispatcher = !fetcher && proxy ? new ProxyAgent(proxy) : null;
  const transport = fetcher ?? ((url, options) => fetch(url, { ...options, ...(dispatcher ? { dispatcher } : {}) }));
  return {
    async page({ endpoint, envelope, payload }) {
      const origin = validateClusterEndpoint(endpoint);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
      let response;
      try {
        response = await transport(`${origin}/api/shard/v1/manifest`, {
          body: JSON.stringify({ envelope, payload }), headers: { "content-type": "application/json" },
          method: "POST", redirect: "error", signal: controller.signal
        });
      } catch { throw error(502, "shard_unreachable", "The shard manifest request failed."); }
      finally { clearTimeout(timer); }
      const declared = Number(response.headers?.get?.("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > maxResponseBytes) throw error(502, "invalid_shard_response", "The shard manifest response exceeded its size limit.");
      const value = await readJson(response, maxResponseBytes);
      if (!response.ok) throw error(response.status >= 400 && response.status < 500 ? response.status : 502, value?.code ?? "manifest_sync_failed", "The shard rejected manifest synchronization.");
      if (!value || Object.keys(value).sort().join(",") !== "envelope,payload") throw error(502, "invalid_shard_response", "The shard manifest response shape was invalid.");
      return { envelope: value.envelope, payload: validateClusterManifestPage(value.payload) };
    }
  };
};

export const createClusterSyncService = ({ client, federation, trust, maxCursorRestarts = 1, maxPages = 10_000 } = {}) => {
  if (!client?.page || !federation?.applyManifestPage || !trust?.signRequest) throw new TypeError("Cluster sync dependencies are required.");
  if (!Number.isSafeInteger(maxCursorRestarts) || maxCursorRestarts < 0 || maxCursorRestarts > 3) throw new TypeError("maxCursorRestarts must be between 0 and 3.");
  return {
    async syncNode(nodeId) {
      const node = trust.listNodes().find((entry) => entry.nodeId === nodeId);
      if (!node || node.state === "revoked") throw error(404, "node_not_found", "Cluster node not found.");
      for (let restart = 0; restart <= maxCursorRestarts; restart += 1) {
        const syncGeneration = `sync_${randomUUID().replaceAll("-", "")}`;
        let cursor = null;
        const seen = new Set();
        try {
          for (let count = 0; count < maxPages; count += 1) {
            const payload = { cursor, limit: 500 };
            const path = "/api/shard/v1/manifest";
            const response = await client.page({ endpoint: node.endpoint, envelope: trust.signRequest({ body: payload, method: "POST", path }), payload });
            trust.verifyRequest(response.envelope, response.payload, { method: "POST", path });
            const applied = federation.applyManifestPage({ nodeId, page: response.payload, syncGeneration });
            if (applied.complete) return applied;
            if (!applied.cursor || seen.has(applied.cursor)) throw error(502, "invalid_manifest_cursor", "The shard repeated an invalid manifest cursor.");
            seen.add(applied.cursor); cursor = applied.cursor;
          }
          throw error(502, "manifest_page_limit", "The shard manifest exceeded the synchronization page limit.");
        } catch (syncError) {
          if (syncError?.code !== "cursor_lost" || restart === maxCursorRestarts) throw syncError;
        }
      }
      throw error(502, "manifest_sync_failed", "The shard manifest could not be synchronized.");
    }
  };
};

export const syncLocalClusterManifest = async ({ federation, manifest, nodeId, maxPages = 10_000 }) => {
  const syncGeneration = `sync_${randomUUID().replaceAll("-", "")}`;
  let cursor = null;
  for (let count = 0; count < maxPages; count += 1) {
    const page = await manifest.page({ cursor, limit: 500 });
    const applied = federation.applyManifestPage({ nodeId, page, syncGeneration });
    if (applied.complete) return applied;
    if (!applied.cursor) throw error(500, "invalid_local_manifest_cursor", "The local manifest cursor is invalid.");
    cursor = applied.cursor;
  }
  throw error(500, "local_manifest_page_limit", "The local manifest exceeded the synchronization page limit.");
};
