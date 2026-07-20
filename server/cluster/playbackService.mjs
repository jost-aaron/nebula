const error = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });
const principal = (accountId) => ({ type: "user", userId: accountId });
const quality = (profileId) => profileId && profileId !== "auto"
  ? profileId === "original" ? { mode: "original" } : { mode: "profile", profileId }
  : { mode: "auto" };
const TERMINAL_FAILURES = new Set(["cancelled", "expired", "failed"]);

export const createClusterPlaybackService = ({ scheduler, grants, client, deliveryClient = null, localDelivery = null }) => {
  if (!scheduler || !grants || !client) throw new TypeError("Cluster scheduler, grant, and client services are required.");
  const ownedLocalDeliveries = new Map();
  const remoteDeliveries = new Map();
  const readyRemoteSessions = new Map();

  const releaseLocalDelivery = async (sessionId, accountId) => {
    const deliveryId = ownedLocalDeliveries.get(sessionId);
    ownedLocalDeliveries.delete(sessionId);
    if (deliveryId && localDelivery) await localDelivery.cancel(deliveryId, principal(accountId)).catch(() => undefined);
  };
  const releaseRemoteDelivery = async (sessionId) => {
    const remote = remoteDeliveries.get(sessionId);
    remoteDeliveries.delete(sessionId);
    readyRemoteSessions.delete(sessionId);
    if (remote && deliveryClient) {
      await deliveryClient.cancel(remote.candidate.endpoint, {
        clusterSessionId: sessionId,
        deliveryId: remote.result.deliveryId
      }).catch(() => undefined);
    }
  };
  const releaseOwnedDelivery = async (sessionId, accountId) => {
    await Promise.all([releaseLocalDelivery(sessionId, accountId), releaseRemoteDelivery(sessionId)]);
  };
  const remotePlan = (scheduled, result) => ({
    decision: result.decision,
    federatedItemId: scheduled.internal.federatedItemId,
    itemId: scheduled.internal.federatedItemId,
    nodeId: scheduled.internal.candidate.nodeId,
    output: result.output,
    reasons: result.reasons,
    sourceId: scheduled.internal.candidate.federatedSourceId
  });
  const pendingRemoteResponse = (scheduled, result) => ({
    plan: remotePlan(scheduled, result),
    session: {
      ...scheduled.session,
      decision: result.decision,
      deliveryUrl: "",
      itemId: scheduled.internal.federatedItemId,
      sourceId: scheduled.internal.candidate.federatedSourceId,
      status: result.status
    }
  });
  const activateGrant = async (scheduled, context, delivery = null) => {
    const { accountId, clientOrigin = null } = context;
    const candidate = scheduled.internal.candidate;
    const signed = grants.issue({
      accountId,
      candidate,
      clientOrigin,
      delivery,
      deviceId: scheduled.internal.request.capabilities.deviceId,
      federatedItemId: scheduled.internal.federatedItemId,
      profileId: scheduled.internal.request.preferredProfileId ?? "auto",
      sessionId: scheduled.internal.id
    });
    const activated = await client.activate({ endpoint: candidate.endpoint, ...signed });
    const protocol = delivery?.output?.protocol ?? "file";
    const asset = protocol === "hls" ? "hls/master.m3u8" : "file";
    const deliveryUrl = `${new URL(candidate.endpoint).origin}${signed.grant.assetPrefix}${asset}?ticket=${encodeURIComponent(activated.mediaTicket)}`;
    const plan = delivery ? remotePlan(scheduled, delivery) : {
      decision: "direct-play",
      federatedItemId: scheduled.internal.federatedItemId,
      itemId: scheduled.internal.federatedItemId,
      nodeId: candidate.nodeId,
      output: { audioCodec: null, bitrate: null, container: null, protocol: "file", videoCodec: null },
      reasons: [{ code: "CLUSTER_DIRECT_PLAY", message: `Selected ${candidate.nodeName} for direct playback.`, streamIndex: null }],
      sourceId: candidate.federatedSourceId
    };
    return {
      plan,
      session: {
        ...scheduled.session,
        decision: plan.decision,
        deliveryUrl,
        grantExpiresAt: activated.expiresAt,
        itemId: scheduled.internal.federatedItemId,
        sourceId: candidate.federatedSourceId,
        status: "ready"
      }
    };
  };
  const validateGeneratedResult = (candidate, result) => {
    const expectedDecision = candidate.mode === "remux" ? "remux" : "transcode";
    const expectedProtocol = candidate.mode === "remux" ? "file" : "hls";
    if (result.decision !== expectedDecision || result.output.protocol !== expectedProtocol) {
      throw error(502, "shard_delivery_plan_mismatch", "The shard returned a delivery plan that does not match the selected source.");
    }
    return result;
  };
  const activateGenerated = async (scheduled, context) => {
    if (!deliveryClient) throw error(503, "remote_delivery_unavailable", "Remote generated delivery is unavailable.");
    const candidate = scheduled.internal.candidate;
    const result = validateGeneratedResult(candidate, await deliveryClient.create(candidate.endpoint, {
      accountId: context.accountId,
      capabilities: scheduled.internal.request.capabilities,
      clusterSessionId: scheduled.internal.id,
      federatedItemId: scheduled.internal.federatedItemId,
      localItemId: candidate.localItemId,
      localSourceId: candidate.localSourceId,
      profileId: scheduled.internal.request.preferredProfileId ?? "auto",
      sourceRevision: candidate.sourceRevision,
      startPositionSeconds: scheduled.internal.request.startPositionSeconds ?? null
    }));
    remoteDeliveries.set(scheduled.internal.id, { candidate, result, scheduled });
    if (result.status !== "ready") {
      if (TERMINAL_FAILURES.has(result.status)) throw error(502, "shard_delivery_failed", "The shard could not prepare playback delivery.");
      return pendingRemoteResponse(scheduled, result);
    }
    const activated = await activateGrant(scheduled, context, result);
    readyRemoteSessions.set(scheduled.internal.id, activated);
    return activated;
  };
  const activate = async (scheduled, context) => {
    const { accountId } = context;
    const candidate = scheduled.internal.candidate;
    try {
      if (candidate.local) {
        if (!localDelivery) throw error(503, "local_delivery_unavailable", "Local playback delivery is unavailable.");
        const local = await localDelivery.create({
          capabilities: scheduled.internal.request.capabilities,
          itemId: candidate.localItemId,
          quality: quality(scheduled.internal.request.preferredProfileId),
          sourceId: candidate.localSourceId,
          startPositionSeconds: scheduled.internal.request.startPositionSeconds ?? null
        }, principal(accountId));
        ownedLocalDeliveries.set(scheduled.session.id, local.session.id);
        return { plan: local.plan, session: { ...scheduled.session, delivery: local.session, deliveryUrl: local.session.deliveryUrl } };
      }
      if (candidate.decision === "direct-play" && candidate.mode === "original") return await activateGrant(scheduled, context);
      if (!new Set(["remux", "live-transcode", "prebuilt-rendition"]).has(candidate.mode)) {
        throw error(422, "remote_delivery_mode_unsupported", "The selected remote delivery mode is unsupported.");
      }
      return await activateGenerated(scheduled, context);
    } catch (activationError) {
      await releaseOwnedDelivery(scheduled.session.id, accountId);
      scheduler.release(scheduled.session.id, { accountId });
      throw activationError;
    }
  };

  return {
    async create(request, context) {
      const scheduled = scheduler.create(request, { accountId: context.accountId });
      return activate(scheduled, context);
    },
    async get(sessionId, context) {
      const publicSession = scheduler.get(sessionId, context);
      const ready = readyRemoteSessions.get(sessionId);
      if (ready) return ready;
      const remote = remoteDeliveries.get(sessionId);
      if (!remote) return { session: publicSession };
      const result = validateGeneratedResult(remote.candidate, await deliveryClient.get(remote.candidate.endpoint, {
        clusterSessionId: sessionId,
        deliveryId: remote.result.deliveryId
      }));
      remote.result = result;
      if (TERMINAL_FAILURES.has(result.status)) {
        await releaseRemoteDelivery(sessionId);
        scheduler.release(sessionId, context);
        throw error(502, "shard_delivery_failed", "The shard could not prepare playback delivery.");
      }
      if (result.status !== "ready") return pendingRemoteResponse({ ...remote.scheduled, session: publicSession }, result);
      const activated = await activateGrant({ ...remote.scheduled, session: publicSession }, context, result);
      readyRemoteSessions.set(sessionId, activated);
      return activated;
    },
    async failover(sessionId, context, failedNodeId) {
      const replacement = scheduler.failover(sessionId, context, failedNodeId);
      await releaseOwnedDelivery(sessionId, context.accountId);
      return activate(replacement, context);
    },
    async release(sessionId, context) {
      await releaseOwnedDelivery(sessionId, context.accountId);
      scheduler.release(sessionId, context);
    }
  };
};
