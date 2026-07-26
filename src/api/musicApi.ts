import { apiFetch, apiJson, apiUrl } from "./http";
import type { MusicBrainzCandidatesResponse, MusicLibraryResponse } from "../shared/musicTypes";
import type { PlaybackEventRequest, PlaybackEventResponse, PlaybackHistoryResponse } from "../shared/playbackTypes";
import type { PlaybackClientCapabilities } from "../shared/playbackPlanTypes";
import type { ClusterPlaybackCreateResponse } from "../shared/clusterTypes";

export const listMusicLibrary = ({
  limit = 100,
  offset = 0,
  query = "",
  signal
}: { limit?: number; offset?: number; query?: string; signal?: AbortSignal } = {}) => apiJson<MusicLibraryResponse>(`/api/music/library?limit=${limit}&offset=${offset}${query ? `&query=${encodeURIComponent(query)}` : ""}`, { signal }).then((library) => ({
  entries: library.entries.map((entry) => ({ ...entry, streamUrl: entry.streamUrl ? apiUrl(entry.streamUrl) : "" })),
  page: library.page
}));

export const createMusicMediaTicket = (path: string) =>
  apiJson<{ streamUrl: string }>("/api/music/ticket", {
    body: JSON.stringify({ path }),
    headers: { "content-type": "application/json" },
    method: "POST"
  }).then((result) => apiUrl(result.streamUrl));

export const listStudioPlaybackHistory = (limit = 50, signal?: AbortSignal) =>
  apiJson<PlaybackHistoryResponse>(`/api/playback/history?limit=${limit}`, { signal });

export const reportStudioPlayback = (body: PlaybackEventRequest) =>
  apiJson<PlaybackEventResponse>("/api/playback/events", {
    body: JSON.stringify({ ...body, clientLabel: "Nebula Studio" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

export const createClusterMusicDelivery = (body: {
  capabilities: PlaybackClientCapabilities;
  federatedItemId: string;
  preferredProfileId: "original";
  startPositionSeconds?: number | null;
}) => apiJson<ClusterPlaybackCreateResponse>("/api/cluster/playback-sessions", {
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
  method: "POST"
});

export const getClusterMusicDelivery = (id: string, signal?: AbortSignal) =>
  apiJson<ClusterPlaybackCreateResponse>(`/api/cluster/playback-sessions/${encodeURIComponent(id)}`, { signal });

export const failoverClusterMusicDelivery = (id: string, failedNodeId: string) =>
  apiJson<ClusterPlaybackCreateResponse>(`/api/cluster/playback-sessions/${encodeURIComponent(id)}/failover`, {
    body: JSON.stringify({ failedNodeId }), headers: { "content-type": "application/json" }, method: "POST"
  });

export const cancelClusterMusicDelivery = (id: string) =>
  apiFetch(`/api/cluster/playback-sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).then((response) => {
    if (!response.ok && response.status !== 404) throw new Error(`Cluster delivery cancellation failed: ${response.status}`);
  });

export const listMusicBrainzCandidates = (path: string) =>
  apiJson<MusicBrainzCandidatesResponse>(`/api/music/metadata/candidates?path=${encodeURIComponent(path)}`);

export const searchMusicBrainz = (body: { album?: string; artist?: string; path: string; query: string }) =>
  apiJson<MusicBrainzCandidatesResponse>("/api/music/metadata/search", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

export const applyMusicBrainzMatch = (body: { path: string; recordingId: string; releaseId?: string }) =>
  apiJson<{ artworkQueued: boolean; matched: boolean }>("/api/music/metadata/apply", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

export const refreshMusicBrainzMetadata = (path: string) =>
  apiJson<{ ok: boolean }>("/api/music/metadata/refresh", {
    body: JSON.stringify({ path }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
