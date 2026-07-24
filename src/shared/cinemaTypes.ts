import type { CinemaEpisodeMetadata } from "./cinemaTmdbTypes";
import type { CatalogCompatibilityIdentity } from "./catalogTypes";
import type { FederatedAvailabilitySummary } from "./federatedTypes";

export type CinemaCategory = "movies" | "tv";

export type CinemaMediaKind = "video";

export interface CinemaEntry extends CatalogCompatibilityIdentity {
  artworkState: "failed" | "missing" | "processing" | "queued" | "ready";
  backdropUrl: string;
  cast: string;
  category: CinemaCategory;
  collection: string;
  episode: CinemaEpisodeMetadata | null;
  folder: string;
  federation?: FederatedAvailabilitySummary;
  genres: string[];
  mediaKind: CinemaMediaKind;
  modifiedAt: string;
  name: string;
  playable?: boolean;
  path: string;
  posterUrl: string;
  rating: string;
  ratingVotes: number | null;
  releaseYear: string;
  runtimeSeconds: number | null;
  seriesRating?: string;
  seriesRatingVotes?: number | null;
  seriesRuntimeMinutes?: number | null;
  series?: {
    episodeCount: number;
    key: string;
    seasonCount: number;
    seasons: number[];
  };
  size: number;
  sortTitle: string;
  streamUrl: string;
  studio: string;
  summary: string;
  tagline: string;
  title: string;
  tmdbId: number | null;
  tmdbImportedAt: string;
  tmdbMatchCandidateCount?: number;
  tmdbMatchStatus?: "identified" | "needs-review" | "not-found" | "";
  tmdbMediaType: "movie" | "tv" | "";
  watchlisted: boolean;
}

export interface CinemaLibraryResponse {
  entries: CinemaEntry[];
  page: { hasMore: boolean; limit: number; nextOffset: number; offset: number; total: number };
  totals: Record<CinemaCategory, number>;
}

export interface CinemaArtworkStatusResponse {
  activity: {
    failed: number;
    processing: null | {
      kind: "artwork" | "metadata";
      sourceId: string;
      state: "preparing" | "running";
      title: string;
    };
    queued: number;
    ready: number;
  };
  entries: Array<{
    artworkState: CinemaEntry["artworkState"];
    posterUrl: string;
    sourceId: string;
  }>;
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
