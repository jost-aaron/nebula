import { mkdir } from "node:fs/promises";
import path from "node:path";

export const createStorage = async ({ contentRoot }) => {
  const uploadRoot = path.join(contentRoot, ".uploads");
  const cinemaMetadataPath = path.join(contentRoot, ".cinema-metadata.json");

  await mkdir(contentRoot, { recursive: true });
  await mkdir(uploadRoot, { recursive: true });

  const relativePath = (value = "") => {
    const normalized = path.normalize(value).replace(/^(\.\.(\/|\\|$))+/, "");
    return normalized === "." ? "" : normalized;
  };

  const resolveContentPath = (value = "") => {
    const resolved = path.resolve(contentRoot, relativePath(value));

    if (resolved !== contentRoot && !resolved.startsWith(`${contentRoot}${path.sep}`)) {
      throw Object.assign(new Error("Path escapes content root."), { status: 400 });
    }

    return resolved;
  };

  const toContentPath = (absolutePath) => path.relative(contentRoot, absolutePath).split(path.sep).join("/");

  return {
    cinemaMetadataPath,
    contentRoot,
    relativePath,
    resolveContentPath,
    toContentPath,
    uploadRoot
  };
};

export const audioExtensions = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"]);
export const videoExtensions = new Set([".m4v", ".mov", ".mp4", ".webm"]);

export const safeFileName = (name = "") => Boolean(name) && !name.includes("/") && !name.includes("\\");

export const isVideoFile = (name) => videoExtensions.has(path.extname(name).toLowerCase());

export const isAudioFile = (name) => audioExtensions.has(path.extname(name).toLowerCase());

export const isMediaFile = (name) => isVideoFile(name) || isAudioFile(name);

export const mimeType = (name) => {
  const extension = path.extname(name).toLowerCase();

  return (
    {
      ".css": "text/css",
      ".aac": "audio/aac",
      ".flac": "audio/flac",
      ".gif": "image/gif",
      ".html": "text/html",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".js": "text/javascript",
      ".json": "application/json",
      ".m4a": "audio/mp4",
      ".md": "text/markdown",
      ".mov": "video/quicktime",
      ".mp4": "video/mp4",
      ".mp3": "audio/mpeg",
      ".ogg": "audio/ogg",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".txt": "text/plain",
      ".wav": "audio/wav",
      ".webm": "video/webm",
      ".webp": "image/webp"
    }[extension] ?? "application/octet-stream"
  );
};
