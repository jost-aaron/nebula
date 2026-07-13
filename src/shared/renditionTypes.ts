import type { CatalogId, IsoDateTime } from "./catalogTypes";

export const RENDITION_PROFILE_IDS = ["480p", "720p", "1080p"] as const;

export type RenditionProfileId = (typeof RENDITION_PROFILE_IDS)[number];
export type PlaybackQualityPreference =
  | { mode: "auto" }
  | { mode: "original" }
  | { mode: "profile"; profileId: RenditionProfileId };

export interface RenditionProfile {
  audioBitrate: number;
  audioChannels: number;
  audioCodec: "aac";
  container: "mpegts";
  hdrPolicy: "sdr-only";
  id: RenditionProfileId;
  label: string;
  maxFrameRate: number;
  maxHeight: number;
  maxWidth: number;
  pixelFormat: "yuv420p";
  protocol: "hls";
  segmentDurationSeconds: number;
  totalBitrate: number;
  version: number;
  videoBitrate: number;
  videoCodec: "h264";
}

export type RenditionState = "pending" | "building" | "ready" | "failed" | "stale";
export type RenditionRetention = "cache" | "pinned";
export type RenditionOrigin = "interactive" | "scheduled";

export interface MediaRendition {
  audioBitrate: number | null;
  bitrate: number | null;
  completedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  error: { code: string; message: string } | null;
  height: number | null;
  id: CatalogId;
  itemId: CatalogId;
  lastAccessedAt: IsoDateTime | null;
  origin: RenditionOrigin;
  profileId: RenditionProfileId;
  profileVersion: number;
  retention: RenditionRetention;
  sizeBytes: number | null;
  sourceId: CatalogId;
  sourceRevision: number;
  state: RenditionState;
  updatedAt: IsoDateTime;
  videoBitrate: number | null;
  width: number | null;
}

export interface RenditionProfilesResponse {
  profiles: RenditionProfile[];
}

export interface MediaRenditionsResponse {
  profiles: RenditionProfile[];
  renditions: MediaRendition[];
}

export interface RenditionBuildRequest {
  profileIds: RenditionProfileId[];
  retention?: RenditionRetention;
  sourceId: CatalogId;
}

export interface RenditionBuildSummary {
  created: boolean;
  job?: { id: string; state: string; type: "rendition" };
  rendition?: MediaRendition;
}
