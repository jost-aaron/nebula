import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { TranscodeError } from "./errors.mjs";

const contained = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

export const resolveTranscodeSourcePath = async (contentRoot, sourcePath) => {
  if (typeof sourcePath !== "string" || !sourcePath || path.isAbsolute(sourcePath)) {
    throw new TranscodeError("unsafe_path", "The catalog source path must be content-relative.");
  }
  const root = await realpath(contentRoot);
  const requested = path.resolve(root, sourcePath);
  if (!contained(root, requested)) throw new TranscodeError("unsafe_path", "The catalog source resolves outside the content root.");
  try {
    const candidate = await realpath(requested);
    const details = await stat(candidate);
    if (!details.isFile()) throw new Error("not a file");
    if (!contained(root, candidate)) throw new TranscodeError("unsafe_path", "The catalog source resolves outside the content root.");
    return candidate;
  } catch (error) {
    if (error instanceof TranscodeError) throw error;
    throw new TranscodeError("missing_source", "The catalog source file is missing.", { cause: error, retryable: true });
  }
};

const ASSET_NAMES = /^(?:master\.m3u8|media\.m3u8|segment-\d{5}\.ts)$/;

export const resolveTranscodeAssetPath = async (sessionDirectory, assetName) => {
  if (typeof assetName !== "string" || !ASSET_NAMES.test(assetName) || path.basename(assetName) !== assetName) {
    throw new TranscodeError("unsafe_asset", "The requested transcode asset is invalid.");
  }
  const root = await realpath(sessionDirectory).catch(() => { throw new TranscodeError("missing_asset", "The transcode asset is unavailable."); });
  const requested = path.resolve(root, assetName);
  if (!contained(root, requested)) throw new TranscodeError("unsafe_asset", "The requested transcode asset is invalid.");
  try {
    const candidate = await realpath(requested);
    const details = await stat(candidate);
    if (!details.isFile() || !contained(root, candidate)) throw new TranscodeError("unsafe_asset", "The requested transcode asset is invalid.");
    return candidate;
  } catch (error) {
    if (error instanceof TranscodeError) throw error;
    throw new TranscodeError("missing_asset", "The transcode asset is unavailable.", { cause: error });
  }
};
