import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isAudioFile, isMediaFile, isVideoFile } from "../storage.mjs";

const defaultTitle = (fileName) => path.basename(fileName, path.extname(fileName)).replace(/[._-]+/g, " ").trim();

const itemTypeFor = (contentPath, mediaKind) => {
  if (mediaKind === "audio") return "track";
  return /(?:^|\/)(?:tv(?:[ ._-]*shows?)?|shows|series)(?:\/|$)|\bs\d{1,2}e\d{1,3}\b|\b\d{1,2}x\d{1,3}\b/i.test(contentPath) ? "episode" : "movie";
};

export const discoverLocalMedia = async ({ absoluteRoot, contentPathPrefix = "", itemTypeOverride = null, mediaKind = "mixed" }) => {
  const files = [];
  const visit = async (folder) => {
    const entries = await readdir(folder, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".uploads") continue;
      const absolutePath = path.join(folder, entry.name);
      if (entry.isDirectory()) { await visit(absolutePath); continue; }
      if (!entry.isFile() || !isMediaFile(entry.name)) continue;
      const discoveredKind = isAudioFile(entry.name) ? "audio" : isVideoFile(entry.name) ? "video" : null;
      if (!discoveredKind || (mediaKind !== "mixed" && mediaKind !== discoveredKind)) continue;
      const details = await stat(absolutePath);
      const relativePath = path.relative(absoluteRoot, absolutePath).split(path.sep).join("/");
      const contentPath = contentPathPrefix ? path.posix.join(contentPathPrefix, relativePath) : relativePath;
      const title = defaultTitle(entry.name);
      files.push({
        fileKey: details.ino && details.dev ? `${details.dev}:${details.ino}` : null,
        itemType: itemTypeOverride ?? itemTypeFor(contentPath, discoveredKind),
        mediaKind: discoveredKind,
        modifiedMs: Math.trunc(details.mtimeMs),
        path: contentPath,
        size: details.size,
        sortTitle: title,
        title
      });
    }
  };
  await visit(absoluteRoot);
  return files;
};

export const scanLocalRoot = async ({ absoluteRoot, repository, rootId, scanType = "full", mediaKind = "mixed" }) => {
  try {
    const files = await discoverLocalMedia({ absoluteRoot, mediaKind });
    return repository.reconcileScan({ files, rootId, scanType });
  } catch (error) {
    repository.recordScanFailure?.({ error, rootId, scanType });
    throw error;
  }
};

export const bootstrapSharedContentRoot = (repository, { contentRoot, libraryId, libraryName = "Nebula Media", rootId } = {}) => {
  const existingRoot = repository.getRootByKey("shared-content");
  const library = repository.ensureLibrary({ id: existingRoot?.library_id ?? libraryId, mediaKind: "mixed", name: libraryName });
  const root = repository.ensureRoot({ id: existingRoot?.id ?? rootId, libraryId: library.id, mediaKind: "mixed", path: contentRoot, rootKey: "shared-content", rootType: "local" });
  return { library, root };
};
