import { json, readBody } from "../http.mjs";

export const createPlaybackPolicyRoutes = (service) => async (request, response, url) => {
  if (url.pathname === "/api/admin/playback-policy") {
    if (request.method === "GET") { json(response, 200, service.getConfig()); return true; }
    if (request.method === "PUT") { json(response, 200, { global: service.setGlobal(await readBody(request, { limit: 16 * 1024 })) }); return true; }
  }
  if (request.method === "GET" && url.pathname === "/api/admin/playback-policy/status") {
    json(response, 200, service.status()); return true;
  }
  const match = /^\/api\/admin\/playback-policy\/users\/([a-f0-9-]{36})$/i.exec(url.pathname);
  if (request.method === "PUT" && match) {
    json(response, 200, { policy: service.setUser(match[1], await readBody(request, { limit: 16 * 1024 })), userId: match[1] }); return true;
  }
  return false;
};
