import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { json } from "./http.mjs";
import { readMetadata, scanMediaLibrary } from "./mediaLibrary.mjs";
import { isAudioFile, mimeType } from "./storage.mjs";
import { parseByteRange } from "./ranges.mjs";

export const createMusicRoutes = (storage, accountStore, { libraryPermissions = null } = {}) => {
  const listMusicLibrary = async (request, response) => {
    const metadata = await readMetadata(storage.cinemaMetadataPath);
    const scanned = await scanMediaLibrary(storage, metadata, { mediaKind: "audio" });
    const context = request.nebulaAuth;
    const entries = libraryPermissions ? scanned.filter((entry) => libraryPermissions.canAccessPath(context, entry.path, "audio")) : scanned;
    if (context) {
      entries.forEach((entry) => {
        const ticket = accountStore.issueMediaTicket({
          contentPath: entry.path,
          mediaKind: "audio",
          principalId: context.user?.id ?? context.principalId,
          principalType: context.user ? "user" : "service"
        });
        entry.streamUrl = `/api/music/media?path=${encodeURIComponent(entry.path)}&ticket=${encodeURIComponent(ticket)}`;
      });
    }
    entries.sort((a, b) => (a.sortTitle || a.title).localeCompare(b.sortTitle || b.title));
    json(response, 200, { entries });
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
