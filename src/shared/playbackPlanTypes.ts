import type { CatalogId } from "./catalogTypes";
import type { PlaybackQualityPreference, RenditionProfileId } from "./renditionTypes";

export interface PlaybackClientCapabilities {
  audioCodecs: string[];
  containers: string[];
  deviceId: string;
  maxAudioChannels: number | null;
  maxBitrate: number | null;
  maxHeight: number | null;
  maxWidth: number | null;
  subtitleFormats: string[];
  supportsHls: boolean;
  videoCodecs: string[];
}

export type PlaybackDecision = "direct-play" | "remux" | "transcode" | "unsupported";

export interface PlaybackPlanRequest {
  capabilities: PlaybackClientCapabilities;
  itemId: CatalogId;
  quality?: PlaybackQualityPreference;
  sourceId: CatalogId;
}

export interface PlaybackPlanReason {
  code: string;
  message: string;
  streamIndex: number | null;
}

export interface PlaybackPlanResponse {
  decision: PlaybackDecision;
  itemId: CatalogId;
  output: {
    audioCodec: string | null;
    bitrate: number | null;
    container: string | null;
    height?: number | null;
    profileId?: RenditionProfileId | null;
    protocol: "file" | "hls" | null;
    videoCodec: string | null;
    width?: number | null;
    subtitle?: { id: string; delivery: "sidecar" | "embedded" | "burn-in"; format: string | null } | null;
  };
  reasons: PlaybackPlanReason[];
  sourceId: CatalogId;
}
