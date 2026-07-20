const error = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });
const PROFILE_IDS = new Set(["auto", "original", "240p", "360p", "480p", "720p", "1080p"]);
const STATUSES = new Set(["queued", "running", "ready", "failed", "cancelled", "expired"]);
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every((key) => keys.has(key));
const requireId = (value, label) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value)) throw error(400, "invalid_shard_delivery", `${label} is invalid.`);
};
const quality = (profileId) => profileId === "auto" ? { mode: "auto" }
  : profileId === "original" ? { mode: "original" } : { mode: "profile", profileId };

export const createClusterShardDeliveryService = ({ catalog, delivery, localNodeId, subtitles = null }) => {
  if (!catalog || !delivery || !localNodeId) throw new TypeError("Catalog, delivery, and local node identity are required.");
  const sessions = new Map();
  const principalFor = (clusterSessionId, subtitleId) => ({ type: "user", userId: `cluster_${clusterSessionId}`, subtitleId: subtitleId ?? null });
  const validatePeer = (peer) => {
    if (!peer || !new Set(["coordinator", "hybrid"]).has(peer.role)) throw error(403, "shard_delivery_denied", "Only a paired coordinator can manage shard delivery.");
  };
  const validateRequest = (input) => {
    if (!exactKeys(input, new Set(["accountId", "capabilities", "clusterSessionId", "federatedItemId", "localItemId", "localSourceId", "profileId", "sourceRevision", "startPositionSeconds", "subtitleId"]))) {
      throw error(400, "invalid_shard_delivery", "The shard delivery request is invalid.");
    }
    for (const key of ["accountId", "clusterSessionId", "federatedItemId", "localItemId", "localSourceId"]) requireId(input[key], key);
    if (!PROFILE_IDS.has(input.profileId) || !input.capabilities || typeof input.capabilities !== "object" || Array.isArray(input.capabilities)) throw error(400, "invalid_shard_delivery", "The shard delivery profile or capabilities are invalid.");
    if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1) throw error(400, "invalid_shard_delivery", "The shard source revision is invalid.");
    if (input.subtitleId !== null && input.subtitleId !== undefined) requireId(input.subtitleId, "subtitleId");
    if (input.startPositionSeconds !== null && input.startPositionSeconds !== undefined
      && (!Number.isFinite(input.startPositionSeconds) || input.startPositionSeconds < 0)) throw error(400, "invalid_shard_delivery", "The playback position is invalid.");
    const source = catalog.getSource(input.localSourceId);
    if (!source || source.itemId !== input.localItemId || source.availability !== "available" || source.contentRevision !== input.sourceRevision) {
      throw error(404, "shard_delivery_source_unavailable", "The shard delivery source is unavailable.");
    }
    return source;
  };
  const find = (deliveryId, clusterSessionId, peer) => {
    validatePeer(peer);
    const entry = sessions.get(deliveryId);
    if (!entry || entry.clusterSessionId !== clusterSessionId || entry.peerNodeId !== peer.nodeId) throw error(404, "shard_delivery_not_found", "Shard delivery was not found.");
    return entry;
  };
  const publicResult = (entry) => {
    let session;
    try { session = delivery.get(entry.deliveryId, entry.principal); }
    catch (deliveryError) {
      if (deliveryError?.code !== "session_not_found") throw deliveryError;
      session = { status: "failed" };
    }
    if (!STATUSES.has(session.status)) throw error(502, "invalid_delivery_status", "Shard delivery returned an invalid status.");
    entry.lastStatus = session.status;
    return {
      decision: entry.plan.decision,
      deliveryId: entry.deliveryId,
      output: entry.plan.output,
      reasons: entry.plan.reasons,
      status: session.status
    };
  };

  return {
    async create(input, peer) {
      validatePeer(peer);
      validateRequest(input);
      const principal = principalFor(input.clusterSessionId, input.subtitleId);
      const created = await delivery.create({
        capabilities: input.capabilities,
        itemId: input.localItemId,
        quality: quality(input.profileId),
        sourceId: input.localSourceId,
        startPositionSeconds: input.startPositionSeconds ?? null
      }, principal);
      const entry = {
        accountId: input.accountId,
        clusterSessionId: input.clusterSessionId,
        deliveryId: created.session.id,
        federatedItemId: input.federatedItemId,
        localItemId: input.localItemId,
        localSourceId: input.localSourceId,
        peerNodeId: peer.nodeId,
        plan: created.plan,
        principal,
        profileId: input.profileId,
        sourceRevision: input.sourceRevision,
        subtitleId: input.subtitleId ?? null
      };
      sessions.set(entry.deliveryId, entry);
      return publicResult(entry);
    },
    get(input, peer) {
      if (!exactKeys(input, new Set(["clusterSessionId", "deliveryId"]))) throw error(400, "invalid_shard_delivery", "The shard delivery status request is invalid.");
      return publicResult(find(input.deliveryId, input.clusterSessionId, peer));
    },
    async cancel(input, peer) {
      if (!exactKeys(input, new Set(["clusterSessionId", "deliveryId"]))) throw error(400, "invalid_shard_delivery", "The shard delivery cancellation request is invalid.");
      const entry = find(input.deliveryId, input.clusterSessionId, peer);
      sessions.delete(entry.deliveryId);
      await delivery.cancel(entry.deliveryId, entry.principal);
      return { cancelled: true, deliveryId: entry.deliveryId };
    },
    authorizeGrant(grant) {
      if (!grant.deliveryId) return null;
      const entry = sessions.get(grant.deliveryId);
      if (!entry || entry.accountId !== grant.accountId || entry.clusterSessionId !== grant.sessionId
        || entry.federatedItemId !== grant.federatedItemId || entry.localSourceId !== grant.localSourceId
        || entry.profileId !== grant.profileId || entry.sourceRevision !== grant.sourceRevision
        || entry.subtitleId !== (grant.subtitleId ?? null)) {
        throw error(404, "grant_delivery_unavailable", "The delegated delivery is unavailable.");
      }
      const current = publicResult(entry);
      if (current.status !== "ready" || current.output.protocol !== grant.deliveryProtocol) throw error(409, "grant_delivery_not_ready", "The delegated delivery is not ready.");
      return entry;
    },
    resolveFile(entry) { return delivery.resolveFile(entry.deliveryId, entry.principal); },
    resolveHlsAsset(entry, asset) { return delivery.resolveHlsAsset(entry.deliveryId, asset, entry.principal); },
    operationsSnapshot() {
      const states = Object.fromEntries([...STATUSES].map((status) => [status, 0]));
      for (const entry of sessions.values()) {
        try { publicResult(entry); } catch { entry.lastStatus = "failed"; }
        states[entry.lastStatus ?? "failed"] += 1;
      }
      return { active: states.queued + states.running + states.ready, states };
    },
    async shutdown() {
      await Promise.allSettled([...sessions.values()].map((entry) => delivery.cancel(entry.deliveryId, entry.principal)));
      sessions.clear();
    },
    localNodeId
  };
};
