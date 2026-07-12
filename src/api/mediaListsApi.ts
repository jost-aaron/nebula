import { apiJson } from "./http";
import type { MediaList, MediaListKind, MediaListType } from "../shared/mediaListTypes";

const base = (type: MediaListType) => type === "playlist" ? "/api/playlists" : "/api/collections";
export const listMediaLists = (type: MediaListType, mediaKind: Exclude<MediaListKind, "mixed">) =>
  apiJson<{ lists: MediaList[] }>(`${base(type)}?mediaKind=${mediaKind}`);
export const createMediaList = (type: MediaListType, name: string, mediaKind: MediaListKind) =>
  apiJson<{ list: MediaList }>(base(type), { body: JSON.stringify({ mediaKind, name }), headers: { "content-type": "application/json" }, method: "POST" });
export const addMediaListItem = (type: MediaListType, listId: string, itemId: string) =>
  apiJson<{ list: MediaList }>(`${base(type)}/${encodeURIComponent(listId)}/items`, { body: JSON.stringify({ itemId }), headers: { "content-type": "application/json" }, method: "POST" });
