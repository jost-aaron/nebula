import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { RemuxError } from "./errors.mjs";

export const resolveRemuxSourcePath = async (contentRoot, sourcePath) => {
  if (typeof sourcePath !== "string" || !sourcePath || path.isAbsolute(sourcePath)) {
    throw new RemuxError("unsafe_path", "The catalog source path must be content-relative.");
  }
  const root = await realpath(contentRoot);
  const resolved = path.resolve(root, sourcePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new RemuxError("unsafe_path", "The catalog source resolves outside the content root.");
  }
  let candidate;
  try {
    candidate = await realpath(resolved);
    const details = await stat(candidate);
    if (!details.isFile()) throw new Error("not a file");
  } catch (error) {
    if (error instanceof RemuxError) throw error;
    throw new RemuxError("missing_source", "The catalog source file is missing.", { cause: error, retryable: true });
  }
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new RemuxError("unsafe_path", "The catalog source resolves outside the content root.");
  }
  return candidate;
};
