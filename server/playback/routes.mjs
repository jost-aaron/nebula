import { json, readBody } from "../http.mjs";

const principalFor = (request) => request.nebulaAuth?.user
  ? { type: "user", userId: request.nebulaAuth.user.id }
  : { type: "service", userId: null };

export const createPlaybackRoutes = (service) => async (request, response, url) => {
  const principal = principalFor(request);

  if (request.method === "POST" && url.pathname === "/api/playback/events") {
    json(response, 200, await service.recordEvent(await readBody(request), principal));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/playback/continue-watching") {
    const rawLimit = url.searchParams.get("limit");
    const entries = service.listContinueWatching(rawLimit === null ? {} : { limit: Number(rawLimit) }, principal);
    json(response, 200, { entries });
    return true;
  }

  if (request.method === "PATCH" && url.pathname === "/api/playback/watched") {
    json(response, 200, { state: await service.setWatched(await readBody(request), principal) });
    return true;
  }

  return false;
};
