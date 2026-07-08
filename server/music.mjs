import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { json } from "./http.mjs";
import { readMetadata, scanMediaLibrary } from "./mediaLibrary.mjs";
import { isAudioFile, mimeType } from "./storage.mjs";

export const createMusicRoutes = (storage) => {
  const listMusicLibrary = async (request, response) => {
    const metadata = await readMetadata(storage.cinemaMetadataPath);
    const entries = await scanMediaLibrary(storage, metadata, { mediaKind: "audio" });
    entries.sort((a, b) => (a.sortTitle || a.title).localeCompare(b.sortTitle || b.title));
    json(response, 200, { entries });
  };

  const streamMusicMedia = async (request, response, url) => {
    const requestedPath = url.searchParams.get("path") ?? "";
    const absolutePath = storage.resolveContentPath(requestedPath);
    const stats = await stat(absolutePath).catch(() => null);

    if (!stats || !stats.isFile() || !isAudioFile(absolutePath)) {
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

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);

    if (!match) {
      response.writeHead(416, {
        "content-range": `bytes */${stats.size}`
      });
      response.end();
      return;
    }

    const suffixLength = !match[1] && match[2] ? Number(match[2]) : null;
    const requestedStart = suffixLength === null ? Number(match[1]) : Math.max(stats.size - suffixLength, 0);
    const requestedEnd = suffixLength === null && match[2] ? Number(match[2]) : stats.size - 1;
    const start = Math.min(requestedStart, stats.size - 1);
    const end = Math.min(requestedEnd, stats.size - 1);

    if (start > end) {
      response.writeHead(416, {
        "content-range": `bytes */${stats.size}`
      });
      response.end();
      return;
    }

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
