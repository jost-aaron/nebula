export type MediaListKind = "audio" | "mixed" | "video";
export type MediaListType = "collection" | "playlist";
export interface MediaListItem { available: boolean; id: string; mediaKind: "audio" | "video"; position: number; title: string; }
export interface MediaList { createdAt: string; id: string; itemCount: number; items: MediaListItem[]; mediaKind: MediaListKind; name: string; type: MediaListType; updatedAt: string; }
