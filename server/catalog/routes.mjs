import { json } from "../http.mjs";

export const createCatalogRoutes = ({ repository, scan }) => async (request, response, url) => {
  if (request.method === "GET" && url.pathname === "/api/catalog/items") {
    const mediaKind = url.searchParams.get("mediaKind") || undefined;
    const availability = url.searchParams.get("availability") || undefined;
    json(response, 200, { items: repository.listItems({ availability, mediaKind }) });
    return true;
  }

  const itemMatch = /^\/api\/catalog\/items\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (request.method === "GET" && itemMatch) {
    const item = repository.getItem(itemMatch[1]);
    if (!item) {
      json(response, 404, { error: "Catalog item not found." });
      return true;
    }
    json(response, 200, { item });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/catalog/scan") {
    json(response, 202, { scan: await scan() });
    return true;
  }

  return false;
};
