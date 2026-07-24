import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { resolveProbePath } from "../probe/path.mjs";
import { generatedArtworkRelativePath } from "./paths.mjs";
import { runArtworkCapture } from "./runner.mjs";

export const createArtworkService = ({
  contentRoot,
  dataRoot,
  repository,
  resolveSource,
  runner = runArtworkCapture,
  uuid = randomUUID
}) => {
  if (!contentRoot || !dataRoot) throw new TypeError("contentRoot and dataRoot are required.");
  if (typeof resolveSource !== "function") throw new TypeError("resolveSource must be a function.");
  if (typeof repository?.putGeneratedArtwork !== "function") throw new TypeError("repository.putGeneratedArtwork is required.");
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

