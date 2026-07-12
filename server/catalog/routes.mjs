import { json } from "../http.mjs";

export const createCatalogRoutes = ({ libraryPermissions = null, probeReader = null, repository, scan }) => async (request, response, url) => {
  if (request.method === "GET" && url.pathname === "/api/catalog/items") {
    const mediaKind = url.searchParams.get("mediaKind") || undefined;
    const availability = url.searchParams.get("availability") || undefined;
    const items = repository.listItems({ availability, mediaKind });
    json(response, 200, { items: libraryPermissions ? libraryPermissions.filterItems(request.nebulaAuth, items) : items });
    return true;
  }

  const itemMatch = /^\/api\/catalog\/items\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (request.method === "GET" && itemMatch) {
    const item = repository.getItem(itemMatch[1]);
    if (!item || (libraryPermissions && !libraryPermissions.canAccessLibrary(request.nebulaAuth, item.libraryId))) {
      json(response, 404, { error: "Catalog item not found." });
      return true;
    }
    const listed = repository.listItems().find((candidate) => candidate.id === item.id);
    const source = listed?.source ?? null;
    const probe = source && probeReader ? probeReader.get(source.id) : { chapters: [], format: null, probeState: "pending", streams: [] };
    json(response, 200, { artwork: repository.listArtwork(item.id), chapters: probe.chapters, format: probe.format, item, probeState: probe.probeState, sources: source ? [source] : [], streams: probe.streams });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/catalog/scan") {
    json(response, 202, { scan: await scan() });
    return true;
  }

  return false;
};
