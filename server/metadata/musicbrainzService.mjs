import path from "node:path";
import { artworkJobDedupeKey } from "../artwork/paths.mjs";

const canonical = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const cleanTitle = (value) => String(value ?? "")
  .replace(/\.[a-z0-9]{2,5}$/i, "")
  .replace(/^\s*(?:cd|disc|disk)?\s*\d{1,3}[\s._-]+/i, "")
  .replace(/^\s*\d{1,3}[\s._-]+/, "")
  .replace(/[\s._]+/g, " ")
  .trim()
  .slice(0, 180);

const similarity = (left, right) => {
  const a = canonical(left);
  const b = canonical(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const pairs = (value) => new Set(Array.from({ length: Math.max(0, value.length - 1) }, (_, index) => value.slice(index, index + 2)));
  const leftPairs = pairs(a);
  const rightPairs = pairs(b);
  if (!leftPairs.size || !rightPairs.size) return 0;
  let shared = 0;
  leftPairs.forEach((pair) => { if (rightPairs.has(pair)) shared += 1; });
  return (2 * shared) / (leftPairs.size + rightPairs.size);
};

const sourceHints = (source, item) => {
  const parts = source.path.split("/").filter(Boolean);
  const filename = parts.at(-1) ?? source.path;
  const metadata = item.metadata ?? {};
  const title = cleanTitle(metadata.embeddedTitle || metadata.title || item.title || filename);
  const album = cleanTitle(metadata.embeddedAlbum || metadata.album || parts.at(-2) || "");
  const artist = cleanTitle(metadata.embeddedArtist || metadata.albumArtist || metadata.artist || parts.at(-3) || "");
  return {
    album,
    artist,
    durationMs: Number.isFinite(Number(source.durationSeconds)) && Number(source.durationSeconds) > 0
      ? Number(source.durationSeconds) * 1_000
      : null,
    title: title || cleanTitle(filename)
  };
};

const rankCandidates = (candidates, hints) => candidates.map((candidate, index) => {
  const titleScore = similarity(hints.title, candidate.title);
  const artistScore = hints.artist ? similarity(hints.artist, candidate.artist) : 0.5;
  const albumScore = hints.album ? similarity(hints.album, candidate.album) : 0.5;
  const providerScore = Number(candidate.score ?? 0) / 100;
  const durationDifference = hints.durationMs && candidate.durationMs
    ? Math.abs(Number(hints.durationMs) - Number(candidate.durationMs))
    : null;
  const durationAdjustment = durationDifference === null ? 0
    : durationDifference <= 3_000 ? 0.12
      : durationDifference <= 10_000 ? 0.08
        : durationDifference <= 30_000 ? 0
          : durationDifference <= 60_000 ? -0.08 : -0.18;
  const confidence = Math.max(0, Math.min(1,
    titleScore * 0.58 + artistScore * 0.2 + albumScore * 0.1 + providerScore * 0.12
      + durationAdjustment - index * 0.003
  ));
  return { ...candidate, confidence: Number(confidence.toFixed(3)) };
}).sort((left, right) => right.confidence - left.confidence || right.score - left.score);

const selectCandidate = (candidates) => {
  const [first, second] = candidates;
  if (!first || first.confidence < 0.84) return null;
  if (second && first.confidence - second.confidence < 0.07 && first.confidence < 0.96) return null;
  return first;
};

const storedCandidates = (candidates) => candidates.slice(0, 8).map((candidate) => ({
  album: candidate.album,
  artist: candidate.artist,
  confidence: candidate.confidence,
  durationMs: candidate.durationMs,
  recordingId: candidate.recordingId,
  releaseGroupId: candidate.releaseGroupId,
  releaseId: candidate.releaseId,
  releaseYear: candidate.releaseYear,
  title: candidate.title
}));

export const createMusicBrainzMetadataService = ({ client, repository } = {}) => {
  if (!client?.search || !client?.details) throw new TypeError("A MusicBrainz client is required.");
  if (!repository?.getSource || !repository?.getItem || !repository?.putExternalMetadata) {
    throw new TypeError("A catalog repository is required.");
  }

  const sourceContext = (sourceId) => {
    const source = repository.getSource(sourceId);
    if (!source || source.availability !== "available" || source.mediaKind !== "audio") return null;
    const item = repository.getItem(source.itemId);
    return item ? { hints: sourceHints(source, item), item, source } : null;
  };

  const persistMatch = async ({ candidate, context = {}, item, source }) => {
    context.reportProgress?.(0.55, "fetching-musicbrainz-details");
    const fields = await client.details(candidate.recordingId, candidate.releaseId);
    const updatedAt = new Date().toISOString();
    repository.putExternalMetadata(item.id, {
      expectedContentRevision: source.contentRevision,
      expectedSourceId: source.id,
      externalIds: [{ id: fields.recordingId, mediaType: "recording", provider: "musicbrainz" }],
      fields: {
        album: fields.album,
        artist: fields.artist,
        genres: fields.genres,
        musicbrainzArtistId: fields.artistId,
        musicbrainzImportedAt: updatedAt,
        musicbrainzMatchSelectedId: fields.recordingId,
        musicbrainzMatchStatus: "identified",
        musicbrainzMatchUpdatedAt: updatedAt,
        musicbrainzReleaseGroupId: fields.releaseGroupId,
        musicbrainzReleaseId: fields.releaseId,
        musicbrainzSourceRevision: source.contentRevision,
        posterUrl: fields.posterUrl,
        releaseYear: fields.releaseYear,
        runtimeMinutes: fields.durationMs ? fields.durationMs / 60_000 : null,
        sortTitle: fields.title,
        title: fields.title
      },
      mode: "provider"
    });
    if (fields.posterUrl) context.enqueue?.({
      availableAt: 0,
      dedupeKey: artworkJobDedupeKey(source),
      maxAttempts: 2,
      payload: { contentRevision: source.contentRevision, sourceId: source.id },
      type: "artwork"
    });
    context.reportProgress?.(0.95, fields.posterUrl ? "cover-art-queued" : "music-metadata-ready");
    return {
      artworkQueued: Boolean(fields.posterUrl),
      itemId: item.id,
      matched: true,
      musicbrainzRecordingId: fields.recordingId,
      sourceId: source.id
    };
  };

  const searchSource = async ({ album = "", artist = "", query = "", sourceId }) => {
    const current = sourceContext(sourceId);
    if (!current) return { candidates: [], reason: "source_unavailable", sourceId };
    const hints = {
      album: cleanTitle(album),
      artist: cleanTitle(artist),
      title: cleanTitle(query) || current.hints.title
    };
    const ranked = rankCandidates(await client.search(hints), {
      ...hints,
      durationMs: current.hints.durationMs
    });
    const candidates = storedCandidates(ranked);
    repository.putExternalMetadata(current.item.id, {
      expectedContentRevision: current.source.contentRevision,
      expectedSourceId: current.source.id,
      fields: {
        musicbrainzMatchCandidates: candidates,
        musicbrainzMatchQueries: hints,
        musicbrainzMatchStatus: candidates.length ? "needs-review" : "not-found",
        musicbrainzMatchUpdatedAt: new Date().toISOString(),
        musicbrainzSourceRevision: current.source.contentRevision
      },
      mode: "provider"
    });
    return { candidates, hints, provider: "MusicBrainz", sourceId };
  };

  const refreshSource = async ({ sourceId }, context = {}) => {
    const current = sourceContext(sourceId);
    if (!current) return { matched: false, reason: "source_unavailable", sourceId };
    const embeddedRecordingId = String(current.item.metadata?.musicbrainzEmbeddedRecordingId ?? "");
    if (/^[0-9a-f-]{36}$/i.test(embeddedRecordingId)) {
      context.reportProgress?.(0.2, "using-embedded-musicbrainz-id");
      return persistMatch({
        candidate: {
          recordingId: embeddedRecordingId,
          releaseId: String(current.item.metadata?.musicbrainzReleaseId ?? "")
        },
        context,
        ...current
      });
    }
    context.reportProgress?.(0.1, "searching-musicbrainz");
    const ranked = rankCandidates(await client.search(current.hints), current.hints);
    const candidates = storedCandidates(ranked);
    const match = selectCandidate(ranked);
    const updatedAt = new Date().toISOString();
    repository.putExternalMetadata(current.item.id, {
      expectedContentRevision: current.source.contentRevision,
      expectedSourceId: current.source.id,
      fields: {
        musicbrainzMatchCandidates: candidates,
        musicbrainzMatchQueries: current.hints,
        musicbrainzMatchStatus: match ? "identified" : candidates.length ? "needs-review" : "not-found",
        musicbrainzMatchUpdatedAt: updatedAt,
        musicbrainzSourceRevision: current.source.contentRevision
      },
      mode: "provider"
    });
    if (!match) return { candidateCount: candidates.length, matched: false, reason: "no_confident_match", sourceId };
    return persistMatch({ candidate: match, context, ...current });
  };

  const applySource = async ({ recordingId, releaseId = "", sourceId }, context = {}) => {
    const current = sourceContext(sourceId);
    if (!current) return { matched: false, reason: "source_unavailable", sourceId };
    if (!/^[0-9a-f-]{36}$/i.test(String(recordingId))) {
      throw Object.assign(new Error("Choose a valid MusicBrainz recording."), { status: 400 });
    }
    return persistMatch({
      candidate: { recordingId: String(recordingId), releaseId: String(releaseId) },
      context,
      ...current
    });
  };

  const enqueueMissing = (enqueue, {
    availableAt = Date.now(),
    batchId = "music",
    intervalMs = 1_250,
    sourceFilter = () => true
  } = {}) => {
    let queued = 0;
    for (const item of repository.listItems({ availability: "available", mediaKind: "audio" })) {
      if (!sourceFilter(item.source)) continue;
      if (Number(item.metadata?.musicbrainzSourceRevision) === Number(item.source.contentRevision)) continue;
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

  return { applySource, enqueueMissing, refreshSource, searchSource };
};

export { cleanTitle, rankCandidates, selectCandidate, similarity, sourceHints };
