export const createPlaybackCompatibilityResolver = ({ resolveContentPath, validateContentPath } = {}) => {
  if (typeof validateContentPath !== "function") throw new TypeError("validateContentPath must be a function.");
  if (typeof resolveContentPath !== "function") throw new TypeError("resolveContentPath must be a function.");

  return {
    async resolveValidatedContentPath(contentPath, principal) {
      const validatedPath = await validateContentPath(contentPath, principal);
      if (!validatedPath) return null;
      const result = await resolveContentPath(validatedPath, principal);
      return result ? { itemId: result.itemId, sourceId: result.sourceId } : null;
    }
  };
};
