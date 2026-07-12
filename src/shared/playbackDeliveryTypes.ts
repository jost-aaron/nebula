import type { PlaybackPlanRequest, PlaybackPlanResponse } from "./playbackPlanTypes";

export type PlaybackDeliveryStatus = "queued" | "running" | "ready" | "failed" | "cancelled" | "expired";
export interface PlaybackDeliverySession {
  createdAt: string;
  decision: PlaybackPlanResponse["decision"];
  deliveryUrl: string;
  expiresAt: string;
  id: string;
  itemId: string;
  sourceId: string;
  status: PlaybackDeliveryStatus;
}
export interface PlaybackDeliveryCreateResponse { plan: PlaybackPlanResponse; session: PlaybackDeliverySession; }
export interface PlaybackDeliveryStatusResponse { session: PlaybackDeliverySession; }
export type PlaybackDeliveryCreateRequest = PlaybackPlanRequest;
