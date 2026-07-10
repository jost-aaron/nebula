import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { json, readBody } from "./http.mjs";
import { defaultTitle, metadataForEntry, readMetadata, scanMediaLibrary, writeMetadata } from "./mediaLibrary.mjs";
import { isVideoFile, mimeType } from "./storage.mjs";
import { parseByteRange } from "./ranges.mjs";

const candidateWords = (value = "") =>
  value
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[\W_]+/g, " ")
    .split(" ")
    .map((word) => word.trim())
    .filter((word) => word.length > 1 && !/^(1080p|720p|2160p|480p|x264|x265|h264|h265|web|dl|bluray|webrip|hdrip)$/i.test(word));

const searchPhrase = (words) => words.slice(0, 8).join(" ").trim();

const imagePayload = (frame) => {
  const image = String(frame.image ?? "");
  const match = /^data:image\/(?:jpeg|png|webp);base64,(.+)$/i.exec(image);
  return match?.[1] ?? image;
};

const googleVisionWebDetection = async (frames) => {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;

  if (!apiKey) {
    return {
      configured: false,
      provider: "google-vision-web-detection",
      results: []
    };
  }

  const requests = frames.slice(0, 10).map((frame) => ({
    features: [{ maxResults: 8, type: "WEB_DETECTION" }],
    image: { content: imagePayload(frame) }
  }));

  const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
    body: JSON.stringify({ requests }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

  if (!response.ok) {
    throw Object.assign(new Error("Google Vision Web Detection failed."), { status: 502 });
  }

  const body = await response.json();

  return {
    configured: true,
    provider: "google-vision-web-detection",
    results: (body.responses ?? []).map((result, index) => {
      const web = result.webDetection ?? {};

      return {
        frameIndex: frames[index]?.index ?? index,
        pages: (web.pagesWithMatchingImages ?? []).slice(0, 6).map((page) => ({
          score: page.score ?? 0,
          title: page.pageTitle ?? page.url ?? "Matching page",
          url: page.url ?? ""
        })),
        visualMatches: (web.visuallySimilarImages ?? []).slice(0, 6).map((match) => match.url ?? "").filter(Boolean),
        webEntities: (web.webEntities ?? []).slice(0, 8).map((entity) => ({
          description: entity.description ?? "",
          score: entity.score ?? 0
        })).filter((entity) => entity.description)
      };
    })
  };
};

export const createCinemaRoutes = (storage, accountStore) => {
  const listCinemaLibrary = async (request, response) => {
    const metadata = await readMetadata(storage.cinemaMetadataPath);
    const entries = await scanMediaLibrary(storage, metadata, { mediaKind: "video" });
    const context = request.nebulaAuth;

    if (context?.user) {
      const legacyPaths = Object.entries(metadata).filter(([, value]) => Boolean(value?.watchlisted)).map(([contentPath]) => contentPath);
      accountStore.migrateLegacyWatchlist(context.user.id, context.user.role === "owner" ? legacyPaths : []);
      const watchlist = accountStore.getWatchlist(context.user.id);
      entries.forEach((entry) => { entry.watchlisted = watchlist.has(entry.path); });
    }

    if (context) {
      entries.forEach((entry) => {
        const ticket = accountStore.issueMediaTicket({
          contentPath: entry.path,
          mediaKind: "video",
          principalId: context.user?.id ?? context.principalId,
          principalType: context.user ? "user" : "service"
        });
        entry.streamUrl = `/api/cinema/media?path=${encodeURIComponent(entry.path)}&ticket=${encodeURIComponent(ticket)}`;
      });
    }
    entries.sort((a, b) => (a.sortTitle || a.title).localeCompare(b.sortTitle || b.title));
    json(response, 200, { entries });
  };

  const updateCinemaMetadata = async (request, response) => {
    const body = await readBody(request);
    const contentPath = storage.relativePath(body.path ?? "");
    const absolutePath = storage.resolveContentPath(contentPath);
    const stats = await stat(absolutePath).catch(() => null);

    if (!stats || !stats.isFile() || !isVideoFile(absolutePath)) {
      json(response, 404, { error: "Media file not found." });
      return;
    }

    const fallbackTitle = defaultTitle(path.basename(contentPath));
    const metadata = await readMetadata(storage.cinemaMetadataPath);
    const current = metadataForEntry(metadata, contentPath, fallbackTitle);
    const genres = Array.isArray(body.genres)
      ? body.genres
      : String(body.genres ?? "")
        .split(",")
        .map((genre) => genre.trim())
        .filter(Boolean);

    metadata[contentPath] = {
      ...current,
      cast: String(body.cast ?? ""),
      collection: String(body.collection ?? ""),
      genres,
      posterUrl: String(body.posterUrl ?? ""),
      rating: String(body.rating ?? ""),
      releaseYear: String(body.releaseYear ?? ""),
      sortTitle: String(body.sortTitle ?? body.title ?? fallbackTitle),
      studio: String(body.studio ?? ""),
      summary: String(body.summary ?? ""),
      tagline: String(body.tagline ?? ""),
      title: String(body.title ?? fallbackTitle).trim() || fallbackTitle,
      updatedAt: new Date().toISOString()
    };

    await writeMetadata(storage.cinemaMetadataPath, metadata);
    json(response, 200, { metadata: metadata[contentPath], ok: true, path: contentPath });
  };

  const updateCinemaWatchlist = async (request, response) => {
    const body = await readBody(request);
    const contentPath = storage.relativePath(body.path ?? "");
    const absolutePath = storage.resolveContentPath(contentPath);
    const stats = await stat(absolutePath).catch(() => null);

    if (!stats || !stats.isFile() || !isVideoFile(absolutePath)) {
      json(response, 404, { error: "Media file not found." });
      return;
    }

    const fallbackTitle = defaultTitle(path.basename(contentPath));
    const metadata = await readMetadata(storage.cinemaMetadataPath);
    const current = metadataForEntry(metadata, contentPath, fallbackTitle);
    const watchlisted = Boolean(body.watchlisted);

    if (request.nebulaAuth?.user) {
      accountStore.setWatchlisted(request.nebulaAuth.user.id, contentPath, watchlisted);
      json(response, 200, { metadata: current, ok: true, path: contentPath, watchlisted });
      return;
    }

    metadata[contentPath] = {
      ...current,
      watchlisted,
      updatedAt: new Date().toISOString()
    };

    await writeMetadata(storage.cinemaMetadataPath, metadata);
    json(response, 200, { metadata: metadata[contentPath], ok: true, path: contentPath, watchlisted });
  };

  const identifyCinemaFrames = async (request, response) => {
    const body = await readBody(request);
    const frames = Array.isArray(body.frames) ? body.frames : [];
    const titleWords = candidateWords(body.title ?? body.path ?? "");
    const baseQuery = searchPhrase(titleWords);
    const frameQueries = frames.slice(0, 10).map((frame) => {
      const timestamp = Number(frame.time ?? 0);
      const timestampLabel = Number.isFinite(timestamp) ? `${Math.round(timestamp / 60)} min scene` : "scene";
      return [baseQuery, timestampLabel, "movie tv show"].filter(Boolean).join(" ");
    });

    const providers = [await googleVisionWebDetection(frames)];
    const entityScores = new Map();

    providers.forEach((provider) => {
      provider.results.forEach((result) => {
        result.webEntities?.forEach((entity) => {
          entityScores.set(entity.description, (entityScores.get(entity.description) ?? 0) + Number(entity.score ?? 0));
        });
      });
    });

    const candidates = Array.from(entityScores.entries())
      .map(([name, score]) => ({ name, score: Number(score.toFixed(3)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    json(response, 200, {
      candidates,
      frameQueries,
      providers,
      searchedAt: new Date().toISOString()
    });
  };

  const streamCinemaMedia = async (request, response, url) => {
    const requestedPath = url.searchParams.get("path") ?? "";
    const absolutePath = storage.resolveContentPath(requestedPath);
    const stats = await stat(absolutePath).catch(() => null);

    if (!stats || !stats.isFile() || !isVideoFile(absolutePath)) {
      json(response, 404, { error: "Media file not found." });
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
    if (request.method === "GET" && url.pathname === "/api/cinema/library") {
      await listCinemaLibrary(request, response);
      return true;
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/cinema/media") {
      await streamCinemaMedia(request, response, url);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/cinema/identify") {
      await identifyCinemaFrames(request, response);
      return true;
    }

    if (request.method === "PATCH" && url.pathname === "/api/cinema/metadata") {
      await updateCinemaMetadata(request, response);
      return true;
    }

    if (request.method === "PATCH" && url.pathname === "/api/cinema/watchlist") {
      await updateCinemaWatchlist(request, response);
      return true;
    }

    return false;
  };
};
