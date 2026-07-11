import type { CatalogCompatibilityIdentity } from "./catalogTypes";

export interface MusicEntry extends CatalogCompatibilityIdentity {
  album: string;
  artist: string;
  collection: string;
  folder: string;
  genres: string[];
  mediaKind: "audio";
  modifiedAt: string;
  name: string;
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
}
