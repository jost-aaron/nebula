import path from "node:path";

export const GENERATED_ARTWORK_PROVIDER = "nebula-frame";
export const CACHED_ARTWORK_PROVIDER = "tmdb-cache";

const safeSegment = (value, label) => {
  const normalized = String(value ?? "");
  if (!/^[A-Za-z0-9-]{1,128}$/.test(normalized)) throw new TypeError(`${label} is invalid.`);
  return normalized;
};

export const generatedArtworkRelativePath = (sourceId, contentRevision) => {
  const source = safeSegment(sourceId, "sourceId");
  const revision = Number(contentRevision);
  if (!Number.isInteger(revision) || revision < 1) throw new TypeError("contentRevision is invalid.");
  return path.posix.join("artwork", source, `${revision}.jpg`);
};

export const cachedArtworkRelativePath = (sourceId, contentRevision) => {
  const source = safeSegment(sourceId, "sourceId");
  const revision = Number(contentRevision);
  if (!Number.isInteger(revision) || revision < 1) throw new TypeError("contentRevision is invalid.");
  return path.posix.join("artwork", source, `${revision}.tmdb.jpg`);
};

export const currentGeneratedArtwork = (artwork, source) => {
  const generated = artwork.find((entry) =>
    entry.type === "poster" && entry.provider === GENERATED_ARTWORK_PROVIDER
  );
  if (!generated || !Number.isInteger(source?.contentRevision) || source.contentRevision < 1) return null;
  const expected = generatedArtworkRelativePath(source.id, source.contentRevision);
  return generated.localPath === expected ? generated : null;
};

export const currentCachedArtwork = (artwork, source) => {
  const cached = artwork.find((entry) =>
    entry.type === "poster" && entry.provider === CACHED_ARTWORK_PROVIDER
  );
  if (!cached || !Number.isInteger(source?.contentRevision) || source.contentRevision < 1) return null;
  return cached.localPath === cachedArtworkRelativePath(source.id, source.contentRevision) ? cached : null;
};

export const currentLocalArtwork = (artwork, source) =>
  currentCachedArtwork(artwork, source) ?? currentGeneratedArtwork(artwork, source);

export const generatedArtworkUrl = (source) =>
  `/api/cinema/artwork?sourceId=${encodeURIComponent(source.id)}&revision=${source.contentRevision}`;

export const artworkJobDedupeKey = (source) => `${safeSegment(source.id, "sourceId")}:${Number(source.contentRevision)}`;
