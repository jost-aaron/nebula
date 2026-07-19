import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { json, readBody } from "../http.mjs";
import { parseByteRange } from "../ranges.mjs";
import { mimeType } from "../storage.mjs";

const principalFor = (request) => request.nebulaAuth?.user
  ? { type: "user", userId: request.nebulaAuth.user.id }
  : request.nebulaAuth?.kind === "guest" ? { type: "guest", sessionId: request.nebulaAuth.sessionId } : { type: "service", userId: null };

const sendFile = async (request, response, asset, explicitType, extraHeaders = {}) => {
  const details = await stat(asset);
  const headers = { "accept-ranges": "bytes", "content-type": explicitType ?? mimeType(asset), ...extraHeaders };
  if (request.method === "HEAD") { response.writeHead(200, { ...headers, "content-length": details.size }); response.end(); return; }
  const range = request.headers.range;
  if (!range) { response.writeHead(200, { ...headers, "content-length": details.size }); createReadStream(asset).pipe(response); return; }
  const parsed = parseByteRange(range, details.size);
  if (!parsed.ok) { response.writeHead(416, { ...headers, "content-range": parsed.contentRange }); response.end(); return; }
  response.writeHead(206, { ...headers, "content-length": parsed.end - parsed.start + 1, "content-range": `bytes ${parsed.start}-${parsed.end}/${details.size}` });
  createReadStream(asset, { start: parsed.start, end: parsed.end }).pipe(response);
};

export const createPlaybackRoutes = (service, planner = null, delivery = null) => async (request, response, url) => {
  const principal = principalFor(request);

  if (request.method === "POST" && url.pathname === "/api/playback/delivery-sessions" && delivery) {
    const result = await delivery.create(await readBody(request), principal);
    json(response, 201, result);
    return true;
  }

  const sessionMatch = /^\/api\/playback\/delivery-sessions\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (sessionMatch && delivery && request.method === "GET") { json(response, 200, { session: delivery.get(sessionMatch[1], principal) }); return true; }
  if (sessionMatch && delivery && request.method === "DELETE") { await delivery.cancel(sessionMatch[1], principal); response.writeHead(204); response.end(); return true; }
  const completeMatch = /^\/api\/playback\/delivery-sessions\/([A-Za-z0-9_-]+)\/complete$/.exec(url.pathname);
  if (completeMatch && delivery && request.method === "POST") { await delivery.complete(completeMatch[1], principal); response.writeHead(204); response.end(); return true; }

  const fileMatch = /^\/api\/playback\/delivery-sessions\/([A-Za-z0-9_-]+)\/file$/.exec(url.pathname);
  if (fileMatch && delivery && ["GET", "HEAD"].includes(request.method)) {
    const asset = await delivery.resolveFile(fileMatch[1], principal);
    await sendFile(request, response, asset.path, asset.type);
    return true;
  }

  const hlsMatch = /^\/api\/playback\/delivery-sessions\/([A-Za-z0-9_-]+)\/hls\/([^/]+)$/.exec(url.pathname);
  if (hlsMatch && delivery && ["GET", "HEAD"].includes(request.method)) {
    let assetName;
    try { assetName = decodeURIComponent(hlsMatch[2]); } catch { throw Object.assign(new Error("The requested delivery asset is invalid."), { status: 400, expose: true }); }
    const asset = await delivery.resolveHlsAsset(hlsMatch[1], assetName, principal);
    const playlist = path.extname(asset) === ".m3u8";
    const type = playlist ? "application/vnd.apple.mpegurl" : "video/mp2t";
    await sendFile(request, response, asset, type, { "cache-control": playlist ? "no-store" : "private, max-age=31536000, immutable" });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/playback/events") {
    json(response, 200, await service.recordEvent(await readBody(request), principal));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/playback/plan" && planner) {
    json(response, 200, await planner.plan(await readBody(request), principal));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/playback/continue-watching") {
    const rawLimit = url.searchParams.get("limit");
    const entries = service.listContinueWatching(rawLimit === null ? {} : { limit: Number(rawLimit) }, principal);
    json(response, 200, { entries });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/playback/history") {
    const rawLimit = url.searchParams.get("limit");
    const entries = service.listHistory(rawLimit === null ? {} : { limit: Number(rawLimit) }, principal);
    json(response, 200, { entries });
    return true;
  }

  if (request.method === "PATCH" && url.pathname === "/api/playback/watched") {
    json(response, 200, { state: await service.setWatched(await readBody(request), principal) });
    return true;
  }

  return false;
};
