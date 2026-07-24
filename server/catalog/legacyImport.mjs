import { readFile } from "node:fs/promises";

const legacyFields = ["album", "artist", "backdropUrl", "cast", "collection", "episode", "genres", "posterUrl", "rating", "ratingVotes", "releaseYear", "runtimeMinutes", "seriesRating", "seriesRatingVotes", "seriesRuntimeMinutes", "sortTitle", "studio", "summary", "tagline", "title"];

export const importLegacyCinemaMetadata = async ({ metadataPath, repository, rootId }) => {
  const raw = await readFile(metadataPath, "utf8").catch((error) => error.code === "ENOENT" ? "{}" : Promise.reject(error));
  const legacy = JSON.parse(raw);
  const result = { imported: 0, skipped: 0, unresolved: [] };
  for (const [contentPath, value] of Object.entries(legacy)) {
    const resolved = repository.resolveContentPath(contentPath, rootId);
    if (!resolved) { result.unresolved.push(contentPath); continue; }
    if (!value || typeof value !== "object") { result.skipped += 1; continue; }
    const fields = Object.fromEntries(legacyFields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));
    const externalIds = value.tmdbId ? [{ id: value.tmdbId, mediaType: value.tmdbMediaType ?? "", provider: "tmdb" }] : [];
    const artwork = [
      value.posterUrl ? { provider: value.tmdbId ? "tmdb" : "legacy", remoteUrl: value.posterUrl, type: "poster" } : null,
      value.backdropUrl ? { provider: value.tmdbId ? "tmdb" : "legacy", remoteUrl: value.backdropUrl, type: "backdrop" } : null
    ].filter(Boolean);
    repository.putExternalMetadata(resolved.itemId, { artwork, externalIds, fields, lockedFields: Object.keys(fields), mode: "manual" });
    result.imported += 1;
  }
  return result;
};
