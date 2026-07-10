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
