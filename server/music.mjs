import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { json, readBody } from "./http.mjs";
import { readMetadata, scanMediaLibrary } from "./mediaLibrary.mjs";
import { isAudioFile, mimeType } from "./storage.mjs";
import { parseByteRange } from "./ranges.mjs";
import { projectRepositoryItems, projectRepositoryItemsPage } from "./catalog/projections.mjs";
import { canBrowseFederatedLibrary, projectUnifiedLibrary } from "./cluster/index.mjs";
import { artworkJobDedupeKey } from "./artwork/index.mjs";

export const createMusicRoutes = (storage, accountStore, {
  catalog = null,
  federation = null,
  federationAuthorization = null,
  guestService = null,
  jobs = null,
  libraryPermissions = null,
  metadata = null
} = {}) => {
  const catalogEntries = () => catalog
    ? projectRepositoryItems(catalog.repository, { availability: "available", mediaKind: "audio" })
    : [];

  const listMusicLibrary = async (request, response) => {
    const metadata = await readMetadata(storage.cinemaMetadataPath);
    const url = new URL(request.url ?? "/", "http://nebula.local");
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 100));
    const query = url.searchParams.get("query") ?? "";
    const page = catalog?.repository?.listItemsPage ? projectRepositoryItemsPage(catalog.repository, {
      artworkJobForSource: (source) => jobs?.findByDedupe?.("artwork", artworkJobDedupeKey(source)) ?? null,
      availability: "available",
      limit,
      mediaKind: "audio",
      offset,
      query
    }) : null;
    const scanned = page?.entries ?? await scanMediaLibrary(storage, metadata, { mediaKind: "audio" });
    let catalogByPath = new Map((page ? scanned : catalogEntries()).map((entry) => [entry.path, entry]));
    if (!page && catalog?.scan && scanned.some((entry) => !catalogByPath.has(entry.path))) {
      await catalog.scan();
      catalogByPath = new Map(catalogEntries().map((entry) => [entry.path, entry]));
    }
    scanned.forEach((entry) => {
      const catalogEntry = catalogByPath.get(entry.path);
      if (catalogEntry) Object.assign(entry, {
        availability: catalogEntry.availability,
        id: catalogEntry.id,
        sourceId: catalogEntry.sourceId
      });
    });
    const context = request.nebulaAuth;
    let entries = libraryPermissions ? scanned.filter((entry) => libraryPermissions.canAccessPath(context, entry.path, "audio")) : scanned;
    if (context) {
      entries.forEach((entry) => {
        const ticket = context.kind === "guest" ? guestService.issueMediaTicket({ contentPath: entry.path, mediaKind: "audio", sessionId: context.sessionId }) : accountStore.issueMediaTicket({
          contentPath: entry.path,
          mediaKind: "audio",
          principalId: context.user?.id ?? context.principalId,
          principalType: context.user ? "user" : "service"
        });
        entry.streamUrl = `/api/music/media?path=${encodeURIComponent(entry.path)}&ticket=${encodeURIComponent(ticket)}`;
      });
    }
    const authorizeFederatedItem = federationAuthorization
      ? (itemId) => federationAuthorization.canAccessItem(context, itemId)
      : null;
    if (federation && canBrowseFederatedLibrary(context, authorizeFederatedItem)) {
      entries = projectUnifiedLibrary({ authorizeItem: authorizeFederatedItem, entries, federation, mediaKind: "audio" });
    }
    entries.sort((a, b) => (a.sortTitle || a.title).localeCompare(b.sortTitle || b.title));
    json(response, 200, { entries, page: page ? { hasMore: page.offset + page.items.length < page.total, limit: page.limit, nextOffset: page.offset + page.items.length, offset: page.offset, total: page.total } : { hasMore: false, limit: entries.length, nextOffset: entries.length, offset: 0, total: entries.length } });
  };

  const streamMusicMedia = async (request, response, url) => {
    const requestedPath = url.searchParams.get("path") ?? "";
    const contentPath = storage.relativePath(requestedPath);
    const absolutePath = storage.resolveContentPath(requestedPath);
    const stats = await stat(absolutePath).catch(() => null);

    if (!stats || !stats.isFile() || !isAudioFile(absolutePath)
      || (libraryPermissions && !libraryPermissions.canAccessPath(request.nebulaAuth, contentPath, "audio"))) {
      json(response, 404, { error: "Audio file not found." });
      return;
    }

    const range = request.headers.range;
    const headers = {
      "accept-ranges": "bytes",
      "content-type": mimeType(absolutePath)
    };

    if (!range) {
      response.writeHead(200, {
        ...headers,
        "content-length": stats.size
      });

      if (request.method !== "HEAD") {
        createReadStream(absolutePath).pipe(response);
      } else {
        response.end();
      }
      return;
    }

    const parsedRange = parseByteRange(range, stats.size);

    if (!parsedRange.ok) {
      response.writeHead(416, {
        ...headers,
        "content-range": parsedRange.contentRange
      });
      response.end();
      return;
    }
    const { start, end } = parsedRange;

    response.writeHead(206, {
      ...headers,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${stats.size}`
    });

    if (request.method !== "HEAD") {
      createReadStream(absolutePath, { start, end }).pipe(response);
    } else {
      response.end();
    }
  };

  const requireAudioSource = async (requestedPath) => {
    const contentPath = storage.relativePath(requestedPath ?? "");
    const absolutePath = storage.resolveContentPath(contentPath);
    const stats = await stat(absolutePath).catch(() => null);
    const resolved = catalog?.repository?.resolveContentPath?.(contentPath) ?? null;
    return stats?.isFile() && isAudioFile(absolutePath) && resolved?.source?.mediaKind === "audio"
      ? { contentPath, ...resolved }
      : null;
  };

  const metadataContext = () => ({
    enqueue: (job) => jobs?.enqueue?.(job),
    reportProgress: () => undefined
  });

  const metadataCandidates = async (request, response, url) => {
    const resolved = await requireAudioSource(url.searchParams.get("path"));
    if (!resolved) return json(response, 404, { error: "Audio file not found." });
    const candidates = resolved.item?.metadata?.musicbrainzMatchCandidates;
    json(response, 200, {
      candidates: Array.isArray(candidates) ? candidates.slice(0, 8) : [],
      provider: "MusicBrainz"
    });
  };

  const searchMetadata = async (request, response) => {
    const body = await readBody(request);
    const resolved = await requireAudioSource(body.path);
    if (!resolved) return json(response, 404, { error: "Audio file not found." });
    const result = await metadata.searchSource({
      album: body.album,
      artist: body.artist,
      query: body.query,
      sourceId: resolved.source.id
    });
    json(response, 200, result);
  };

  const applyMetadata = async (request, response) => {
    const body = await readBody(request);
    const resolved = await requireAudioSource(body.path);
    if (!resolved) return json(response, 404, { error: "Audio file not found." });
    const result = await metadata.applySource({
      recordingId: body.recordingId,
      releaseId: body.releaseId,
      sourceId: resolved.source.id
    }, metadataContext());
    json(response, 200, result);
  };

  const refreshMetadata = async (request, response) => {
    const body = await readBody(request);
    const resolved = await requireAudioSource(body.path);
    if (!resolved) return json(response, 404, { error: "Audio file not found." });
    const job = jobs.enqueue({
      availableAt: Date.now(),
      dedupeKey: `manual-music:${resolved.source.id}:${resolved.source.contentRevision}:${Date.now()}`,
      maxAttempts: 1,
      payload: { sourceId: resolved.source.id },
      type: "metadata"
    });
    json(response, 202, { job, ok: true });
  };

  return async (request, response, url) => {
    if (request.method === "GET" && url.pathname === "/api/music/library") {
      await listMusicLibrary(request, response);
      return true;
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/music/media") {
      await streamMusicMedia(request, response, url);
      return true;
    }

    if (metadata && request.method === "GET" && url.pathname === "/api/music/metadata/status") {
      json(response, 200, {
        attribution: "Music metadata from MusicBrainz; cover art from the Cover Art Archive.",
        configured: true,
        provider: "MusicBrainz"
      });
      return true;
    }

    if (metadata && request.method === "GET" && url.pathname === "/api/music/metadata/candidates") {
      await metadataCandidates(request, response, url);
      return true;
    }

    if (metadata && request.method === "POST" && url.pathname === "/api/music/metadata/search") {
      await searchMetadata(request, response);
      return true;
    }

    if (metadata && request.method === "POST" && url.pathname === "/api/music/metadata/apply") {
      await applyMetadata(request, response);
      return true;
    }

    if (metadata && jobs && request.method === "POST" && url.pathname === "/api/music/metadata/refresh") {
      await refreshMetadata(request, response);
      return true;
    }

    return false;
  };
};
