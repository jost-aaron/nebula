import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { sha256 } from "./crypto.mjs";
import { CLUSTER_PROTOCOL_VERSION, validateClusterDelegatedMediaGrant } from "./protocol.mjs";

const GRANT_PATH = "/api/shard/v1/playback/grants/validate";
const error = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });
const sameText = (left, right) => {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};

export const createClusterGrantService = ({
  catalog, trust, now = () => Date.now(), uuid = randomUUID, random = (bytes) => randomBytes(bytes),
  grantTtlMs = 10 * 60 * 1000, isClientOriginAllowed = () => false, shardDelivery = null
}) => {
  if (!catalog || !trust) throw new TypeError("Catalog and cluster trust services are required.");
  const accepted = new Map();
  const sweep = () => {
    for (const [grantId, entry] of accepted) if (now() >= entry.expiresAt) accepted.delete(grantId);
  };
  const validateSource = (grant) => {
    const source = catalog.getSource(grant.localSourceId);
    if (!source || source.availability !== "available" || source.contentRevision !== grant.sourceRevision) {
      throw error(404, "grant_source_unavailable", "The delegated media source is unavailable.");
    }
    return source;
  };

  return {
    issue({ accountId, candidate, clientOrigin = null, delivery = null, deviceId, federatedItemId, profileId = "auto", sessionId, subtitleId = null }) {
      const issuedAt = now();
      const grantId = `grant_${uuid().replaceAll("-", "")}`;
      const identity = trust.identity();
      const coordinatorOrigin = new URL(identity.descriptor.endpoint).origin;
      const delegatedOrigin = clientOrigin ?? coordinatorOrigin;
      if (delegatedOrigin !== coordinatorOrigin && !isClientOriginAllowed(delegatedOrigin)) {
        throw error(403, "client_origin_denied", "The playback client origin is not allowed.");
      }
      const grant = validateClusterDelegatedMediaGrant({
        accountId,
        assetPrefix: `/api/shard/v1/media/${grantId}/`,
        clientOrigin: delegatedOrigin,
        clusterId: identity.clusterId,
        deliveryId: delivery?.deliveryId ?? null,
        deliveryProtocol: delivery?.output?.protocol ?? "file",
        deviceId,
        expiresAt: new Date(issuedAt + grantTtlMs).toISOString(),
        federatedItemId,
        grantId,
        issuedAt: new Date(issuedAt).toISOString(),
        localSourceId: candidate.localSourceId,
        methods: ["GET", "HEAD"],
        nodeId: candidate.nodeId,
        nonce: random(18).toString("base64url"),
        profileId,
        protocolVersion: CLUSTER_PROTOCOL_VERSION,
        sessionId,
        sourceRevision: candidate.sourceRevision,
        subtitleId
      });
      return { envelope: trust.signRequest({ body: grant, method: "POST", path: GRANT_PATH }), grant };
    },
    accept(input) {
      sweep();
      const grant = validateClusterDelegatedMediaGrant(input?.grant);
      const identity = trust.identity();
      if (grant.clusterId !== identity.clusterId || grant.nodeId !== identity.descriptor.nodeId) throw error(409, "grant_scope_mismatch", "The delegated grant targets another cluster node.");
      if (now() < Date.parse(grant.issuedAt) - 120_000 || now() >= Date.parse(grant.expiresAt)) throw error(401, "grant_expired", "The delegated grant is expired or not active.");
      if (grant.assetPrefix !== `/api/shard/v1/media/${grant.grantId}/`) throw error(400, "grant_prefix_mismatch", "The delegated grant prefix is invalid.");
      const peer = trust.verifyRequest(input?.envelope, grant, { method: "POST", path: GRANT_PATH });
      if (!new Set(["coordinator", "hybrid"]).has(peer.role)) throw error(403, "grant_issuer_denied", "Only a coordinator can delegate media access.");
      validateSource(grant);
      const delivery = shardDelivery?.authorizeGrant(grant) ?? null;
      if (grant.deliveryId && !delivery) throw error(404, "grant_delivery_unavailable", "The delegated delivery is unavailable.");
      const ticket = random(32).toString("base64url");
      accepted.set(grant.grantId, { clientOrigin: grant.clientOrigin, delivery, expiresAt: Date.parse(grant.expiresAt), grant, ticketHash: sha256(ticket) });
      return { expiresAt: grant.expiresAt, grantId: grant.grantId, mediaTicket: ticket };
    },
    resolve({ grantId, method, ticket }) {
      sweep();
      const entry = accepted.get(grantId);
      if (!entry || !entry.grant.methods.includes(method) || typeof ticket !== "string" || !sameText(entry.ticketHash, sha256(ticket))) {
        throw error(404, "delegated_media_not_found", "Delegated media was not found.");
      }
      return { clientOrigin: entry.clientOrigin, delivery: entry.delivery, grant: entry.grant, source: validateSource(entry.grant) };
    },
    revoke(grantId) { accepted.delete(grantId); },
    shutdown() { accepted.clear(); }
  };
};

export const CLUSTER_GRANT_VALIDATION_PATH = GRANT_PATH;
