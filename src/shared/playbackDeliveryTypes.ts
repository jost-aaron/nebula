import type { PlaybackPlanRequest, PlaybackPlanResponse } from "./playbackPlanTypes";
import type { RenditionProfileId } from "./renditionTypes";

export type PlaybackDeliveryStatus = "queued" | "running" | "ready" | "failed" | "cancelled" | "expired";
export interface PlaybackDeliverySession {
  createdAt: string;
  decision: PlaybackPlanResponse["decision"];
  deliveryUrl: string;
  expiresAt: string;
  id: string;
  itemId: string;
  profileId?: RenditionProfileId | null;
  renditionId?: string | null;
  sourceId: string;
  sourceRevision?: number | null;
  status: PlaybackDeliveryStatus;
}
export interface PlaybackDeliveryCreateResponse { plan: PlaybackPlanResponse; session: PlaybackDeliverySession; }
export interface PlaybackDeliveryStatusResponse { session: PlaybackDeliverySession; }
export type PlaybackDeliveryCreateRequest = PlaybackPlanRequest;
