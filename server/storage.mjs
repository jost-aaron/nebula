import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export const createStorage = async ({ contentRoot, dataRoot = path.join(path.dirname(contentRoot), "data") }) => {
  const uploadRoot = path.join(contentRoot, ".uploads");
  const uploadReservationRoot = path.join(uploadRoot, ".reservations");
  const cinemaMetadataPath = path.join(contentRoot, ".cinema-metadata.json");

  await mkdir(contentRoot, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await mkdir(uploadRoot, { recursive: true });
  await mkdir(uploadReservationRoot, { recursive: true });
  const canonicalContentRoot = await realpath(contentRoot);

  const relativePath = (value = "") => {
    if (typeof value !== "string" || value.includes("\0") || path.isAbsolute(value)) {
      throw Object.assign(new Error("Content path is invalid."), {
        code: "invalid_content_path",
        expose: true,
        status: 400
      });
    }
    const normalized = path.normalize(value);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      throw Object.assign(new Error("Path escapes content root."), {
        code: "invalid_content_path",
        expose: true,
        status: 400
      });
    }
    return normalized === "." ? "" : normalized;
  };

  const resolveContentPath = (value = "") => {
    const resolved = path.resolve(contentRoot, relativePath(value));

    if (resolved !== contentRoot && !resolved.startsWith(`${contentRoot}${path.sep}`)) {
      throw Object.assign(new Error("Path escapes content root."), { status: 400 });
    }

    return resolved;
  };

  const unsafePath = () => Object.assign(new Error("Symbolic links are not available through Files."), {
    code: "unsafe_content_path",
    expose: true,
    status: 400
  });

  const assertNoSymlinkSegments = async (absolutePath, { allowMissingLeaf = false } = {}) => {
    const resolved = path.resolve(absolutePath);
    if (resolved !== contentRoot && !resolved.startsWith(`${contentRoot}${path.sep}`)) {
      throw Object.assign(new Error("Path escapes content root."), {
        code: "invalid_content_path",
        expose: true,
        status: 400
      });
    }

    const relative = path.relative(contentRoot, resolved);
    const segments = relative ? relative.split(path.sep) : [];
    let current = contentRoot;
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const currentStats = await lstat(current).catch((error) => {
        if (error.code === "ENOENT" && allowMissingLeaf && index === segments.length - 1) return null;
        throw error;
      });
      if (!currentStats) break;
      if (currentStats.isSymbolicLink()) throw unsafePath();
    }

    const canonical = await realpath(resolved).catch((error) => {
      if (error.code === "ENOENT" && allowMissingLeaf) return null;
      throw error;
    });
    if (canonical && canonical !== canonicalContentRoot && !canonical.startsWith(`${canonicalContentRoot}${path.sep}`)) {
      throw unsafePath();
    }
    return resolved;
  };

  const resolveExistingContentPath = async (value = "") =>
    assertNoSymlinkSegments(resolveContentPath(value));

  const resolveContentDestination = async (value = "") => {
    const resolved = resolveContentPath(value);
    if (resolved === contentRoot) {
      return assertNoSymlinkSegments(resolved);
    }
    await assertNoSymlinkSegments(path.dirname(resolved));
    return assertNoSymlinkSegments(resolved, { allowMissingLeaf: true });
  };

  const toContentPath = (absolutePath) => path.relative(contentRoot, absolutePath).split(path.sep).join("/");

  return {
    cinemaMetadataPath,
    contentRoot,
    dataRoot,
    accountDatabasePath: path.join(dataRoot, "nebula.sqlite"),
    assertNoSymlinkSegments,
    canonicalContentRoot,
    relativePath,
    resolveContentDestination,
    resolveExistingContentPath,
    resolveContentPath,
    toContentPath,
    uploadRoot,
    uploadReservationRoot
  };
};

export const audioExtensions = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"]);
export const videoExtensions = new Set([".m4v", ".mkv", ".mov", ".mp4", ".webm"]);

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
