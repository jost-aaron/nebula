import { apiJson, apiUrl } from "./http";
import type { MusicLibraryResponse } from "../shared/musicTypes";

export const listMusicLibrary = () => apiJson<MusicLibraryResponse>("/api/music/library").then((library) => ({
  entries: library.entries.map((entry) => ({ ...entry, streamUrl: apiUrl(entry.streamUrl) }))
}));
