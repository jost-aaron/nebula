import type { CatalogId, IsoDateTime } from "./catalogTypes";

export type PlaybackEventKind = "start" | "progress" | "pause" | "stop" | "complete";
export type PlaybackIdentityKind = "local" | "federated";

/** Coordinator-owned opaque identity; never a shard-local catalog ID or path. */
export interface FederatedPlaybackIdentity {
  itemId: string;
  sourceId: string;
}

export interface PlaybackState {
  completed: boolean;
  durationSeconds: number | null;
  federatedIdentity?: FederatedPlaybackIdentity;
  identityKind?: PlaybackIdentityKind;
  itemId: string;
  lastPlayedAt: IsoDateTime | null;
  playCount: number;
  positionSeconds: number;
  sourceId: string | null;
  updatedAt: IsoDateTime;
  userId: string;
}

export interface PlaybackSession {
  clientLabel: string;
  createdAt: IsoDateTime;
  id: CatalogId;
  federatedIdentity?: FederatedPlaybackIdentity;
  identityKind?: PlaybackIdentityKind;
  itemId: string;
  lastReportedAt: IsoDateTime;
  sourceId: string;
  state: "active" | "paused" | "stopped" | "completed";
  userId: string;
}

interface PlaybackEventRequestBase {
  durationSeconds: number | null;
  event: PlaybackEventKind;
  /** Client-generated retry/idempotency key. */
  eventId: CatalogId;
  positionSeconds: number;
  sessionId: CatalogId | null;
}

export type PlaybackEventRequest = PlaybackEventRequestBase & (
  | { federatedIdentity?: never; itemId: CatalogId; sourceId: CatalogId }
  | { federatedIdentity: FederatedPlaybackIdentity; itemId?: never; sourceId?: never }
);

export interface PlaybackEventResponse {
  session: PlaybackSession;
  state: PlaybackState;
}

export interface ContinueWatchingEntry {
  federatedIdentity?: FederatedPlaybackIdentity;
  identityKind?: PlaybackIdentityKind;
  itemId: string;
  lastPlayedAt: IsoDateTime;
  positionSeconds: number;
  progress: number;
  sourceId: string | null;
}

export interface ContinueWatchingResponse {
  entries: ContinueWatchingEntry[];
}

export interface PlaybackHistoryEntry extends ContinueWatchingEntry {
  completed: boolean;
  durationSeconds: number | null;
  playCount: number;
}

export interface PlaybackHistoryResponse {
  entries: PlaybackHistoryEntry[];
}

export type PlaybackWatchedRequest = (
  | { federatedIdentity?: never; itemId: CatalogId; sourceId: CatalogId }
  | { federatedIdentity: FederatedPlaybackIdentity; itemId?: never; sourceId?: never }
) & {
  watched: boolean;
};
