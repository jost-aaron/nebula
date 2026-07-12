import { json } from "../http.mjs";

export const createAuditRoutes = (service) => async (request, response, url) => {
  if (request.method !== "GET" || url.pathname !== "/api/admin/audit") return false;
  json(response, 200, service.list({
    actorKind: url.searchParams.get("actorKind"),
    cursor: url.searchParams.get("cursor"),
    eventType: url.searchParams.get("eventType"),
    from: url.searchParams.get("from"),
    limit: Number(url.searchParams.get("limit") || 50),
    outcome: url.searchParams.get("outcome"),
    principalId: url.searchParams.get("principalId"),
    to: url.searchParams.get("to")
  }));
  return true;
};
