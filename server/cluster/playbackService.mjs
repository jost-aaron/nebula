const error = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });
const principal = (accountId) => ({ type: "user", userId: accountId });
const quality = (profileId) => profileId && profileId !== "auto"
  ? profileId === "original" ? { mode: "original" } : { mode: "profile", profileId }
  : { mode: "auto" };

export const createClusterPlaybackService = ({ scheduler, grants, client, localDelivery = null }) => {
  if (!scheduler || !grants || !client) throw new TypeError("Cluster scheduler, grant, and client services are required.");
  const ownedLocalDeliveries = new Map();
  const releaseLocalDelivery = async (sessionId, accountId) => {
    const deliveryId = ownedLocalDeliveries.get(sessionId);
    ownedLocalDeliveries.delete(sessionId);
    if (deliveryId && localDelivery) await localDelivery.cancel(deliveryId, principal(accountId)).catch(() => undefined);
  };
  const activate = async (scheduled, context) => {
    const { accountId, clientOrigin = null } = context;
    const candidate = scheduled.internal.candidate;
    if (candidate.local) {
      if (!localDelivery) { scheduler.release(scheduled.session.id, { accountId }); throw error(503, "local_delivery_unavailable", "Local playback delivery is unavailable."); }
      let local;
      try {
        local = await localDelivery.create({
          capabilities: scheduled.internal.request.capabilities,
          itemId: candidate.localItemId,
          quality: quality(scheduled.internal.request.preferredProfileId),
          sourceId: candidate.localSourceId,
          startPositionSeconds: scheduled.internal.request.startPositionSeconds ?? null
        }, principal(accountId));
      } catch (localError) {
        scheduler.release(scheduled.session.id, { accountId });
        throw localError;
      }
      ownedLocalDeliveries.set(scheduled.session.id, local.session.id);
      return { plan: local.plan, session: { ...scheduled.session, delivery: local.session, deliveryUrl: local.session.deliveryUrl } };
    }
    if (candidate.decision !== "direct-play" || candidate.mode !== "original") {
      scheduler.release(scheduled.session.id, { accountId });
      throw error(422, "remote_delivery_mode_pending", "This remote source requires a delivery mode that is not enabled yet.");
    }
    const signed = grants.issue({
      accountId,
      candidate,
      clientOrigin,
      deviceId: scheduled.internal.request.capabilities.deviceId,
      federatedItemId: scheduled.internal.federatedItemId,
      profileId: scheduled.internal.request.preferredProfileId ?? "auto",
      sessionId: scheduled.internal.id
    });
    let activated;
    try { activated = await client.activate({ endpoint: candidate.endpoint, ...signed }); }
    catch (activationError) { scheduler.release(scheduled.session.id, { accountId }); throw activationError; }
    const deliveryUrl = `${new URL(candidate.endpoint).origin}${signed.grant.assetPrefix}file?ticket=${encodeURIComponent(activated.mediaTicket)}`;
    return {
      plan: {
        decision: "direct-play", federatedItemId: scheduled.internal.federatedItemId, itemId: scheduled.internal.federatedItemId,
        nodeId: candidate.nodeId, output: { audioCodec: null, bitrate: null, container: null, protocol: "file", videoCodec: null },
        reasons: [{ code: "CLUSTER_DIRECT_PLAY", message: `Selected ${candidate.nodeName} for direct playback.`, streamIndex: null }],
        sourceId: candidate.federatedSourceId
      },
      session: {
        ...scheduled.session, decision: "direct-play", deliveryUrl, grantExpiresAt: activated.expiresAt,
        itemId: scheduled.internal.federatedItemId, sourceId: candidate.federatedSourceId, status: "ready"
      }
    };
  };

  return {
    async create(request, context) {
      const { accountId } = context;
      const scheduled = scheduler.create(request, { accountId });
      return activate(scheduled, context);
    },
    get(sessionId, context) { return { session: scheduler.get(sessionId, context) }; },
    async failover(sessionId, context, failedNodeId) {
      const replacement = scheduler.failover(sessionId, context, failedNodeId);
      await releaseLocalDelivery(sessionId, context.accountId);
      return activate(replacement, context);
    },
    async release(sessionId, context) {
      await releaseLocalDelivery(sessionId, context.accountId);
      scheduler.release(sessionId, context);
    }
  };
};
