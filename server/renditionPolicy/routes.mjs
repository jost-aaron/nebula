import { actorFromContext } from "../audit/service.mjs";
import { json, readBody } from "../http.mjs";

export const createRenditionPolicyRoutes = (service, audit = null) => async (request, response, url) => {
  if (url.pathname === "/api/admin/rendition-policy") {
    if (request.method === "GET") { json(response, 200, { policy: service.get() }); return true; }
    if (request.method === "PUT") {
      const policy = service.set(await readBody(request, { limit: 32 * 1024 }));
      audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: "rendition.policy_changed", outcome: "success", target: { type: "server", id: "rendition-storage" } });
      json(response, 200, { policy }); return true;
    }
  }
  if (request.method === "GET" && url.pathname === "/api/admin/renditions/status") { json(response, 200, await service.status()); return true; }
  if (request.method === "POST" && url.pathname === "/api/admin/renditions/cleanup") {
    const result = service.enqueueCleanup("manual");
    audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: "rendition.cleanup_requested", outcome: "success", target: { type: "job", id: result.job.id }, metadata: { created: result.created, reason: "manual" } });
    json(response, 202, result); return true;
  }
  return false;
};
