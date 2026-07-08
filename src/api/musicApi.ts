import { apiJson } from "./http";
import type { MusicLibraryResponse } from "../shared/musicTypes";

export const listMusicLibrary = () => apiJson<MusicLibraryResponse>("/api/music/library");
