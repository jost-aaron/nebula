export type CinemaCategory = "movies" | "tv";

export type CinemaMediaKind = "video";

export interface CinemaEntry {
  backdropUrl: string;
  cast: string;
  category: CinemaCategory;
  collection: string;
  folder: string;
  genres: string[];
  mediaKind: CinemaMediaKind;
  modifiedAt: string;
  name: string;
  path: string;
  posterUrl: string;
  rating: string;
  releaseYear: string;
  size: number;
  sortTitle: string;
  streamUrl: string;
  studio: string;
  summary: string;
  tagline: string;
  title: string;
  tmdbId: number | null;
  tmdbImportedAt: string;
  tmdbMediaType: "movie" | "tv" | "";
  watchlisted: boolean;
}

export interface CinemaTmdbCandidate {
  backdropUrl: string;
  id: number;
  mediaType: "movie" | "tv";
  overview: string;
  posterUrl: string;
  rating: string;
  title: string;
  year: string;
}

export interface CinemaTmdbStatusResponse {
  attribution: string;
  configured: boolean;
  provider: "TMDB";
}

export interface CinemaTmdbSearchResponse {
  candidates: CinemaTmdbCandidate[];
  normalizedQuery: string;
  provider: "TMDB";
}

export interface CinemaLibraryResponse {
  entries: CinemaEntry[];
}

export interface CinemaIdentificationFrame {
  image: string;
  index: number;
  time: number;
}

export interface CinemaIdentifyRequest {
  frames: CinemaIdentificationFrame[];
  path: string;
  title: string;
}

export interface CinemaIdentifyResponse {
  candidates: Array<{ name: string; score: number }>;
  frameQueries: string[];
  providers: Array<{
    configured: boolean;
    provider: string;
    results: Array<{
      frameIndex: number;
      pages?: Array<{ score: number; title: string; url: string }>;
      visualMatches?: string[];
      webEntities?: Array<{ description: string; score: number }>;
    }>;
  }>;
  searchedAt: string;
}

export interface CinemaMetadataUpdateRequest {
  cast: string;
  collection: string;
  genres: string;
  path: string;
  posterUrl: string;
  rating: string;
  releaseYear: string;
  sortTitle: string;
  studio: string;
  summary: string;
  tagline: string;
  title: string;
}

export interface CinemaMetadataUpdateResponse {
  metadata: Record<string, unknown>;
  ok: boolean;
  path: string;
}

export interface CinemaWatchlistUpdateRequest {
  path: string;
  watchlisted: boolean;
}

export interface CinemaWatchlistUpdateResponse {
  metadata: Record<string, unknown>;
  ok: boolean;
  path: string;
  watchlisted: boolean;
}
