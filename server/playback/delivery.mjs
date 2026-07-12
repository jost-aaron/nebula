import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveRemuxSourcePath } from "../remux/index.mjs";

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code, expose: true });
const ownerId = (principal) => {
  if (principal?.type !== "user" || !principal.userId) throw httpError(403, "Account playback access is required.", "account_required");
  return principal.userId;
};

export const createDeliveryService = ({
  contentRoot, planner, policy = null, remuxService, resolveSource, transcodeService,
  authorize = null, now = () => Date.now(), ttlMs = 30 * 60 * 1000, uuid = randomUUID
}) => {
  const sessions = new Map();
  let closed = false;

  const find = (id, principal) => {
    const entry = sessions.get(id);
    if (!entry || entry.ownerId !== ownerId(principal)) throw httpError(404, "Delivery session not found.", "session_not_found");
    if (authorize && !authorize({ itemId: entry.plan.itemId, sourceId: entry.plan.sourceId }, principal)) {
      throw httpError(404, "Delivery session not found.", "session_not_found");
    }
    if (now() >= entry.expiresAt) {
      void expire(entry);
      throw httpError(410, "Delivery session expired.", "session_expired");
    }
    return entry;
  };
  const status = (entry) => entry.worker?.status ?? entry.status;
  const publicSession = (entry) => ({
    ...(entry.worker?.acceleration ? { acceleration: entry.worker.acceleration } : {}),
    createdAt: new Date(entry.createdAt).toISOString(),
    decision: entry.plan.decision,
    deliveryUrl: entry.plan.decision === "transcode"
      ? `/api/playback/delivery-sessions/${entry.id}/hls/master.m3u8`
      : `/api/playback/delivery-sessions/${entry.id}/file`,
    expiresAt: new Date(entry.expiresAt).toISOString(),
    id: entry.id,
    itemId: entry.plan.itemId,
    sourceId: entry.plan.sourceId,
    status: status(entry)
  });
  const cleanup = async (entry, finalStatus) => {
    if (entry.cleanupPromise) return entry.cleanupPromise;
    entry.status = finalStatus;
    entry.cleanupPromise = (async () => {
      entry.worker?.cancel?.();
      try {
        await entry.worker?.cleanup?.();
      } finally {
        entry.policyLease?.release();
        sessions.delete(entry.id);
      }
    })();
    return entry.cleanupPromise;
  };
  const expire = (entry) => cleanup(entry, "expired");
  const sweep = setInterval(() => {
    for (const entry of sessions.values()) if (now() >= entry.expiresAt) void expire(entry);
  }, Math.min(ttlMs, 60_000));
  sweep.unref?.();

  const create = async (request, principal) => {
    if (closed) throw httpError(503, "Playback delivery is shutting down.", "service_closed");
    const accountId = ownerId(principal);
    const plannerRequest = { capabilities: request?.capabilities, itemId: request?.itemId, sourceId: request?.sourceId };
    if (authorize && !authorize({ itemId: plannerRequest.itemId, sourceId: plannerRequest.sourceId }, principal)) {
      throw httpError(404, "Media source not found.", "source_not_found");
    }
    const plan = await planner.plan(plannerRequest, principal);
    if (plan.decision === "unsupported") throw Object.assign(httpError(422, "No compatible playback delivery is available.", "unsupported_playback"), { plan });
    if (plan.decision === "remux" && plan.output?.container !== "mp4") throw httpError(422, "The planned remux target is not available.", "unsupported_delivery");
    const createdAt = now();
    const id = uuid();
    const policyLease = policy?.admit({ decision: plan.decision, producedBitrate: plan.output?.bitrate, requestedBitrate: request?.capabilities?.maxBitrate, sessionId: id, userId: accountId }) ?? null;
    const governedPlan = plan.decision === "transcode" && policyLease?.maxProducedBitrate
      ? { ...plan, output: { ...plan.output, bitrate: Math.min(plan.output?.bitrate ?? policyLease.maxProducedBitrate, policyLease.maxProducedBitrate) } }
      : plan;
    const entry = { id, ownerId: accountId, plan: governedPlan, createdAt, expiresAt: createdAt + ttlMs, status: "ready", worker: null, source: null, cleanupPromise: null, policyLease };
    try {
      if (governedPlan.decision === "direct-play") {
        entry.source = await resolveSource({ itemId: governedPlan.itemId, sourceId: governedPlan.sourceId }, principal);
        if (!entry.source) throw httpError(404, "Media source not found.", "source_not_found");
      } else if (governedPlan.decision === "remux") {
        entry.worker = await remuxService.createSession(governedPlan, principal);
      } else if (governedPlan.decision === "transcode") {
        entry.worker = await transcodeService.createSession(governedPlan, principal);
      }
    } catch (error) {
      policyLease?.release();
      throw error;
    }
    sessions.set(entry.id, entry);
    entry.worker?.completion.catch(() => cleanup(entry, "failed"));
    return { plan: governedPlan, session: publicSession(entry) };
  };

  return {
    create,
    get: (id, principal) => publicSession(find(id, principal)),
    cancel: async (id, principal) => cleanup(find(id, principal), "cancelled"),
    complete: async (id, principal) => cleanup(find(id, principal), "completed"),
    async resolveFile(id, principal) {
      const entry = find(id, principal);
      if (entry.plan.decision === "transcode") throw httpError(404, "Delivery asset not found.", "asset_not_found");
      if (status(entry) !== "ready") throw httpError(409, "Delivery is not ready.", "delivery_not_ready");
      if (entry.plan.decision === "remux") return { path: entry.worker.outputPath, type: "video/mp4" };
      return { path: await resolveRemuxSourcePath(contentRoot, entry.source.path), type: null };
    },
    async resolveHlsAsset(id, asset, principal) {
      const entry = find(id, principal);
      if (entry.plan.decision !== "transcode") throw httpError(404, "Delivery asset not found.", "asset_not_found");
      if (status(entry) !== "ready") throw httpError(409, "Delivery is not ready.", "delivery_not_ready");
      return entry.worker.resolveAsset(asset);
    },
    async shutdown() {
      closed = true;
      clearInterval(sweep);
      await Promise.allSettled([...sessions.values()].map((entry) => cleanup(entry, "cancelled")));
    }
  };
};
