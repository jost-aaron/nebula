import { apiJson } from "./http";
import type { MediaRendition, MediaRenditionsResponse, RenditionBuildRequest, RenditionBuildSummary, RenditionProfilesResponse, RenditionRetention } from "../shared/renditionTypes";

export const listRenditionProfiles = () => apiJson<RenditionProfilesResponse>("/api/renditions/profiles");
export const listItemRenditions = (itemId: string) =>
  apiJson<MediaRenditionsResponse>(`/api/renditions/items/${encodeURIComponent(itemId)}`);
export const buildItemRenditions = (itemId: string, request: RenditionBuildRequest) =>
  apiJson<{ builds: RenditionBuildSummary[] }>(`/api/renditions/items/${encodeURIComponent(itemId)}/builds`, { method: "POST", body: JSON.stringify(request) });
export const setRenditionRetention = (itemId: string, renditionId: string, retention: RenditionRetention) =>
  apiJson<{ rendition: MediaRendition }>(`/api/renditions/items/${encodeURIComponent(itemId)}/${encodeURIComponent(renditionId)}`, { method: "PATCH", body: JSON.stringify({ retention }) });
export const deleteRendition = (itemId: string, renditionId: string) =>
  apiJson<{ ok: true }>(`/api/renditions/items/${encodeURIComponent(itemId)}/${encodeURIComponent(renditionId)}`, { method: "DELETE" });
