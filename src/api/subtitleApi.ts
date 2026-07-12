import { apiJson, apiUrl } from "./http";
import type { SubtitlePreference, SubtitleTracksResponse } from "../shared/subtitleTypes";
const base = (itemId: string, sourceId: string) => `/api/subtitles/items/${encodeURIComponent(itemId)}/sources/${encodeURIComponent(sourceId)}`;
export const getSubtitlePreference = () => apiJson<SubtitlePreference>("/api/subtitles/preferences");
export const saveSubtitlePreference = (value: Pick<SubtitlePreference, "mode" | "languages">) => apiJson<SubtitlePreference>("/api/subtitles/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
export const listSubtitleTracks = (itemId: string, sourceId: string) => apiJson<SubtitleTracksResponse>(base(itemId, sourceId));
export const selectSubtitleTrack = (itemId: string, sourceId: string, subtitleId: string | null) => apiJson<{ selectedSubtitleId: string | null }>(base(itemId, sourceId), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ subtitleId }) });
export const subtitleAssetUrl = (itemId: string, sourceId: string, subtitleId: string) => apiUrl(`${base(itemId, sourceId)}/tracks/${encodeURIComponent(subtitleId)}`);
