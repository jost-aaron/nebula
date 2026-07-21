import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { json } from "./http.mjs";
import { readMetadata, scanMediaLibrary } from "./mediaLibrary.mjs";
import { isAudioFile, mimeType } from "./storage.mjs";
import { parseByteRange } from "./ranges.mjs";
import { projectRepositoryItems, projectRepositoryItemsPage } from "./catalog/projections.mjs";
import { canBrowseFederatedLibrary, projectUnifiedLibrary } from "./cluster/index.mjs";

export const createMusicRoutes = (storage, accountStore, { catalog = null, federation = null, federationAuthorization = null, guestService = null, libraryPermissions = null } = {}) => {
  const catalogEntries = () => catalog
    ? projectRepositoryItems(catalog.repository, { availability: "available", mediaKind: "audio" })
    : [];

  const listMusicLibrary = async (request, response) => {
    const metadata = await readMetadata(storage.cinemaMetadataPath);
    const url = new URL(request.url ?? "/", "http://nebula.local");
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 100));
    const query = url.searchParams.get("query") ?? "";
    const page = catalog?.repository?.listItemsPage ? projectRepositoryItemsPage(catalog.repository, { availability: "available", limit, mediaKind: "audio", offset, query }) : null;
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

  return async (request, response, url) => {
    if (request.method === "GET" && url.pathname === "/api/music/library") {
      await listMusicLibrary(request, response);
      return true;
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/music/media") {
      await streamMusicMedia(request, response, url);
      return true;
    }

    return false;
  };
};
