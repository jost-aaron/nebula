import type { CatalogCompatibilityIdentity } from "./catalogTypes";
import type { FederatedAvailabilitySummary } from "./federatedTypes";

export interface MusicEntry extends CatalogCompatibilityIdentity {
  album: string;
  artist: string;
  collection: string;
  folder: string;
  federation?: FederatedAvailabilitySummary;
  genres: string[];
  mediaKind: "audio";
  modifiedAt: string;
  name: string;
  playable?: boolean;
  path: string;
  posterUrl: string;
  releaseYear: string;
  size: number;
  sortTitle: string;
  streamUrl: string;
  summary: string;
  title: string;
}

export interface MusicLibraryResponse {
  entries: MusicEntry[];
  page: { hasMore: boolean; limit: number; nextOffset: number; offset: number; total: number };
}
