import { getRenditionProfile, listRenditionProfiles } from "./profiles.mjs";

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code, expose: true });
const validId = (value) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
const jobKey = (source, profile) => `rendition:${source.id}:r${source.contentRevision}:${profile.id}:v${profile.version}`;

export const createRenditionService = ({ audit, canAccessItem = null, catalog, jobs, planner, probeReader, store, transcode }) => {
  const resolve = (itemId, sourceId = null) => {
    if (!validId(itemId)) throw httpError(400, "Invalid media item ID.", "invalid_item_id");
    const item = catalog.getItem(itemId);
    const source = sourceId ? catalog.getSource(sourceId)
      : catalog.listItems({ availability: "available" }).find((entry) => entry.id === itemId)?.source;
    if (!item || !source || source.itemId !== itemId || source.availability !== "available" || source.mediaKind !== "video") {
      throw httpError(404, "Media source not found.", "source_not_found");
    }
    return { item, source };
  };
  const eligibleProfiles = (source) => {
    const video = probeReader.get(source.id)?.streams?.find((stream) => stream.type === "video");
    return listRenditionProfiles({ sourceHeight: video?.height, sourceWidth: video?.width });
  };
  const list = (itemId, context) => {
    const { source } = resolve(itemId);
    if (canAccessItem && !canAccessItem(context, itemId)) throw httpError(404, "Media source not found.", "source_not_found");
    const renditions = store.listForItem(itemId).filter((entry) => entry.sourceId === source.id
      && entry.sourceRevision === source.contentRevision);
    for (const job of jobs.list({ type: "rendition", limit: 200 })) {
      if (job.payload?.itemId !== itemId || !["queued", "running"].includes(job.state)
        || renditions.some((entry) => entry.sourceRevision === job.payload.sourceRevision && entry.profileId === job.payload.profileId)) continue;
      renditions.push({
        audioBitrate: null, bitrate: null, completedAt: null, createdAt: job.createdAt, error: null,
        height: null, id: job.id, itemId, lastAccessedAt: null, origin: "scheduled",
        profileId: job.payload.profileId, profileVersion: job.payload.profileVersion,
        retention: job.payload.retention, sizeBytes: null, sourceId: job.payload.sourceId,
        sourceRevision: job.payload.sourceRevision, state: job.state === "running" ? "building" : "pending",
        updatedAt: job.updatedAt, videoBitrate: null, width: null
      });
    }
    return { profiles: eligibleProfiles(source), renditions };
  };
  const enqueue = (itemId, request, context) => {
    const allowedKeys = new Set(["profileIds", "retention", "sourceId"]);
    if (!request || typeof request !== "object" || Array.isArray(request)
      || Object.keys(request).some((key) => !allowedKeys.has(key))) {
      throw httpError(400, "Rendition request contains unsupported fields.", "invalid_rendition_request");
    }
    const { source } = resolve(itemId, request?.sourceId);
    const ids = Array.isArray(request?.profileIds) ? [...new Set(request.profileIds.map(String))] : [];
    if (!ids.length || ids.length > 3) throw httpError(400, "Select one or more rendition profiles.", "invalid_profiles");
    const profiles = new Map(eligibleProfiles(source).map((profile) => [profile.id, profile]));
    if (ids.some((id) => !profiles.has(id))) throw httpError(422, "A selected profile is not eligible for this source.", "profile_unavailable");
    if (request.retention !== undefined && !["cache", "pinned"].includes(request.retention)) {
      throw httpError(400, "Invalid rendition retention.", "invalid_retention");
    }
    const retention = request.retention === "pinned" ? "pinned" : "cache";
    const builds = ids.map((profileId) => {
      const profile = profiles.get(profileId);
      const ready = store.listForItem(itemId).find((entry) => entry.sourceId === source.id
        && entry.sourceRevision === source.contentRevision && entry.profileId === profile.id
        && entry.profileVersion === profile.version && entry.state === "ready");
      if (ready) {
        const rendition = retention === "pinned" && ready.retention !== "pinned" ? store.setRetention(ready.id, "pinned") : ready;
        return { created: false, rendition };
      }
      const payload = {
        itemId, sourceId: source.id, sourceRevision: source.contentRevision,
        profileId: profile.id, profileVersion: profile.version, retention,
        requestedBy: context?.kind === "service" ? "service" : context?.principalId
      };
      return jobs.enqueue({ type: "rendition", payload, dedupeKey: jobKey(source, profile) });
    });
    audit?.recordBestEffort({
      actor: context?.kind === "service"
        ? { kind: "service", principalId: context.principalId, role: "service-admin" }
        : { kind: "account", principalId: context?.principalId, role: context?.user?.role },
      eventType: "rendition.build_requested", outcome: "success", target: { type: "media-item", id: itemId },
      metadata: { created: builds.some((entry) => entry.created), requestedBy: context?.kind === "service" ? "service" : "manual" }
    });
    return { builds };
  };
  const build = async (payload, context) => {
    const { source } = resolve(payload.itemId, payload.sourceId);
    const profile = getRenditionProfile(payload.profileId);
    if (!profile || source.contentRevision !== payload.sourceRevision || profile.version !== payload.profileVersion) {
      throw Object.assign(new Error("Rendition source or profile changed."), { code: "STALE_RENDITION_JOB" });
    }
    context.reportProgress(0.05, "planning");
    const principal = payload.requestedBy === "service" ? { type: "service" } : { type: "user", userId: payload.requestedBy };
    const plan = await planner.plan({
      capabilities: {
        audioCodecs: ["aac"], containers: ["mpegts"], deviceId: "scheduled-rendition",
        maxAudioChannels: null, maxBitrate: profile.totalBitrate, maxHeight: profile.maxHeight,
        maxWidth: profile.maxWidth, subtitleFormats: [], supportsHls: true, videoCodecs: ["h264"]
      },
      itemId: payload.itemId, quality: { mode: "profile", profileId: profile.id }, sourceId: source.id
    }, principal);
    if (plan.decision !== "transcode" || plan.output?.profileId !== profile.id) {
      throw Object.assign(new Error("Rendition profile cannot be generated."), { code: "RENDITION_UNAVAILABLE" });
    }
    context.reportProgress(0.1, "transcoding");
    const controller = new AbortController();
    const timer = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 200);
    timer.unref?.();
    let session = null;
    try {
      session = await transcode.createSession(plan, principal, { origin: "scheduled", requireCompleteBeforeReady: true, retention: payload.retention, signal: controller.signal });
      await session.completion;
      context.throwIfCancelled();
      context.reportProgress(0.95, "publishing");
      const rendition = store.listForItem(payload.itemId).find((entry) => entry.sourceId === source.id
        && entry.sourceRevision === source.contentRevision && entry.profileId === profile.id);
      if (rendition && payload.retention === "pinned") store.setRetention(rendition.id, "pinned");
      return { profileId: profile.id, renditionId: rendition?.id ?? null, reused: Boolean(session.reused) };
    } finally {
      clearInterval(timer);
      await session?.cleanup?.();
    }
  };
  const setRetention = (itemId, renditionId, retention) => {
    resolve(itemId);
    const rendition = store.get(renditionId);
    if (!rendition || rendition.itemId !== itemId) throw httpError(404, "Rendition not found.", "rendition_not_found");
    return store.setRetention(renditionId, retention);
  };
  const remove = async (itemId, renditionId) => {
    resolve(itemId);
    const rendition = store.get(renditionId);
    const active = jobs.list({ type: "rendition", limit: 200 }).find((entry) => entry.payload?.itemId === itemId
      && (entry.id === renditionId || entry.payload?.profileId === rendition?.profileId) && ["queued", "running"].includes(entry.state));
    if (!rendition && !active) throw httpError(404, "Rendition not found.", "rendition_not_found");
    if (rendition && rendition.itemId !== itemId) throw httpError(404, "Rendition not found.", "rendition_not_found");
    if (active) jobs.cancel(active.id);
    if (!rendition) return true;
    await store.remove(renditionId);
    return true;
  };
  return { build, enqueue, list, remove, setRetention };
};
