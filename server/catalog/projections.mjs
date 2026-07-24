import { currentLocalArtwork, generatedArtworkUrl } from "../artwork/paths.mjs";

const remoteArtworkUrl = (artwork, type) => artwork.find((entry) => entry.type === type && entry.remoteUrl)?.remoteUrl ?? "";

const artworkProjection = ({ artwork, job = null, item, source }) => {
  const local = currentLocalArtwork(artwork, source);
  if (local) return { artworkState: job?.state === "running" ? "processing" : "ready", posterUrl: generatedArtworkUrl(source) };
  if (job?.state === "running") return { artworkState: "processing", posterUrl: "" };
  if (job?.state === "queued") return { artworkState: "queued", posterUrl: "" };
  if (job?.state === "failed" || job?.state === "cancelled") return { artworkState: "failed", posterUrl: "" };
  return { artworkState: "missing", posterUrl: "" };
};

export const projectCompatibilityEntry = ({ artwork = [], artworkJob = null, externalIds = [], item, source, watchlisted = false }) => {
  const metadata = item.metadata ?? {};
  const tmdb = externalIds.find((entry) => entry.provider === "tmdb");
  const folder = source.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : "";
  const name = source.path.slice(source.path.lastIndexOf("/") + 1);
  const poster = artworkProjection({ artwork, item, job: artworkJob, source });
  return {
    album: metadata.album || metadata.collection || "",
    artist: metadata.artist || metadata.studio || "",
    artworkState: poster.artworkState,
    availability: source.availability,
    backdropUrl: metadata.backdropUrl || remoteArtworkUrl(artwork, "backdrop"),
    category: item.mediaKind === "audio" ? "music" : item.itemType === "episode" ? "tv" : "movies",
    cast: metadata.cast || "",
    collection: metadata.collection || "",
    episode: metadata.episode && typeof metadata.episode === "object" ? metadata.episode : null,
    folder,
    genres: Array.isArray(metadata.genres) ? metadata.genres : [],
    id: item.id,
    mediaKind: item.mediaKind,
    modifiedAt: new Date(source.modifiedMs).toISOString(),
    name,
    path: source.path,
    posterUrl: poster.posterUrl,
    rating: metadata.rating || "",
    releaseYear: metadata.releaseYear || "",
    size: source.size,
    sortTitle: item.sortTitle,
    sourceId: source.id,
    streamUrl: item.mediaKind === "audio" ? `/api/music/media?path=${encodeURIComponent(source.path)}` : `/api/cinema/media?path=${encodeURIComponent(source.path)}`,
    studio: metadata.studio || "",
    summary: metadata.summary || "",
    tagline: metadata.tagline || "",
    title: item.title,
    tmdbId: tmdb?.id ?? null,
    tmdbImportedAt: metadata.tmdbImportedAt || "",
    tmdbMatchCandidateCount: Array.isArray(metadata.tmdbMatchCandidates) ? metadata.tmdbMatchCandidates.length : 0,
    tmdbMatchStatus: metadata.tmdbMatchStatus || "",
    tmdbMediaType: tmdb?.mediaType ?? "",
    watchlisted: Boolean(watchlisted)
  };
};

export const projectRepositoryItems = (repository, query = {}) => repository.listItems(query).map((item) => projectCompatibilityEntry({
  artwork: repository.listArtwork(item.id),
  externalIds: repository.listExternalIds(item.id),
  item,
  source: item.source
}));

export const projectRepositoryItemsPage = (repository, query = {}) => {
  const page = repository.listItemsPage(query);
  return {
    ...page,
    entries: page.items.map((item) => projectCompatibilityEntry({
      artwork: repository.listArtwork(item.id),
      artworkJob: query.artworkJobForSource?.(item.source) ?? null,
      externalIds: repository.listExternalIds(item.id),
      item,
      source: item.source
    }))
  };
};
