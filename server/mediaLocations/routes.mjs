import { actorFromContext } from "../audit/service.mjs";
import { json, readBody } from "../http.mjs";

export const createMediaLocationsRoutes = ({ audit = null, jobs, service }) => async (request, response, url) => {
  if (request.method === "GET" && url.pathname === "/api/admin/media-locations") {
    json(response, 200, { locations: service.list() });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/admin/media-locations/reindex") {
    const queued = jobs.enqueue({ type: "scan", payload: { reason: "owner-full-reindex" }, dedupeKey: "library:media-locations", availableAt: Date.now() - 86_400_000 });
    audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: "media.library_reindex_requested", outcome: "success", target: { type: "media-library", id: "shared-content" } });
    json(response, 202, { job: queued.job, scanQueued: queued.created });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/admin/media-locations") {
    const location = await service.add(await readBody(request, { limit: 8 * 1024 }));
    const queued = jobs.enqueue({ type: "scan", payload: { reason: "media-location-added" }, dedupeKey: "library:media-locations", availableAt: Date.now() + 5_000 });
    audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: "media.location_added", outcome: "success", target: { type: "media-location", id: location.id }, metadata: { category: location.category } });
    json(response, 201, { location, scanQueued: queued.created });
    return true;
  }
  const match = /^\/api\/admin\/media-locations\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (request.method === "DELETE" && match) {
    const location = service.remove(match[1]);
    const queued = jobs.enqueue({ type: "scan", payload: { reason: "media-location-removed" }, dedupeKey: "library:media-locations", availableAt: Date.now() + 5_000 });
    audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: "media.location_removed", outcome: "success", target: { type: "media-location", id: location.id }, metadata: { category: location.category } });
    json(response, 200, { location, scanQueued: queued.created });
    return true;
  }
  return false;
};
