import { json, readBody } from "../http.mjs";
import { actorFromContext } from "../audit/service.mjs";
import { listRenditionProfiles } from "./profiles.mjs";

export const createRenditionRoutes = (service = null, audit = null) => async (request, response, url) => {
  if (request.method === "GET" && url.pathname === "/api/renditions/profiles") {
    json(response, 200, { profiles: listRenditionProfiles() });
    return true;
  }
  if (!service) return false;
  const itemMatch = /^\/api\/renditions\/items\/([0-9a-f-]{36})(?:\/builds)?$/i.exec(url.pathname);
  if (itemMatch && request.method === "GET" && !url.pathname.endsWith("/builds")) {
    json(response, 200, service.list(itemMatch[1], request.nebulaAuth));
    return true;
  }
  if (itemMatch && request.method === "POST" && url.pathname.endsWith("/builds")) {
    const body = await readBody(request);
    const result = service.enqueue(itemMatch[1], body, request.nebulaAuth);
    json(response, 202, result);
    return true;
  }
  const renditionMatch = /^\/api\/renditions\/items\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (renditionMatch && request.method === "PATCH") {
    const body = await readBody(request);
    const rendition = service.setRetention(renditionMatch[1], renditionMatch[2], body?.retention);
    audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: "rendition.retention_changed", outcome: "success", target: { type: "rendition", id: rendition.id }, metadata: { retention: rendition.retention } });
    json(response, 200, { rendition });
    return true;
  }
  if (renditionMatch && request.method === "DELETE") {
    await service.remove(renditionMatch[1], renditionMatch[2]);
    audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: "rendition.deleted", outcome: "success", target: { type: "rendition", id: renditionMatch[2] } });
    json(response, 200, { ok: true });
    return true;
  }
  return false;
};
