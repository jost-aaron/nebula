import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isAudioFile, isMediaFile, isVideoFile } from "./storage.mjs";

export const defaultTitle = (fileName) => path.basename(fileName, path.extname(fileName)).replace(/[._-]+/g, " ").trim();

export const readMetadata = async (metadataPath) => {
  const raw = await readFile(metadataPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return "{}";
    }

    throw error;
  });

  return JSON.parse(raw);
};

export const writeMetadata = async (metadataPath, metadata) => {
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
};

export const metadataForEntry = (metadata, contentPath, fallbackTitle) => ({
  album: "",
  artist: "",
  backdropUrl: "",
  cast: "",
  collection: "",
  genres: [],
  posterUrl: "",
  rating: "",
  releaseYear: "",
  sortTitle: fallbackTitle,
  studio: "",
  summary: "",
  tagline: "",
  tmdbId: null,
  tmdbImportedAt: "",
  tmdbMediaType: "",
  title: fallbackTitle,
  watchlisted: false,
  ...metadata[contentPath]
});

export const videoCategory = (contentPath) => {
  const lowerPath = contentPath.toLowerCase();
  const fileName = path.basename(contentPath);

  if (
    lowerPath.includes("/tv/") ||
    lowerPath.includes("/shows/") ||
    lowerPath.includes("/series/") ||
    /\bs\d{1,2}e\d{1,2}\b/i.test(fileName) ||
    /\b\d{1,2}x\d{1,2}\b/i.test(fileName)
  ) {
    return "tv";
  }

  return "movies";
};

export const scanMediaLibrary = async (storage, metadata, { mediaKind }, folder = storage.contentRoot, entries = []) => {
  for (const dirent of await readdir(folder, { withFileTypes: true })) {
    if (dirent.name === ".uploads") {
      continue;
    }

    const entryPath = path.join(folder, dirent.name);

    if (dirent.isDirectory()) {
      await scanMediaLibrary(storage, metadata, { mediaKind }, entryPath, entries);
      continue;
    }

    if (!dirent.isFile() || !isMediaFile(dirent.name)) {
      continue;
    }

    const isAudio = isAudioFile(dirent.name);
    const isVideo = isVideoFile(dirent.name);

    if ((mediaKind === "audio" && !isAudio) || (mediaKind === "video" && !isVideo)) {
      continue;
    }

    const entryStats = await stat(entryPath);
    const contentPath = storage.toContentPath(entryPath);
    const fallbackTitle = defaultTitle(dirent.name);
    const mediaMetadata = metadataForEntry(metadata, contentPath, fallbackTitle);
    const folderPath = path.dirname(contentPath) === "." ? "" : path.dirname(contentPath).split(path.sep).join("/");

    entries.push({
      album: mediaMetadata.album || mediaMetadata.collection,
      artist: mediaMetadata.artist || mediaMetadata.studio,
      backdropUrl: mediaMetadata.backdropUrl,
      category: isVideo ? videoCategory(contentPath) : "music",
      cast: mediaMetadata.cast,
      collection: mediaMetadata.collection,
      folder: folderPath,
      genres: Array.isArray(mediaMetadata.genres) ? mediaMetadata.genres : [],
      mediaKind: isAudio ? "audio" : "video",
      modifiedAt: entryStats.mtime.toISOString(),
      name: dirent.name,
      path: contentPath,
      posterUrl: mediaMetadata.posterUrl,
      rating: mediaMetadata.rating,
      releaseYear: mediaMetadata.releaseYear,
      size: entryStats.size,
      sortTitle: mediaMetadata.sortTitle || mediaMetadata.title || fallbackTitle,
      streamUrl: isAudio ? `/api/music/media?path=${encodeURIComponent(contentPath)}` : `/api/cinema/media?path=${encodeURIComponent(contentPath)}`,
      studio: mediaMetadata.studio,
      summary: mediaMetadata.summary,
      tagline: mediaMetadata.tagline,
      title: mediaMetadata.title || fallbackTitle,
      tmdbId: mediaMetadata.tmdbId,
      tmdbImportedAt: mediaMetadata.tmdbImportedAt,
      tmdbMediaType: mediaMetadata.tmdbMediaType,
      watchlisted: Boolean(mediaMetadata.watchlisted)
    });
  }

  return entries;
};
