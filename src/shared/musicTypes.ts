import type { CatalogCompatibilityIdentity } from "./catalogTypes";
import type { FederatedAvailabilitySummary } from "./federatedTypes";

export interface MusicEntry extends CatalogCompatibilityIdentity {
  album: string;
  artist: string;
  artworkState: "failed" | "missing" | "processing" | "queued" | "ready";
  collection: string;
  folder: string;
  federation?: FederatedAvailabilitySummary;
  genres: string[];
  mediaKind: "audio";
  modifiedAt: string;
  musicbrainzImportedAt: string;
  musicbrainzMatchCandidateCount: number;
  musicbrainzMatchStatus: "" | "identified" | "needs-review" | "not-found";
  musicbrainzRecordingId: string | null;
  musicbrainzReleaseGroupId: string;
  musicbrainzReleaseId: string;
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

export interface MusicBrainzCandidate {
  album: string;
  artist: string;
  confidence: number;
  durationMs: number | null;
  recordingId: string;
  releaseGroupId: string;
  releaseId: string;
  releaseYear: string;
  title: string;
}

export interface MusicBrainzCandidatesResponse {
  candidates: MusicBrainzCandidate[];
  provider: "MusicBrainz";
}

export interface MusicLibraryResponse {
  entries: MusicEntry[];
  page: { hasMore: boolean; limit: number; nextOffset: number; offset: number; total: number };
}
