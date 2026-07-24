import path from "node:path";
import { stat } from "node:fs/promises";
import { json, readBody } from "./http.mjs";
import { defaultTitle, metadataForEntry, readMetadata, writeMetadata } from "./mediaLibrary.mjs";
import { isVideoFile } from "./storage.mjs";
import { createTmdbClient, normalizeMediaQuery } from "./tmdb.mjs";
import { rankCandidates } from "./metadata/tmdbService.mjs";

export const createCinemaTmdbRoutes = (storage, accountStore, options = {}) => {
  const repository = options.catalog?.repository ?? null;
  const tmdb = options.tmdbClient ?? createTmdbClient({
    ...options.tmdb,
    tokenProvider: options.tmdb?.tokenProvider ?? (() => accountStore?.getServerSetting?.("tmdb_api_token") || process.env.TMDB_API_TOKEN || "")
  });
  const requireVideo = async (requestedPath) => {
    const contentPath = storage.relativePath(requestedPath ?? "");
    const absolutePath = storage.resolveContentPath(contentPath);
    const stats = await stat(absolutePath).catch(() => null);
    return stats?.isFile() && isVideoFile(absolutePath) ? { contentPath } : null;
  };
  const catalogItemForPath = (contentPath) => repository?.resolveContentPath?.(contentPath) ?? null;
  const storedCandidates = (contentPath) => {
    const source = catalogItemForPath(contentPath);
    const candidates = source?.item?.metadata?.tmdbMatchCandidates;
    return Array.isArray(candidates) ? candidates.slice(0, 8) : [];
  };

  const search = async (request, response) => {
    const body = await readBody(request);
    const file = await requireVideo(body.path);
    if (!file) return json(response, 404, { error: "Media file not found." });
    const metadata = await readMetadata(storage.cinemaMetadataPath);
    const fallbackTitle = defaultTitle(path.basename(file.contentPath));
    const current = metadataForEntry(metadata, file.contentPath, fallbackTitle);
    const normalized = normalizeMediaQuery(String(body.query ?? current.episode?.seriesTitle ?? current.title ?? fallbackTitle));
    const filename = normalizeMediaQuery(path.basename(file.contentPath));
    const query = normalized.query.slice(0, 160);
    if (!query) return json(response, 400, { error: "Enter a title to search TMDB." });
    const candidates = await tmdb.search({
      category: body.category === "movies" || body.category === "tv" ? body.category : undefined,
      episodeNumber: current.episode?.episodeNumber ?? normalized.episodeNumber ?? filename.episodeNumber,
      query,
      seasonNumber: current.episode?.seasonNumber ?? normalized.seasonNumber ?? filename.seasonNumber,
      year: /^\d{4}$/.test(String(body.year ?? "")) ? String(body.year) : normalized.year
    });
    const year = /^\d{4}$/.test(String(body.year ?? "")) ? String(body.year) : normalized.year;
    const ranked = rankCandidates([candidates], [query], year).slice(0, 8).map((candidate) => ({
      ...candidate,
      confidence: Number(candidate.confidence.toFixed(3))
    }));
    const catalogSource = catalogItemForPath(file.contentPath);
    if (catalogSource?.item?.id) {
      repository.putExternalMetadata(catalogSource.item.id, {
        fields: {
          tmdbMatchCandidates: ranked,
          tmdbMatchQueries: [query],
          tmdbMatchStatus: ranked.length ? "needs-review" : "not-found",
          tmdbMatchUpdatedAt: new Date().toISOString()
        },
        mode: "provider"
      });
    }
    json(response, 200, { candidates: ranked, normalizedQuery: query, provider: "TMDB", stored: Boolean(catalogSource?.item?.id) });
  };

  const persist = async (body, response, { refresh = false } = {}) => {
    const file = await requireVideo(body.path);
    if (!file) return json(response, 404, { error: "Media file not found." });
    const metadata = await readMetadata(storage.cinemaMetadataPath);
    const fallbackTitle = defaultTitle(path.basename(file.contentPath));
    const current = metadataForEntry(metadata, file.contentPath, fallbackTitle);
    const mediaType = refresh ? current.tmdbMediaType : body.mediaType;
    const tmdbId = refresh ? current.tmdbId : body.tmdbId;
    const seasonNumber = refresh ? current.episode?.seasonNumber : body.seasonNumber;
    const episodeNumber = refresh ? current.episode?.episodeNumber : body.episodeNumber;
    if (refresh && (!mediaType || !tmdbId)) return json(response, 409, { error: "This title has not been matched with TMDB yet." });
    const isEpisode = mediaType === "tv" && seasonNumber !== null && seasonNumber !== undefined && episodeNumber !== null && episodeNumber !== undefined
      && Number.isInteger(Number(seasonNumber)) && Number(seasonNumber) >= 0 && Number.isInteger(Number(episodeNumber)) && Number(episodeNumber) >= 1;
    const imported = isEpisode
      ? await tmdb.episodeDetails(tmdbId, Number(seasonNumber), Number(episodeNumber))
      : await tmdb.details(mediaType, tmdbId);
    const updatedAt = new Date().toISOString();
    metadata[file.contentPath] = {
      ...current,
      ...imported,
      episode: imported.episode ?? null,
      tmdbMatchSelectedId: Number(tmdbId),
      tmdbMatchStatus: "identified",
      tmdbMatchUpdatedAt: updatedAt,
      updatedAt
    };
    await writeMetadata(storage.cinemaMetadataPath, metadata);
    const catalogSource = catalogItemForPath(file.contentPath);
    if (catalogSource?.item?.id) {
      repository.putExternalMetadata(catalogSource.item.id, {
        externalIds: [{ id: tmdbId, mediaType, provider: "tmdb" }],
        fields: {
          ...imported,
          tmdbMatchSelectedId: Number(tmdbId),
          tmdbMatchStatus: "identified",
          tmdbMatchUpdatedAt: updatedAt
        },
        mode: "provider"
      });
    }
    json(response, 200, { metadata: metadata[file.contentPath], ok: true, path: file.contentPath });
  };

  return async (request, response, url) => {
    if (request.method === "GET" && url.pathname === "/api/cinema/tmdb/status") {
      json(response, 200, { attribution: "This product uses the TMDB API but is not endorsed or certified by TMDB.", configured: tmdb.configured, provider: "TMDB" });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/cinema/tmdb/candidates") {
      const file = await requireVideo(url.searchParams.get("path"));
      if (!file) return json(response, 404, { error: "Media file not found." }), true;
      json(response, 200, { candidates: storedCandidates(file.contentPath), provider: "TMDB" });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/cinema/tmdb/search") {
      await search(request, response); return true;
    }
    if (request.method === "POST" && url.pathname === "/api/cinema/tmdb/apply") {
      await persist(await readBody(request), response); return true;
    }
    if (request.method === "POST" && url.pathname === "/api/cinema/tmdb/refresh") {
      await persist(await readBody(request), response, { refresh: true }); return true;
    }
    return false;
  };
};
