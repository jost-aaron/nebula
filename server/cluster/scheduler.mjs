import { randomUUID } from "node:crypto";

const error = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });
const PROFILE_IDS = new Set(["auto", "original", "240p", "360p", "480p", "720p", "1080p"]);

const deliveryFor = (source, request) => {
  const profileId = request.preferredProfileId ?? "auto";
  const readyRendition = profileId !== "auto" && profileId !== "original"
    && source.renditions.some((rendition) => rendition.profileId === profileId && rendition.state === "ready");
  if (readyRendition && request.capabilities.supportsHls) return { decision: "transcode", mode: "prebuilt-rendition", profileId, baseScore: 600 };
  if ((profileId === "auto" || profileId === "original") && source.capabilities.directPlay) return { decision: "direct-play", mode: "original", profileId, baseScore: 500 };
  if ((profileId === "auto" || profileId === "original") && source.capabilities.remux) return { decision: "remux", mode: "remux", profileId, baseScore: 350 };
  if (request.capabilities.supportsHls && source.capabilities.transcode) return { decision: "transcode", mode: "live-transcode", profileId, baseScore: 250 };
  return null;
};

export const createClusterPlaybackScheduler = ({
  federation, now = () => Date.now(), uuid = randomUUID, sessionTtlMs = 30 * 60 * 1000,
  failureCooldownMs = 60_000, nodePolicy = () => null
}) => {
  const sessions = new Map();
  const activeByNode = new Map();
  const transcodesByNode = new Map();
  const cooldowns = new Map();

  const activeCount = (nodeId) => activeByNode.get(nodeId) ?? 0;
  const operationsSnapshot = () => {
    const currentTime = now();
    for (const [nodeId, expiresAt] of cooldowns) if (expiresAt <= currentTime) cooldowns.delete(nodeId);
    const remaining = [...cooldowns.values()].map((expiresAt) => Math.max(0, expiresAt - currentTime));
    return {
      activeNodes: [...activeByNode.values()].filter((value) => value > 0).length,
      activeSessions: sessions.size,
      cooldownMaxRemainingMs: remaining.length ? Math.max(...remaining) : 0,
      cooldowns: remaining.length
    };
  };
  const transcodeCount = (nodeId) => transcodesByNode.get(nodeId) ?? 0;
  const usesTranscodeSlot = (candidate) => candidate.mode === "live-transcode";
  const releaseCandidate = (candidate) => {
    activeByNode.set(candidate.nodeId, Math.max(0, activeCount(candidate.nodeId) - 1));
    if (usesTranscodeSlot(candidate)) transcodesByNode.set(candidate.nodeId, Math.max(0, transcodeCount(candidate.nodeId) - 1));
  };
  const claimCandidate = (candidate) => {
    activeByNode.set(candidate.nodeId, activeCount(candidate.nodeId) + 1);
    if (usesTranscodeSlot(candidate)) transcodesByNode.set(candidate.nodeId, transcodeCount(candidate.nodeId) + 1);
  };
  const candidatesFor = (request, excludedNodeIds = new Set(), exactReplicaKey = undefined) => {
    if (!request || typeof request.federatedItemId !== "string" || !request.capabilities || typeof request.capabilities.deviceId !== "string") {
      throw error(400, "invalid_cluster_playback_request", "A federated item and client capabilities are required.");
    }
    if (request.preferredProfileId && !PROFILE_IDS.has(request.preferredProfileId)) throw error(400, "invalid_profile", "The requested profile is unsupported.");
    return federation.listPlaybackSources(request.federatedItemId).flatMap((source) => {
      if (excludedNodeIds.has(source.nodeId) || source.nodeState !== "online" || (cooldowns.get(source.nodeId) ?? 0) > now()) return [];
      if (exactReplicaKey !== undefined && source.exactReplicaKey !== exactReplicaKey) return [];
      const delivery = deliveryFor(source, request);
      if (!delivery) return [];
      const policy = nodePolicy(source.nodeId);
      if (policy?.state === "revoked" || policy?.controls?.maintenanceDrain) return [];
      const maxStreams = policy?.controls?.maxConcurrentStreams ?? null;
      const maxTranscodes = policy?.controls?.maxConcurrentTranscodes ?? null;
      if (maxStreams !== null && activeCount(source.nodeId) >= maxStreams) return [];
      if (delivery.mode === "live-transcode" && maxTranscodes !== null && transcodeCount(source.nodeId) >= maxTranscodes) return [];
      const loadPenalty = activeCount(source.nodeId) * 100;
      const localityBonus = source.local ? 20 : 0;
      // Priority breaks ties within delivery preference without overpowering
      // the server-owned direct/remux/transcode ordering.
      const priorityBonus = (policy?.controls?.priority ?? 0) * 0.25;
      const score = delivery.baseScore + priorityBonus + localityBonus - loadPenalty;
      return [{
        ...delivery,
        endpoint: source.endpoint,
        exactReplicaKey: source.exactReplicaKey,
        federatedSourceId: source.federatedSourceId,
        local: source.local,
        localItemId: source.localItemId,
        localSourceId: source.localSourceId,
        nodeId: source.nodeId,
        nodeName: policy?.name ?? source.nodeName,
        score,
        sourceRevision: source.sourceRevision,
        reasons: [
          { code: delivery.mode === "prebuilt-rendition" ? "PREBUILT_RENDITION" : delivery.decision === "direct-play" ? "DIRECT_PLAY" : delivery.decision === "remux" ? "REMUX" : "LIVE_TRANSCODE", score: delivery.baseScore },
          ...(priorityBonus ? [{ code: "OWNER_PRIORITY", score: priorityBonus }] : []),
          ...(source.local ? [{ code: "LOCAL_COORDINATOR", score: localityBonus }] : []),
          ...(loadPenalty ? [{ code: "ACTIVE_SESSION_LOAD", score: -loadPenalty }] : [])
        ]
      }];
    }).sort((left, right) => right.score - left.score || activeCount(left.nodeId) - activeCount(right.nodeId) || left.nodeId.localeCompare(right.nodeId));
  };

  const publicSession = (session) => ({
    candidate: { decision: session.candidate.decision, local: session.candidate.local, mode: session.candidate.mode, nodeId: session.candidate.nodeId, nodeName: session.candidate.nodeName, reasons: session.candidate.reasons, score: session.candidate.score, sourceId: session.candidate.federatedSourceId },
    createdAt: new Date(session.createdAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    federatedItemId: session.federatedItemId,
    id: session.id,
    status: session.status
  });
  const find = (sessionId, accountId) => {
    const session = sessions.get(sessionId);
    if (!session || session.accountId !== accountId) throw error(404, "cluster_playback_session_not_found", "Cluster playback session not found.");
    if (now() >= session.expiresAt) {
      releaseCandidate(session.candidate); sessions.delete(session.id);
      throw error(410, "cluster_playback_session_expired", "Cluster playback session expired.");
    }
    return session;
  };

  return {
    create(request, { accountId }) {
      if (typeof accountId !== "string" || !accountId) throw error(403, "account_required", "Account playback access is required.");
      const candidate = candidatesFor(request)[0];
      if (!candidate) throw error(422, "cluster_source_unavailable", "No compatible shard source is currently available.");
      const createdAt = now();
      const session = { accountId, candidate, createdAt, expiresAt: createdAt + sessionTtlMs, federatedItemId: request.federatedItemId, id: `cluster_session_${uuid().replaceAll("-", "")}`, request, status: "ready" };
      sessions.set(session.id, session); claimCandidate(candidate);
      return { internal: session, session: publicSession(session) };
    },
    get(sessionId, { accountId }) { return publicSession(find(sessionId, accountId)); },
    failover(sessionId, { accountId }, failedNodeId) {
      const session = find(sessionId, accountId);
      if (failedNodeId !== session.candidate.nodeId) throw error(409, "cluster_candidate_mismatch", "The failed shard does not own this session.");
      if (!session.candidate.exactReplicaKey) throw error(409, "exact_replica_unavailable", "Failover requires an exact source replica.");
      cooldowns.set(failedNodeId, now() + failureCooldownMs);
      const next = candidatesFor(session.request, new Set([failedNodeId]), session.candidate.exactReplicaKey)[0];
      if (!next) throw error(503, "failover_unavailable", "No exact replica is currently available for failover.");
      releaseCandidate(session.candidate); claimCandidate(next);
      session.candidate = next;
      return { internal: session, session: publicSession(session) };
    },
    release(sessionId, { accountId }) {
      const session = find(sessionId, accountId);
      releaseCandidate(session.candidate); sessions.delete(session.id);
    },
    operationsSnapshot,
    snapshot: () => ({ activeByNode: Object.fromEntries(activeByNode), sessionCount: sessions.size }),
    nodeLoad: (nodeId) => ({ activeStreams: activeCount(nodeId), activeTranscodes: transcodeCount(nodeId) })
  };
};
