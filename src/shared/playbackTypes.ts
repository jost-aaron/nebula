import type { CatalogId, IsoDateTime } from "./catalogTypes";

export type PlaybackEventKind = "start" | "progress" | "pause" | "stop" | "complete";

export interface PlaybackState {
  completed: boolean;
  durationSeconds: number | null;
  itemId: CatalogId;
  lastPlayedAt: IsoDateTime | null;
  playCount: number;
  positionSeconds: number;
  sourceId: CatalogId | null;
  updatedAt: IsoDateTime;
  userId: string;
}

export interface PlaybackSession {
  clientLabel: string;
  createdAt: IsoDateTime;
  id: CatalogId;
  itemId: CatalogId;
  lastReportedAt: IsoDateTime;
  sourceId: CatalogId;
  state: "active" | "paused" | "stopped" | "completed";
  userId: string;
}

export interface PlaybackEventRequest {
  durationSeconds: number | null;
  event: PlaybackEventKind;
  /** Client-generated retry/idempotency key. */
  eventId: CatalogId;
  itemId: CatalogId;
  positionSeconds: number;
  sessionId: CatalogId | null;
  sourceId: CatalogId;
}

export interface PlaybackEventResponse {
  session: PlaybackSession;
  state: PlaybackState;
}

export interface ContinueWatchingEntry {
  itemId: CatalogId;
  lastPlayedAt: IsoDateTime;
  positionSeconds: number;
  progress: number;
  sourceId: CatalogId | null;
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

export interface PlaybackWatchedRequest {
  itemId: CatalogId;
  sourceId: CatalogId;
  watched: boolean;
}
