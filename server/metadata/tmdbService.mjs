import path from "node:path";
import { normalizeMediaQuery } from "../tmdb.mjs";

const canonicalTitle = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const titleTokens = (value) => String(value ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
const boundedCandidates = (candidates) => candidates.slice(0, 8).map(({ confidence, matchedQuery, reasons, ...candidate }) => ({
  ...candidate,
  confidence: Number(confidence.toFixed(3)),
  matchedQuery,
  reasons
}));

const diceCoefficient = (left, right) => {
  const pairs = (value) => {
    const normalized = canonicalTitle(value);
    if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
    return new Set(Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2)));
  };
  const a = pairs(left);
  const b = pairs(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  a.forEach((pair) => { if (b.has(pair)) shared += 1; });
  return (2 * shared) / (a.size + b.size);
};

const titleSimilarity = (query, title) => {
  const queryCanonical = canonicalTitle(query);
  const titleCanonical = canonicalTitle(title);
  if (!queryCanonical || !titleCanonical) return 0;
  if (queryCanonical === titleCanonical) return 1;
  const querySet = new Set(titleTokens(query));
  const titleSet = new Set(titleTokens(title));
  const shared = [...titleSet].filter((token) => querySet.has(token)).length;
  const coverage = titleSet.size ? shared / titleSet.size : 0;
  const precision = querySet.size ? shared / querySet.size : 0;
  const containment = queryCanonical.includes(titleCanonical) || titleCanonical.includes(queryCanonical) ? 1 : 0;
  return Math.max(
    diceCoefficient(query, title),
    coverage * 0.72 + precision * 0.18 + containment * 0.1
  );
};

const queryVariantsForSource = (sourcePath, item = {}) => {
  const filename = path.posix.basename(sourcePath);
  const withoutExtension = filename.replace(/\.[a-z0-9]{2,5}$/i, "");
  const parent = path.posix.basename(path.posix.dirname(sourcePath));
  const primary = normalizeMediaQuery(filename);
  const beforeSeparator = normalizeMediaQuery(withoutExtension.split(/\s+-\s+|\s+\|\s+/)[0] ?? "");
  const variants = [];
  const add = (value) => {
    const query = normalizeMediaQuery(value).query
      .replace(/^\s*(?:cd|disc|disk|part)?\s*\d{1,3}\s+/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    if (query.length >= 2 && !variants.some((entry) => canonicalTitle(entry) === canonicalTitle(query))) variants.push(query);
  };
  add(primary.query);
  add(beforeSeparator.query);
  const prefixTokens = beforeSeparator.query
    .replace(/^\s*(?:cd|disc|disk|part)?\s*\d{1,3}\s+/i, "")
    .match(/[A-Za-z0-9]+/g) ?? [];
  const separatorReducedNoise = canonicalTitle(beforeSeparator.query) !== canonicalTitle(primary.query);
  if (separatorReducedNoise && prefixTokens.length > 4) add(prefixTokens.slice(0, 4).join(" "));
  if (separatorReducedNoise && prefixTokens.length > 3) add(prefixTokens.slice(0, 3).join(" "));
  add(item.title);
  if (!/^(movies?|tv|shows?|series|media|video)$/i.test(parent)) add(parent);
  return {
    episodeNumber: primary.episodeNumber,
    queries: variants.slice(0, 5),
    seasonNumber: primary.seasonNumber,
    year: primary.year
  };
};

const rankCandidates = (candidateGroups, queries, year) => {
  const merged = new Map();
  candidateGroups.forEach((candidates, groupIndex) => {
    candidates.forEach((candidate, resultIndex) => {
      const key = `${candidate.mediaType}:${candidate.id}`;
      const similarities = queries.map((query) => ({ query, score: titleSimilarity(query, candidate.title) }));
      const best = similarities.sort((left, right) => right.score - left.score)[0] ?? { query: queries[0] ?? "", score: 0 };
      const yearExact = Boolean(year && candidate.year === year);
      const yearNear = Boolean(year && candidate.year && Math.abs(Number(candidate.year) - Number(year)) === 1);
      const yearMismatch = Boolean(year && candidate.year && !yearExact && !yearNear);
      const orderBonus = Math.max(0, 0.045 - groupIndex * 0.008 - resultIndex * 0.003);
      const confidence = Math.max(0, Math.min(1, best.score + (yearExact ? 0.08 : yearNear ? 0.025 : yearMismatch ? -0.16 : 0) + orderBonus));
      const reasons = [
        best.score === 1 ? "exact-title" : best.score >= 0.82 ? "strong-title" : "partial-title",
        yearExact ? "exact-year" : yearNear ? "near-year" : yearMismatch ? "year-mismatch" : null
      ].filter(Boolean);
      const ranked = { ...candidate, confidence, matchedQuery: best.query, reasons };
      const previous = merged.get(key);
      if (!previous || previous.confidence < confidence) merged.set(key, ranked);
    });
  });
  return [...merged.values()].sort((left, right) =>
    right.confidence - left.confidence || Number(right.rating || 0) - Number(left.rating || 0)
  );
};

const selectCandidate = (candidates, queryOrQueries, year) => {
  const queries = Array.isArray(queryOrQueries) ? queryOrQueries : [queryOrQueries];
  const ranked = candidates[0]?.confidence === undefined ? rankCandidates([candidates], queries, year) : candidates;
  const first = ranked[0];
  const second = ranked[1];
  if (!first || first.confidence < 0.86) return null;
  if (second && first.confidence - second.confidence < 0.075 && first.confidence < 0.97) return null;
  return first;
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
    const normalized = queryVariantsForSource(source.path, item);
    const category = item.itemType === "episode" ? "tv" : "movies";
    const candidateGroups = [];
    for (const query of normalized.queries) {
      candidateGroups.push(await tmdb.search({
        category,
        episodeNumber: normalized.episodeNumber,
        query,
        seasonNumber: normalized.seasonNumber,
        year: normalized.year
      }));
      const interim = rankCandidates(candidateGroups, normalized.queries.slice(0, candidateGroups.length), normalized.year);
      const interimMatch = selectCandidate(interim, normalized.queries.slice(0, candidateGroups.length), normalized.year);
      if (interimMatch?.confidence >= 0.93) break;
    }
    if (normalized.year && candidateGroups.every((group) => group.length === 0)) {
      for (const query of normalized.queries.slice(0, 2)) {
        candidateGroups.push(await tmdb.search({
          category,
          episodeNumber: normalized.episodeNumber,
          query,
          seasonNumber: normalized.seasonNumber,
          year: ""
        }));
      }
    }
    const ranked = rankCandidates(candidateGroups, normalized.queries, normalized.year);
    const storedCandidates = boundedCandidates(ranked);
    const match = selectCandidate(ranked, normalized.queries, normalized.year);
    const matchFields = {
      tmdbMatchCandidates: storedCandidates,
      tmdbMatchQueries: normalized.queries,
      tmdbMatchStatus: match ? "identified" : storedCandidates.length ? "needs-review" : "not-found",
      tmdbMatchUpdatedAt: new Date().toISOString()
    };
    if (!match) {
      repository.putExternalMetadata(item.id, { fields: matchFields, mode: "provider" });
      return {
        candidateCount: storedCandidates.length,
        matched: false,
        queries: normalized.queries,
        query: normalized.queries[0] ?? "",
        reason: "no_confident_match",
        sourceId
      };
    }

    context.reportProgress?.(0.55, "fetching-tmdb-details");
    const episode = category === "tv" && normalized.seasonNumber !== null && normalized.episodeNumber !== null;
    const fields = episode
      ? await tmdb.episodeDetails(match.id, normalized.seasonNumber, normalized.episodeNumber)
      : await tmdb.details(match.mediaType, match.id);
    repository.putExternalMetadata(item.id, {
      externalIds: [{ id: match.id, mediaType: match.mediaType, provider: "tmdb" }],
      fields: { ...fields, ...matchFields },
      mode: "provider"
    });

    if (readLegacyMetadata && writeLegacyMetadata) {
      const metadata = await readLegacyMetadata();
      metadata[source.path] = { ...(metadata[source.path] ?? {}), ...fields, episode: fields.episode ?? null };
      await writeLegacyMetadata(metadata);
    }
    context.reportProgress?.(0.95, "tmdb-metadata-ready");
    return {
      confidence: Number(match.confidence.toFixed(3)),
      itemId: item.id,
      matched: true,
      mediaType: match.mediaType,
      sourceId,
      tmdbId: match.id
    };
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

export { canonicalTitle, queryVariantsForSource, rankCandidates, selectCandidate, titleSimilarity };
