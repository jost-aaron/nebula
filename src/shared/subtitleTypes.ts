export type SubtitleMode = "off" | "forced-only" | "preferred";
export interface SubtitleTrack { id: string; kind: "embedded" | "sidecar"; format: string; language: string | null; forced: boolean; default: boolean; label: string; streamIndex?: number; }
export interface SubtitlePreference { mode: SubtitleMode; languages: string[]; persistent: boolean; }
export interface SubtitleTracksResponse { tracks: SubtitleTrack[]; selectedSubtitleId: string | null; reason: string; }
