import { apiJson, apiUrl } from "./http";
import type {
  CinemaIdentifyRequest,
  CinemaIdentifyResponse,
  CinemaLibraryResponse,
  CinemaMetadataUpdateRequest,
  CinemaMetadataUpdateResponse,
  CinemaTmdbSearchResponse,
  CinemaTmdbStatusResponse,
  CinemaWatchlistUpdateRequest,
  CinemaWatchlistUpdateResponse
} from "../shared/cinemaTypes";

export const listCinemaLibrary = () => apiJson<CinemaLibraryResponse>("/api/cinema/library").then((library) => ({
  entries: library.entries.map((entry) => ({ ...entry, streamUrl: apiUrl(entry.streamUrl) }))
}));

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

export const applyCinemaTmdbMatch = (body: { mediaType: "movie" | "tv"; path: string; tmdbId: number }) =>
  apiJson<CinemaMetadataUpdateResponse>("/api/cinema/tmdb/apply", {
    body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST"
  });

export const refreshCinemaTmdbMetadata = (path: string) =>
  apiJson<CinemaMetadataUpdateResponse>("/api/cinema/tmdb/refresh", {
    body: JSON.stringify({ path }), headers: { "content-type": "application/json" }, method: "POST"
  });
