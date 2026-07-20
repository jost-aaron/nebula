import { apiFetch, apiJson, apiUrl } from "./http";
import type { MusicLibraryResponse } from "../shared/musicTypes";
import type { PlaybackEventRequest, PlaybackEventResponse, PlaybackHistoryResponse } from "../shared/playbackTypes";
import type { PlaybackClientCapabilities } from "../shared/playbackPlanTypes";
import type { ClusterPlaybackCreateResponse } from "../shared/clusterTypes";

export const listMusicLibrary = () => apiJson<MusicLibraryResponse>("/api/music/library").then((library) => ({
  entries: library.entries.map((entry) => ({ ...entry, streamUrl: entry.streamUrl ? apiUrl(entry.streamUrl) : "" }))
}));

export const listStudioPlaybackHistory = (limit = 50) =>
  apiJson<PlaybackHistoryResponse>(`/api/playback/history?limit=${limit}`);

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

export const failoverClusterMusicDelivery = (id: string, failedNodeId: string) =>
  apiJson<ClusterPlaybackCreateResponse>(`/api/cluster/playback-sessions/${encodeURIComponent(id)}/failover`, {
    body: JSON.stringify({ failedNodeId }), headers: { "content-type": "application/json" }, method: "POST"
  });

export const cancelClusterMusicDelivery = (id: string) =>
  apiFetch(`/api/cluster/playback-sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).then((response) => {
    if (!response.ok && response.status !== 404) throw new Error(`Cluster delivery cancellation failed: ${response.status}`);
  });
