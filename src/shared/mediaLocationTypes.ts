export type MediaLocationCategory = "movies" | "tv" | "music";

export interface MediaLocation {
  category: MediaLocationCategory;
  contentPath: string;
  createdAt: string;
  id: string;
  updatedAt: string;
}

export interface MediaLocationsResponse {
  locations: MediaLocation[];
}
