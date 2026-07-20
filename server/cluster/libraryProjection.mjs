const remoteEntry = (item) => {
  const video = item.mediaKind === "video";
  const title = item.title || "Untitled";
  return {
    album: "", artist: "", availability: item.availability,
    backdropUrl: "", cast: "", category: item.itemKind === "episode" ? "tv" : video ? "movies" : "music",
    collection: "", episode: null, folder: "Remote shard", genres: [],
    id: item.id, mediaKind: item.mediaKind, modifiedAt: "", name: title,
    path: `federated:${item.id}`, playable: false, posterUrl: "", rating: "",
    releaseYear: item.year ? String(item.year) : "", size: 0, sortTitle: title,
    sourceId: undefined, streamUrl: "", studio: "", summary: "",
    tagline: "", title, tmdbId: null, tmdbImportedAt: "", tmdbMediaType: "",
    watchlisted: false
  };
};

export const projectUnifiedLibrary = ({ entries, federation, mediaKind }) => {
  if (!federation) return entries;
  const localBySource = new Map(entries.filter((entry) => entry.sourceId).map((entry) => [entry.sourceId, entry]));
  const localByItem = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
  const consumed = new Set();
  const projected = federation.listItems({ mediaKind }).map((item) => {
    const localSource = item.sources.find((source) => source.local && source.availability === "available");
    const local = localSource ? localBySource.get(localSource.localSourceId) ?? localByItem.get(localSource.localItemId) : null;
    if (local) consumed.add(local.path);
    return { ...(local ?? remoteEntry(item)), federation: item, playable: Boolean(local) };
  });
  for (const entry of entries) if (!consumed.has(entry.path)) projected.push({ ...entry, playable: true });
  return projected;
};

export const canBrowseFederatedLibrary = (context) => context?.kind === "service" || context?.user?.role === "owner";
