const artworkUrl = (artwork, type) => artwork.find((entry) => entry.type === type)?.remoteUrl ?? "";

export const projectCompatibilityEntry = ({ artwork = [], externalIds = [], item, source, watchlisted = false }) => {
  const metadata = item.metadata ?? {};
  const tmdb = externalIds.find((entry) => entry.provider === "tmdb");
  const folder = source.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : "";
  const name = source.path.slice(source.path.lastIndexOf("/") + 1);
  return {
    album: metadata.album || metadata.collection || "",
    artist: metadata.artist || metadata.studio || "",
    availability: source.availability,
    backdropUrl: metadata.backdropUrl || artworkUrl(artwork, "backdrop"),
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
    posterUrl: metadata.posterUrl || artworkUrl(artwork, "poster"),
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
      externalIds: repository.listExternalIds(item.id),
      item,
      source: item.source
    }))
  };
};
