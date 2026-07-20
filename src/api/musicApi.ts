import { apiJson, apiUrl } from "./http";
import type { MusicLibraryResponse } from "../shared/musicTypes";
import type { PlaybackEventRequest, PlaybackEventResponse, PlaybackHistoryResponse } from "../shared/playbackTypes";

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
