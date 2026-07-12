import { json, readBody } from "../http.mjs";

export const createAccelerationRoutes = (service) => async (request, response, url) => {
  if (url.pathname !== "/api/admin/transcode-acceleration") return false;
  if (request.method === "GET") { json(response, 200, await service.status()); return true; }
  if (request.method === "PUT") {
    const body = await readBody(request, { limit: 8 * 1024 });
    service.setMode(body?.mode);
    json(response, 200, await service.status()); return true;
  }
  if (request.method === "POST") { await service.refresh(); json(response, 200, await service.status()); return true; }
  return false;
};
