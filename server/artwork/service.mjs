import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveProbePath } from "../probe/path.mjs";
import { cachedArtworkRelativePath, currentLocalArtwork, generatedArtworkRelativePath } from "./paths.mjs";
import { runArtworkCapture } from "./runner.mjs";

const MAX_POSTER_BYTES = 15 * 1024 * 1024;
const POSTER_TIMEOUT_MS = 15_000;
const readBoundedImage = async (response) => {
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_POSTER_BYTES) throw Object.assign(new Error("Remote poster response is too large."), { code: "ARTWORK_REMOTE_INVALID" });
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_POSTER_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error("Remote poster response is too large."), { code: "ARTWORK_REMOTE_INVALID" });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
};

export const createArtworkService = ({
  contentRoot,
  dataRoot,
  fetchImpl = globalThis.fetch,
  repository,
  resolveSource,
  runner = runArtworkCapture,
  uuid = randomUUID
}) => {
  if (!contentRoot || !dataRoot) throw new TypeError("contentRoot and dataRoot are required.");
  if (typeof resolveSource !== "function") throw new TypeError("resolveSource must be a function.");
  if (typeof repository?.putGeneratedArtwork !== "function" || typeof repository?.putCachedArtwork !== "function") {
    throw new TypeError("repository artwork persistence is required.");
  }
  const artworkRoot = path.join(dataRoot, "artwork");

  const generate = async ({ contentRevision, sourceId }, context = {}) => {
    context.throwIfCancelled?.();
    const source = await resolveSource(sourceId);
    if (!source || source.availability !== "available" || source.mediaKind !== "video") {
      throw Object.assign(new Error(`Unknown or unavailable video source: ${sourceId}`), { code: "ARTWORK_SOURCE_MISSING" });
    }
    if (source.contentRevision !== contentRevision) {
      throw Object.assign(new Error("Media changed before its artwork job started."), { code: "ARTWORK_SOURCE_CHANGED" });
    }
    const item = repository.getItem(source.itemId);
    const existingArtwork = repository.listArtwork(source.itemId);
    const existingLocal = currentLocalArtwork(existingArtwork, source);
    if (existingLocal) {
      context.reportProgress?.(0.95, "artwork-ready");
      return { cached: existingLocal.provider !== "nebula-frame", contentRevision: source.contentRevision, sourceId: source.id };
    }
    const remotePosterUrl = String(
      item?.metadata?.posterUrl
      || existingArtwork.find((entry) => entry.type === "poster" && entry.remoteUrl)?.remoteUrl
      || ""
    ).trim();
    if (remotePosterUrl) {
      const url = new URL(remotePosterUrl);
      if (url.protocol !== "https:") {
        throw Object.assign(new Error("Remote poster must use HTTPS."), { code: "ARTWORK_REMOTE_URL_INVALID" });
      }
      const relativePath = cachedArtworkRelativePath(source.id, source.contentRevision);
      const outputPath = path.join(dataRoot, ...relativePath.split("/"));
      const outputDirectory = path.dirname(outputPath);
      const temporaryPath = path.join(outputDirectory, `${source.contentRevision}.${uuid()}.tmp.jpg`);
      await mkdir(outputDirectory, { recursive: true });
      context.reportProgress?.(0.15, "downloading-poster");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), POSTER_TIMEOUT_MS);
      try {
        const response = await fetchImpl(url, {
          headers: { accept: "image/avif,image/webp,image/jpeg,image/*" },
          redirect: "follow",
          signal: controller.signal
        });
        if (!response.ok) {
          throw Object.assign(new Error(`Poster download failed with HTTP ${response.status}.`), { code: "ARTWORK_REMOTE_DOWNLOAD_FAILED" });
        }
        const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
        const declaredLength = Number(response.headers.get("content-length") ?? 0);
        if (!contentType.startsWith("image/") || declaredLength > MAX_POSTER_BYTES) {
          throw Object.assign(new Error("Remote poster response is not a supported image."), { code: "ARTWORK_REMOTE_INVALID" });
        }
        const bytes = await readBoundedImage(response);
        if (bytes.length < 128 || bytes.length > MAX_POSTER_BYTES) {
          throw Object.assign(new Error("Remote poster response has an invalid size."), { code: "ARTWORK_REMOTE_INVALID" });
        }
        context.throwIfCancelled?.();
        await writeFile(temporaryPath, bytes, { flag: "wx" });
        context.reportProgress?.(0.8, "publishing-artwork");
        await rename(temporaryPath, outputPath);
        repository.putCachedArtwork(source.id, {
          expectedContentRevision: source.contentRevision,
          height: null,
          localPath: relativePath,
          remoteUrl: remotePosterUrl,
          width: null
        });
        for (const name of await readdir(outputDirectory)) {
          if (name !== path.basename(outputPath)) await rm(path.join(outputDirectory, name), { force: true });
        }
        context.reportProgress?.(0.95, "artwork-ready");
        return { cached: true, contentRevision: source.contentRevision, sourceId: source.id };
      } finally {
        clearTimeout(timeout);
        await rm(temporaryPath, { force: true }).catch(() => {});
      }
    }
    const inputPath = await resolveProbePath(contentRoot, source.path);
    const relativePath = generatedArtworkRelativePath(source.id, source.contentRevision);
    const outputPath = path.join(dataRoot, ...relativePath.split("/"));
    const outputDirectory = path.dirname(outputPath);
    const temporaryPath = path.join(outputDirectory, `${source.contentRevision}.${uuid()}.tmp.jpg`);
    await mkdir(outputDirectory, { recursive: true });
    context.reportProgress?.(0.15, "capturing-frame");
    try {
      try {
        await runner(inputPath, temporaryPath, { height: 480, seekSeconds: 12, width: 320 });
      } catch {
        await rm(temporaryPath, { force: true });
        await runner(inputPath, temporaryPath, { height: 480, seekSeconds: 1, width: 320 });
      }
      context.throwIfCancelled?.();
      const details = await stat(temporaryPath);
      if (!details.isFile() || details.size < 128) {
        throw Object.assign(new Error("Artwork capture did not produce a valid image."), { code: "ARTWORK_OUTPUT_INVALID" });
      }
      context.reportProgress?.(0.8, "publishing-artwork");
      await rename(temporaryPath, outputPath);
      repository.putGeneratedArtwork(source.id, {
        expectedContentRevision: source.contentRevision,
        height: 480,
        localPath: relativePath,
        width: 320
      });
      for (const name of await readdir(outputDirectory)) {
        if (name !== path.basename(outputPath)) await rm(path.join(outputDirectory, name), { force: true });
      }
      context.reportProgress?.(0.95, "artwork-ready");
      return { contentRevision: source.contentRevision, height: 480, sourceId: source.id, width: 320 };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  };

  return { artworkRoot, generate };
};
