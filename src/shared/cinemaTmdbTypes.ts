export interface CinemaEpisodeMetadata {
  airDate: string;
  episodeNumber: number;
  seasonNumber: number;
  seriesTitle: string;
}

export interface CinemaTmdbCandidate {
  backdropUrl: string;
  episodeNumber: number | null;
  id: number;
  mediaType: "movie" | "tv";
  overview: string;
  posterUrl: string;
  rating: string;
  ratingVotes: number | null;
  seasonNumber: number | null;
  title: string;
  year: string;
  confidence?: number;
  matchedQuery?: string;
  reasons?: string[];
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
  stored?: boolean;
}

export interface CinemaTmdbCandidatesResponse {
  candidates: CinemaTmdbCandidate[];
  provider: "TMDB";
}
