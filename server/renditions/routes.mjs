import { json } from "../http.mjs";
import { listRenditionProfiles } from "./profiles.mjs";

export const createRenditionRoutes = () => async (request, response, url) => {
  if (request.method !== "GET" || url.pathname !== "/api/renditions/profiles") return false;
  json(response, 200, { profiles: listRenditionProfiles() });
  return true;
};
