import { apiJson, apiUrl } from "./http";
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
import type { MediaChapter } from "../shared/catalogTypes";
import type { ContinueWatchingResponse, PlaybackEventRequest, PlaybackEventResponse } from "../shared/playbackTypes";

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

export const listCinemaLibrary = () => apiJson<CinemaLibraryResponse>("/api/cinema/library").then((library) => ({
  entries: library.entries.map((entry) => ({ ...entry, streamUrl: apiUrl(entry.streamUrl) }))
}));

export const listCinemaCatalog = () =>
  apiJson<{ items: CinemaCatalogEntry[] }>("/api/catalog/items?mediaKind=video");

export const getCinemaCatalogItem = (itemId: string) =>
  apiJson<{ item: CinemaCatalogEntry }>(`/api/catalog/items/${encodeURIComponent(itemId)}`);

export const scanCinemaCatalog = () => apiJson<CinemaCatalogScanResponse>("/api/catalog/scan", { method: "POST" });

export const listCinemaContinueWatching = (limit = 20) =>
  apiJson<ContinueWatchingResponse>(`/api/playback/continue-watching?limit=${limit}`);

export const reportCinemaPlayback = (body: PlaybackEventRequest) =>
  apiJson<PlaybackEventResponse>("/api/playback/events", {
    body: JSON.stringify({ ...body, clientLabel: "Nebula Cinema" }),
    headers: { "content-type": "application/json" },
    method: "POST"
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
