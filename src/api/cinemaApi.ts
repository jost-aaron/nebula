import { apiFetch, apiJson, apiUrl } from "./http";
import type {
  CinemaIdentifyRequest,
  CinemaIdentifyResponse,
  CinemaLibraryResponse,
  CinemaMetadataUpdateRequest,
  CinemaMetadataUpdateResponse,
  CinemaWatchlistUpdateRequest,
  CinemaWatchlistUpdateResponse
} from "../shared/cinemaTypes";
import type { CinemaTmdbSearchResponse, CinemaTmdbStatusResponse } from "../shared/cinemaTmdbTypes";
import type { CatalogItemResponse, MediaChapter } from "../shared/catalogTypes";
import type { ContinueWatchingResponse, PlaybackEventRequest, PlaybackEventResponse } from "../shared/playbackTypes";
import type { PlaybackWatchedRequest, PlaybackState } from "../shared/playbackTypes";
import type { PlaybackDeliveryCreateRequest, PlaybackDeliveryCreateResponse, PlaybackDeliveryStatusResponse } from "../shared/playbackDeliveryTypes";
import type { ClusterPlaybackCreateResponse } from "../shared/clusterTypes";

export interface CinemaCatalogEntry {
  availability?: string;
  chapters?: MediaChapter[];
  id: string;
  path?: string;
  probeState?: string;
  source?: { availability?: string; id?: string; path?: string; probeState?: string };
  sourceId?: string;
}

export interface CinemaCatalogScanResponse {
  scan: {
    changed?: number;
    discovered?: number;
    error?: string;
    id?: string;
    new?: number;
    status?: string;
  };
}

export const listCinemaLibrary = ({ category, limit = 60, offset = 0, query = "" }: { category?: "movies" | "tv"; limit?: number; offset?: number; query?: string } = {}) => apiJson<CinemaLibraryResponse>(`/api/cinema/library?limit=${limit}&offset=${offset}${category ? `&category=${category}` : ""}${query ? `&query=${encodeURIComponent(query)}` : ""}`).then((library) => ({
  entries: library.entries.map((entry) => ({ ...entry, streamUrl: entry.streamUrl ? apiUrl(entry.streamUrl) : "" })),
  page: library.page,
  totals: library.totals
}));

export const listCinemaCatalog = () =>
  apiJson<{ items: CinemaCatalogEntry[] }>("/api/catalog/items?mediaKind=video");

export const getCinemaCatalogItem = (itemId: string) =>
  apiJson<CatalogItemResponse>(`/api/catalog/items/${encodeURIComponent(itemId)}`);

export const scanCinemaCatalog = () => apiJson<CinemaCatalogScanResponse>("/api/catalog/scan", { method: "POST" });

export const listCinemaContinueWatching = (limit = 20) =>
  apiJson<ContinueWatchingResponse>(`/api/playback/continue-watching?limit=${limit}`);

export const reportCinemaPlayback = (body: PlaybackEventRequest) =>
  apiJson<PlaybackEventResponse>("/api/playback/events", {
    body: JSON.stringify({ ...body, clientLabel: "Nebula Cinema" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

export const updateCinemaWatched = (body: PlaybackWatchedRequest) =>
  apiJson<{ state: PlaybackState }>("/api/playback/watched", {
    body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "PATCH"
  });

export const createCinemaDelivery = (body: PlaybackDeliveryCreateRequest) => apiJson<PlaybackDeliveryCreateResponse>("/api/playback/delivery-sessions", {
  body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST"
});
export const getCinemaDelivery = (id: string, signal?: AbortSignal) => apiJson<PlaybackDeliveryStatusResponse>(`/api/playback/delivery-sessions/${encodeURIComponent(id)}`, { signal });
export const cancelCinemaDelivery = (id: string) => apiFetch(`/api/playback/delivery-sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).then((response) => {
  if (!response.ok && response.status !== 404) throw new Error(`Delivery cancellation failed: ${response.status}`);
});
export const completeCinemaDelivery = (id: string) => apiFetch(`/api/playback/delivery-sessions/${encodeURIComponent(id)}/complete`, { method: "POST" }).then((response) => {
  if (!response.ok && response.status !== 404) throw new Error(`Delivery completion failed: ${response.status}`);
});

export const createClusterCinemaDelivery = (body: { capabilities: PlaybackDeliveryCreateRequest["capabilities"]; federatedItemId: string; preferredProfileId: string; startPositionSeconds?: number | null; subtitleId?: string | null }) =>
  apiJson<ClusterPlaybackCreateResponse>("/api/cluster/playback-sessions", {
    body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST"
  });
export const getClusterCinemaDelivery = (id: string, signal?: AbortSignal) =>
  apiJson<ClusterPlaybackCreateResponse>(`/api/cluster/playback-sessions/${encodeURIComponent(id)}`, { signal });
export const failoverClusterCinemaDelivery = (id: string, failedNodeId: string) =>
  apiJson<ClusterPlaybackCreateResponse>(`/api/cluster/playback-sessions/${encodeURIComponent(id)}/failover`, {
    body: JSON.stringify({ failedNodeId }), headers: { "content-type": "application/json" }, method: "POST"
  });
export const cancelClusterCinemaDelivery = (id: string) => apiFetch(`/api/cluster/playback-sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).then((response) => {
  if (!response.ok && response.status !== 404) throw new Error(`Cluster delivery cancellation failed: ${response.status}`);
});

export const identifyCinemaFrames = (body: CinemaIdentifyRequest) =>
  apiJson<CinemaIdentifyResponse>("/api/cinema/identify", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

export const updateCinemaMetadata = (body: CinemaMetadataUpdateRequest) =>
  apiJson<CinemaMetadataUpdateResponse>("/api/cinema/metadata", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  });

export const updateCinemaWatchlist = (body: CinemaWatchlistUpdateRequest) =>
  apiJson<CinemaWatchlistUpdateResponse>("/api/cinema/watchlist", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  });

export const getCinemaTmdbStatus = () => apiJson<CinemaTmdbStatusResponse>("/api/cinema/tmdb/status");

export const searchCinemaTmdb = (body: { category: "movies" | "tv"; path: string; query: string; year?: string }) =>
  apiJson<CinemaTmdbSearchResponse>("/api/cinema/tmdb/search", {
    body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST"
  });

export const applyCinemaTmdbMatch = (body: { episodeNumber?: number | null; mediaType: "movie" | "tv"; path: string; seasonNumber?: number | null; tmdbId: number }) =>
  apiJson<CinemaMetadataUpdateResponse>("/api/cinema/tmdb/apply", {
    body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST"
  });

export const refreshCinemaTmdbMetadata = (path: string) =>
  apiJson<CinemaMetadataUpdateResponse>("/api/cinema/tmdb/refresh", {
    body: JSON.stringify({ path }), headers: { "content-type": "application/json" }, method: "POST"
  });
