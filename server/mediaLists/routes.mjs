import { json, readBody } from "../http.mjs";
import { actorFromContext } from "../audit/service.mjs";

const specs = [{ base: "/api/playlists", type: "playlist" }, { base: "/api/collections", type: "collection" }];

export const createMediaListsRoutes = (service, audit = null) => async (request, response, url) => {
  for (const { base, type } of specs) {
    if (url.pathname === base && request.method === "GET") {
      json(response, 200, { lists: service.list({ type, mediaKind: url.searchParams.get("mediaKind") || undefined }, request.nebulaAuth) }); return true;
    }
    if (url.pathname === base && request.method === "POST") {
      const result = service.create({ ...(await readBody(request)), type }, request.nebulaAuth);
      audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: `media_list.${type}_created`, outcome: "success", target: { type, id: result.id } });
      json(response, 201, { list: result }); return true;
    }
    const match = new RegExp(`^${base}/([0-9a-f-]{36})(?:/items(?:/([0-9a-f-]{36}))?)?$`, "i").exec(url.pathname);
    if (!match) continue;
    const [, id, itemId] = match;
    const isItems = url.pathname.includes("/items");
    if (request.method === "GET" && !isItems) { json(response, 200, { list: service.get(id, type, request.nebulaAuth) }); return true; }
    if (request.method === "PATCH" && !isItems) { json(response, 200, { list: service.rename(id, type, (await readBody(request)).name, request.nebulaAuth) }); return true; }
    if (request.method === "DELETE" && !isItems) { service.remove(id, type, request.nebulaAuth); response.writeHead(204).end(); return true; }
    if (request.method === "POST" && isItems && !itemId) { json(response, 200, { list: service.addItem(id, type, (await readBody(request)).itemId, request.nebulaAuth) }); return true; }
    if (request.method === "PUT" && isItems && !itemId) { json(response, 200, { list: service.reorder(id, type, (await readBody(request)).itemIds, request.nebulaAuth) }); return true; }
    if (request.method === "DELETE" && itemId) { json(response, 200, { list: service.removeItem(id, type, itemId, request.nebulaAuth) }); return true; }
  }
  return false;
};
