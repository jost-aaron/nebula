import { artworkJobDedupeKey, currentCachedArtwork, currentLocalArtwork } from "./paths.mjs";

export const createArtworkScheduler = ({ repository }) => {
  if (typeof repository?.listItems !== "function" || typeof repository?.listArtwork !== "function") {
    throw new TypeError("A catalog repository is required.");
  }

  const enqueueMissing = (enqueue, { availableAt = Date.now(), intervalMs = 4_000 } = {}) => {
    if (typeof enqueue !== "function") throw new TypeError("An enqueue function is required.");
    let queued = 0;
    for (const item of repository.listItems({ availability: "available", mediaKind: "video" })) {
      const artwork = repository.listArtwork(item.id);
      const hasRemotePoster = Boolean(item.metadata?.posterUrl)
        || artwork.some((entry) => entry.type === "poster" && entry.remoteUrl);
      const hasPoster = hasRemotePoster
        ? Boolean(currentCachedArtwork(artwork, item.source))
        : Boolean(currentLocalArtwork(artwork, item.source));
      if (hasPoster) continue;
      enqueue({
        availableAt: availableAt + queued * intervalMs,
        dedupeKey: artworkJobDedupeKey(item.source),
        maxAttempts: 2,
        payload: { contentRevision: item.source.contentRevision, sourceId: item.source.id },
        reuseTerminal: true,
        type: "artwork"
      });
      queued += 1;
    }
    return { queued };
  };

  return { enqueueMissing };
};
