import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ProbeError } from "./errors.mjs";

const isInside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

export const resolveProbePath = async (contentRoot, contentPath) => {
  if (typeof contentPath !== "string" || !contentPath || path.isAbsolute(contentPath) || contentPath.includes("\0")) {
    throw new ProbeError("unsafe_path", "Probe path must be a non-empty content-relative path.");
  }
  const root = await realpath(contentRoot);
  const candidate = path.resolve(root, contentPath);
  if (!isInside(root, candidate)) throw new ProbeError("unsafe_path", "Probe path escapes the content root.");

  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") throw new ProbeError("missing", "Media source is missing.", { cause: error, retryable: true });
    throw error;
  }
  if (!isInside(root, resolved)) throw new ProbeError("unsafe_path", "Probe path resolves outside the content root.");
  const details = await stat(resolved);
  if (!details.isFile()) throw new ProbeError("not_file", "Probe source is not a regular file.");
  return resolved;
};
