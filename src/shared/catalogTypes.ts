export type CatalogId = string;
export type IsoDateTime = string;

export type LibraryKind = "movies" | "shows" | "music";
export type MediaItemKind = "movie" | "show" | "season" | "episode" | "artist" | "album" | "track";
export type MediaSourceKind = "video" | "audio";
export type MediaAvailability = "pending" | "available" | "missing" | "unavailable";
export type EnrichmentState = "pending" | "ready" | "failed" | "not-applicable";
export type ArtworkKind = "poster" | "backdrop" | "logo" | "thumbnail" | "album-art";

export interface Library {
  createdAt: IsoDateTime;
  id: CatalogId;
  kind: LibraryKind;
  name: string;
  roots: LibraryRoot[];
  updatedAt: IsoDateTime;
}

export interface LibraryRoot {
  enabled: boolean;
  id: CatalogId;
  libraryId: CatalogId;
  /** Server-controlled path relative to the configured content root. */
  path: string;
}

export interface MediaItem {
  availability: MediaAvailability;
  createdAt: IsoDateTime;
  id: CatalogId;
  kind: MediaItemKind;
  libraryId: CatalogId;
  metadata: ExternalMetadata | null;
  parentId: CatalogId | null;
  sourceIds: CatalogId[];
  title: string;
  updatedAt: IsoDateTime;
}

export interface MediaSource {
  availability: MediaAvailability;
  createdAt: IsoDateTime;
  /** A server-controlled, content-root-relative compatibility attribute. */
  contentPath: string;
  fingerprint: string | null;
  id: CatalogId;
  itemId: CatalogId;
  kind: MediaSourceKind;
  modifiedAt: IsoDateTime;
  probeState: EnrichmentState;
  size: number;
  updatedAt: IsoDateTime;
}

export interface MediaStream {
  channels: number | null;
  codec: string;
  default: boolean;
  forced: boolean;
  height: number | null;
  id: CatalogId;
  index: number;
  itemId: CatalogId;
  language: string;
  sourceId: CatalogId;
  title: string;
  type: "video" | "audio" | "subtitle" | "attachment" | "data";
  width: number | null;
}

export interface MediaChapter {
  endSeconds: number | null;
  id: CatalogId;
  sourceId: CatalogId;
  startSeconds: number;
  title: string;
}

export interface ExternalId {
  itemId: CatalogId;
  provider: string;
  providerItemId: string;
}

export interface ExternalMetadata {
  artwork: Artwork[];
  cast: string[];
  genres: string[];
  importedAt: IsoDateTime;
  lockedFields: string[];
  provider: string;
  providerItemId: string;
  rating: string;
  releaseDate: string;
  sortTitle: string;
  studio: string;
  summary: string;
  tagline: string;
  title: string;
}

export interface Artwork {
  cachedPath: string | null;
  height: number | null;
  id: CatalogId;
  itemId: CatalogId;
  kind: ArtworkKind;
  provider: string;
  remoteUrl: string;
  width: number | null;
}

export interface CatalogItemResponse {
  item: MediaItem;
  sources: MediaSource[];
}

/**
 * Additive fields used while current Cinema and Studio clients still rely on
 * path-based entries. They become required after catalog-backed APIs ship.
 */
export interface CatalogCompatibilityIdentity {
  availability?: MediaAvailability;
  id?: CatalogId;
  sourceId?: CatalogId;
}
