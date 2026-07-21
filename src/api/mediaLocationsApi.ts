import { apiJson } from "./http";
import type { MediaLocation, MediaLocationCategory, MediaLocationsResponse } from "../shared/mediaLocationTypes";

export const listMediaLocations = () => apiJson<MediaLocationsResponse>("/api/admin/media-locations");
export const addMediaLocation = (category: MediaLocationCategory, contentPath: string) => apiJson<{ location: MediaLocation; scanQueued: boolean }>("/api/admin/media-locations", {
  body: JSON.stringify({ category, contentPath }), headers: { "content-type": "application/json" }, method: "POST"
});
export const removeMediaLocation = (id: string) => apiJson<{ location: MediaLocation; scanQueued: boolean }>(`/api/admin/media-locations/${encodeURIComponent(id)}`, { method: "DELETE" });
export const reindexMediaLibrary = () => apiJson<{ job: { id: string }; scanQueued: boolean }>("/api/admin/media-locations/reindex", { method: "POST" });
