import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { json, readBody } from "../http.mjs";

const principalFor = (request) => request.nebulaAuth?.user
  ? { type: "user", userId: request.nebulaAuth.user.id }
  : request.nebulaAuth?.kind === "guest" ? { type: "guest", sessionId: request.nebulaAuth.sessionId } : { type: "service" };

export const createSubtitleRoutes = (service) => async (request, response, url) => {
  const principal = principalFor(request);
  if (url.pathname === "/api/subtitles/preferences") {
    if (request.method === "GET") { json(response, 200, service.getPreference(principal)); return true; }
    if (request.method === "PUT") { json(response, 200, service.setPreference(await readBody(request), principal)); return true; }
  }
  if (url.pathname === "/api/subtitles/provider-status") {
    if (request.method === "GET") { json(response, 200, service.providerStatus()); return true; }
    if (request.method === "PUT") { json(response, 200, service.setProviderConfig(await readBody(request))); return true; }
  }
  const tracks = /^\/api\/subtitles\/items\/([^/]+)\/sources\/([^/]+)$/.exec(url.pathname);
  if (tracks && request.method === "GET") { const result = await service.selection({ itemId: tracks[1], sourceId: tracks[2] }, principal); json(response, 200, { tracks: result.tracks, selectedSubtitleId: result.track?.id ?? null, reason: result.reason }); return true; }
  if (tracks && request.method === "PUT") { json(response, 200, await service.setEphemeralSelection({ itemId: tracks[1], sourceId: tracks[2] }, (await readBody(request)).subtitleId ?? null, principal)); return true; }
  const asset = /^\/api\/subtitles\/items\/([^/]+)\/sources\/([^/]+)\/tracks\/([^/]+)$/.exec(url.pathname);
  if (asset && ["GET", "HEAD"].includes(request.method)) {
    const file = await service.resolveAsset({ itemId: asset[1], sourceId: asset[2] }, asset[3], principal);
    const details = await stat(file.path); response.writeHead(200, { "content-type": file.contentType, "content-length": details.size, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" });
    if (request.method === "HEAD") response.end(); else createReadStream(file.path).pipe(response); return true;
  }
  return false;
};
