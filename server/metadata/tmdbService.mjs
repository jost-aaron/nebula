import path from "node:path";
import { normalizeMediaQuery } from "../tmdb.mjs";

const canonicalTitle = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const selectCandidate = (candidates, query, year) => {
  const title = canonicalTitle(query);
  const exact = candidates.filter((candidate) => canonicalTitle(candidate.title) === title);
  if (!exact.length) return null;
  if (year) return exact.find((candidate) => candidate.year === year) ?? exact[0];
  return exact[0];
};

export const createTmdbMetadataService = ({ repository, tmdb, readLegacyMetadata, writeLegacyMetadata } = {}) => {
  if (!repository?.getSource || !repository?.getItem || !repository?.putExternalMetadata) {
    throw new TypeError("A catalog repository is required.");
  }
  if (!tmdb?.search || !tmdb?.details || !tmdb?.episodeDetails) {
    throw new TypeError("A TMDB client is required.");
  }

  const refreshSource = async ({ sourceId }, context = {}) => {
    const source = repository.getSource(sourceId);
    if (!source || source.availability !== "available" || source.mediaKind !== "video") {
      return { matched: false, reason: "source_unavailable", sourceId };
    }
    const item = repository.getItem(source.itemId);
    if (!item) return { matched: false, reason: "item_missing", sourceId };

    context.reportProgress?.(0.1, "searching-tmdb");
    const normalized = normalizeMediaQuery(path.posix.basename(source.path));
    const category = item.itemType === "episode" ? "tv" : "movies";
    const candidates = await tmdb.search({
      category,
      episodeNumber: normalized.episodeNumber,
      query: normalized.query,
      seasonNumber: normalized.seasonNumber,
      year: normalized.year
    });
    const match = selectCandidate(candidates, normalized.query, normalized.year);
    if (!match) return { matched: false, query: normalized.query, reason: "no_confident_match", sourceId };

    context.reportProgress?.(0.55, "fetching-tmdb-details");
    const episode = category === "tv" && normalized.seasonNumber !== null && normalized.episodeNumber !== null;
    const fields = episode
      ? await tmdb.episodeDetails(match.id, normalized.seasonNumber, normalized.episodeNumber)
      : await tmdb.details(match.mediaType, match.id);
    repository.putExternalMetadata(item.id, {
      externalIds: [{ id: match.id, mediaType: match.mediaType, provider: "tmdb" }],
      fields,
      mode: "provider"
    });

    if (readLegacyMetadata && writeLegacyMetadata) {
      const metadata = await readLegacyMetadata();
      metadata[source.path] = { ...(metadata[source.path] ?? {}), ...fields, episode: fields.episode ?? null };
      await writeLegacyMetadata(metadata);
    }
    context.reportProgress?.(0.95, "tmdb-metadata-ready");
    return { itemId: item.id, matched: true, mediaType: match.mediaType, sourceId, tmdbId: match.id };
  };

  const enqueueAll = (enqueue, { availableAt = Date.now(), batchId = "manual", intervalMs = 1_500 } = {}) => {
    let queued = 0;
    for (const item of repository.listItems({ availability: "available", mediaKind: "video" })) {
      enqueue({
        availableAt: availableAt + queued * intervalMs,
        dedupeKey: `${batchId}:${item.source.id}:${item.source.contentRevision}`,
        maxAttempts: 1,
        payload: { sourceId: item.source.id },
        type: "metadata"
      });
      queued += 1;
    }
    return { intervalMs, queued };
  };

  return { enqueueAll, refreshSource };
};

export { canonicalTitle, selectCandidate };
