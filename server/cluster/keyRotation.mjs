import { ProxyAgent } from "undici";
import { validateClusterProxyUrl } from "./client.mjs";
import {
  validateClusterEndpoint, validateClusterKeyRotationAck, validateClusterKeyRotationPayload
} from "./protocol.mjs";

export const CLUSTER_KEY_ROTATION_PREPARE_PATH = "/api/shard/v1/key-rotation/prepare";
export const CLUSTER_KEY_ROTATION_COMMIT_PATH = "/api/shard/v1/key-rotation/commit";

const error = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });
const abortError = () => Object.assign(new Error("The shard key rotation response timed out."), { name: "AbortError" });
const readWithAbort = (reader, signal) => {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
};
const cancelBody = async (response, reader = null) => {
  try {
    if (reader?.cancel) await reader.cancel();
    else await response.body?.cancel?.();
  } catch {}
};
const readJson = async (response, limit, signal) => {
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader?.() ?? null;
  try {
    if (reader) {
      while (true) {
        const { done, value } = await readWithAbort(reader, signal);
        if (done) break;
        const bytes = Buffer.from(value);
        size += bytes.length;
        if (size > limit) throw error(502, "invalid_shard_response", "The shard key rotation response exceeded its size limit.");
        chunks.push(bytes);
      }
    } else {
      for await (const chunk of response.body ?? []) {
        if (signal.aborted) throw abortError();
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > limit) throw error(502, "invalid_shard_response", "The shard key rotation response exceeded its size limit.");
        chunks.push(bytes);
      }
    }
  } catch (cause) {
    await cancelBody(response, reader);
    if (signal.aborted || cause?.name === "AbortError") throw error(502, "shard_unreachable", "The shard key rotation request failed.");
    throw cause;
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw error(502, "invalid_shard_response", "The shard key rotation response was invalid."); }
};

export const createClusterKeyRotationClient = ({
  allowDirect = false, fetcher = null, maxResponseBytes = 64 * 1024,
  proxyUrl = process.env.NEBULA_CLUSTER_HTTP_PROXY, timeoutMs = 10_000
} = {}) => {
  const proxy = validateClusterProxyUrl(proxyUrl);
  if (!proxy && !allowDirect) throw error(500, "cluster_proxy_required", "The fixed Tailscale userspace proxy is required.");
  const dispatcher = !fetcher && proxy ? new ProxyAgent(proxy) : null;
  const transport = fetcher ?? ((url, options) => fetch(url, { ...options, ...(dispatcher ? { dispatcher } : {}) }));
  const call = async ({ endpoint, envelope, path, payload }) => {
    const origin = validateClusterEndpoint(endpoint);
    validateClusterKeyRotationPayload(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    let response;
    let value;
    try {
      response = await transport(`${origin}${path}`, {
        body: JSON.stringify({ envelope, payload }), headers: { "content-type": "application/json" },
        method: "POST", redirect: "error", signal: controller.signal
      });
      const declared = Number(response.headers?.get?.("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > maxResponseBytes) {
        await cancelBody(response);
        throw error(502, "invalid_shard_response", "The shard key rotation response exceeded its size limit.");
      }
      value = await readJson(response, maxResponseBytes, controller.signal);
    } catch (cause) {
      if (cause?.code) throw cause;
      await cancelBody(response);
      throw error(502, "shard_unreachable", "The shard key rotation request failed.");
    } finally { clearTimeout(timer); }
    if (!response.ok) throw error(response.status >= 400 && response.status < 500 ? response.status : 502, value?.code ?? "key_rotation_failed", "The shard rejected key rotation.");
    if (!value || Object.keys(value).sort().join(",") !== "envelope,payload") throw error(502, "invalid_shard_response", "The shard key rotation response was not signed.");
    return { envelope: value.envelope, payload: validateClusterKeyRotationAck(value.payload), origin };
  };
  return {
    commit: (options) => call({ ...options, path: CLUSTER_KEY_ROTATION_COMMIT_PATH }),
    prepare: (options) => call({ ...options, path: CLUSTER_KEY_ROTATION_PREPARE_PATH })
  };
};

const publicStatus = (repository, rotation) => {
  if (!rotation) return null;
  return {
    activatedAt: rotation.activatedAt,
    completedAt: rotation.completedAt,
    createdAt: rotation.createdAt,
    expiresAt: rotation.expiresAt,
    newKeyVersion: rotation.newKeyVersion,
    oldKeyVersion: rotation.oldKeyVersion,
    peers: repository.listIdentityRotationPeers(rotation.rotationId).map((peer) => ({
      committedAt: peer.committedAt, nodeId: peer.nodeId, preparedAt: peer.preparedAt, state: peer.state
    })),
    rotationId: rotation.rotationId,
    state: rotation.state
  };
};

export const createClusterKeyRotationService = ({ client, now = () => Date.now(), repository, trust } = {}) => {
  if (!client?.prepare || !client?.commit || !repository || !trust) throw new TypeError("Cluster key rotation dependencies are required.");

  const verifyAck = ({ envelope, payload, origin, node, path, rotation, state }) => {
    const peer = trust.verifyRequest(envelope, payload, { method: "POST", path });
    if (peer.nodeId !== node.nodeId || payload.nodeId !== node.nodeId) {
      throw error(409, "rotation_peer_mismatch", "The shard key rotation acknowledgement came from another peer.");
    }
    if (validateClusterEndpoint(peer.endpoint) !== origin) throw error(409, "rotation_endpoint_mismatch", "The shard key rotation acknowledgement came from another endpoint.");
    if (payload.rotationId !== rotation.rotationId || payload.keyVersion !== rotation.newKeyVersion || payload.state !== state) {
      throw error(409, "rotation_ack_mismatch", "The shard key rotation acknowledgement did not match the requested transition.");
    }
  };

  const advance = async () => {
    let rotation = repository.getOpenIdentityRotation() ?? trust.beginKeyRotation();
    if (Date.parse(rotation.expiresAt) <= now()) throw error(409, "rotation_expired", "The key rotation transition window expired before completion.");
    let peers = repository.listIdentityRotationPeers(rotation.rotationId);
    const payload = trust.rotationPayload(rotation);

    if (rotation.state === "preparing") {
      for (const progress of peers.filter((peer) => peer.state === "pending")) {
        const node = repository.getNode(progress.nodeId);
        if (!node || node.state === "revoked") throw error(409, "rotation_peer_unavailable", "A key rotation peer is no longer trusted.");
        const response = await client.prepare({ endpoint: node.endpoint, envelope: trust.signRequest({ body: payload, method: "POST", path: CLUSTER_KEY_ROTATION_PREPARE_PATH }), payload });
        verifyAck({ ...response, node, path: CLUSTER_KEY_ROTATION_PREPARE_PATH, rotation, state: "prepared" });
        repository.markIdentityRotationPeer(rotation.rotationId, node.nodeId, "prepared");
      }
      rotation = trust.activateKeyRotation(rotation.rotationId);
      peers = repository.listIdentityRotationPeers(rotation.rotationId);
    }

    for (const progress of peers.filter((peer) => peer.state !== "committed")) {
      const node = repository.getNode(progress.nodeId);
      if (!node || node.state === "revoked") throw error(409, "rotation_peer_unavailable", "A key rotation peer is no longer trusted.");
      const response = await client.commit({ endpoint: node.endpoint, envelope: trust.signRequest({ body: payload, method: "POST", path: CLUSTER_KEY_ROTATION_COMMIT_PATH }), payload });
      verifyAck({ ...response, node, path: CLUSTER_KEY_ROTATION_COMMIT_PATH, rotation, state: "committed" });
      repository.markIdentityRotationPeer(rotation.rotationId, node.nodeId, "committed");
    }
    trust.completeKeyRotation(rotation.rotationId);
    return publicStatus(repository, repository.getIdentityRotation(rotation.rotationId));
  };

  return {
    advance,
    status: () => publicStatus(repository, repository.getOpenIdentityRotation())
  };
};
