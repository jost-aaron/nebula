import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { CLUSTER_PROTOCOL_VERSION, validateClusterNodeDescriptor, validateClusterPairingRequest, validateClusterSignedEnvelope } from "./protocol.mjs";
import { digestJsonBody, generateClusterKeyPair, sha256, signClusterEnvelope, verifyClusterEnvelopeSignature } from "./crypto.mjs";

const error = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });
const sameText = (left, right) => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const createClusterTrustService = ({
  repository, now = () => Date.now(), uuid = randomUUID, random = (bytes) => randomBytes(bytes),
  pairingTtlMs = 10 * 60 * 1000, requestWindowMs = 2 * 60 * 1000,
  name = "Nebula", role = "hybrid", endpoint, capabilities = { directPlay: true, hls: true, remux: true, renditionProfiles: [], transcode: true }
}) => {
  if (!repository) throw new TypeError("A cluster repository is required.");
  let identity = repository.getIdentity();
  if (!identity) {
    const keyPair = generateClusterKeyPair();
    const candidate = validateClusterNodeDescriptor({
      capabilities, endpoint, name,
      nodeId: `node_${uuid().replaceAll("-", "")}`,
      protocolVersion: CLUSTER_PROTOCOL_VERSION,
      publicKey: keyPair.publicKey,
      role
    });
    identity = repository.createIdentity({
      clusterId: `cluster_${uuid().replaceAll("-", "")}`, endpoint, name,
      nodeId: candidate.nodeId, privateJwk: keyPair.privateJwk,
      publicKey: candidate.publicKey, role
    });
  }

  const descriptor = () => validateClusterNodeDescriptor({
    capabilities, endpoint: identity.endpoint, name: identity.name, nodeId: identity.nodeId,
    protocolVersion: CLUSTER_PROTOCOL_VERSION, publicKey: identity.publicKey, role: identity.role
  });

  descriptor();

  return {
    identity: () => ({ clusterId: identity.clusterId, descriptor: descriptor(), keyVersion: identity.keyVersion }),
    listNodes: repository.listNodes,
    createPairingCode() {
      const pairingCode = random(24).toString("base64url");
      const expiresAt = new Date(now() + pairingTtlMs).toISOString();
      repository.createPairingCode(sha256(pairingCode), expiresAt);
      return { pairingCode, expiresAt };
    },
    acceptPairing(input) {
      const value = validateClusterPairingRequest(input);
      if (!new Set(["coordinator", "hybrid"]).has(value.requester.role)) throw error(400, "invalid_coordinator", "Pairing must be requested by a coordinator-capable node.");
      const presentedHash = sha256(value.pairingCode);
      if (!repository.consumePairingCode(presentedHash)) throw error(401, "pairing_denied", "The pairing code is invalid or expired.");
      const clusterId = value.clusterId;
      identity = repository.updateClusterId(clusterId);
      repository.upsertNode(value.requester, clusterId);
      return { clusterId, node: descriptor() };
    },
    registerPairedNode(input) {
      const node = validateClusterNodeDescriptor(input.node);
      if (typeof input.clusterId !== "string" || !sameText(input.clusterId, identity.clusterId)) throw error(409, "cluster_mismatch", "The paired node belongs to a different cluster.");
      return repository.upsertNode(node, identity.clusterId);
    },
    revokeNode(nodeId) {
      if (nodeId === identity.nodeId) throw error(400, "self_revoke", "The local node cannot revoke itself.");
      if (!repository.revokeNode(nodeId)) throw error(404, "node_not_found", "Cluster node not found.");
    },
    signRequest({ method, path, body, nonce = random(18).toString("base64url"), timestamp = new Date(now()).toISOString() }) {
      return signClusterEnvelope({ bodyDigest: digestJsonBody(body), method, nodeId: identity.nodeId, nonce, path, protocolVersion: CLUSTER_PROTOCOL_VERSION, timestamp }, identity.privateJwk);
    },
    verifyRequest(envelope, body, expected = {}) {
      validateClusterSignedEnvelope(envelope);
      if (expected.method && envelope.method !== expected.method) throw error(401, "method_mismatch", "The signed method does not match the request.");
      if (expected.path && envelope.path !== expected.path) throw error(401, "path_mismatch", "The signed path does not match the request.");
      const node = repository.getNode(envelope.nodeId);
      if (!node || node.state === "revoked") throw error(401, "untrusted_node", "The cluster request is not trusted.");
      const skew = Math.abs(now() - Date.parse(envelope.timestamp));
      if (!Number.isFinite(skew) || skew > requestWindowMs) throw error(401, "request_expired", "The cluster request timestamp is outside the accepted window.");
      if (!sameText(envelope.bodyDigest, digestJsonBody(body))) throw error(401, "body_mismatch", "The cluster request body digest does not match.");
      if (!verifyClusterEnvelopeSignature(envelope, node.publicKey)) throw error(401, "bad_signature", "The cluster request signature is invalid.");
      const expiresAt = new Date(Date.parse(envelope.timestamp) + requestWindowMs).toISOString();
      if (!repository.consumeNonce(node.nodeId, envelope.nonce, expiresAt)) throw error(409, "request_replayed", "The cluster request nonce has already been used.");
      return node;
    }
  };
};
