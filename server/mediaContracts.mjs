/**
 * Wave 0 structural contracts for backend media domains.
 *
 * These typedefs intentionally contain no persistence or routing behavior.
 * Domain implementations should accept these interfaces through factories
 * rather than importing another domain's SQLite connection directly.
 */

/** @typedef {string} CatalogId Opaque UUID assigned by the server. */

/**
 * @typedef {object} CatalogRepository
 * @property {(id: CatalogId) => object | null} getItem
 * @property {(id: CatalogId) => object | null} getSource
 * @property {(contentPath: string) => object | null} resolveContentPath
 * @property {(query?: object) => object[]} listItems
 * @property {(scan: object) => object} reconcileScan
 * @property {(itemId: CatalogId, metadata: object) => object} putExternalMetadata
 * @property {(sourceId: CatalogId, probe: object) => object} putProbeResult
 */

/**
 * @typedef {object} CatalogService
 * @property {(id: CatalogId, principal: object) => object | null} getItem
 * @property {(contentPath: string, principal: object) => object | null} resolveCompatibilityPath
 * @property {(query: object, principal: object) => object[]} listItems
 * @property {(request: object, principal: object) => object} scanLibrary
 * @property {(itemId: CatalogId, metadata: object, principal: object) => object} applyMetadata
 */

/**
 * @typedef {object} PlaybackRepository
 * @property {(userId: string, itemId: CatalogId) => object | null} getState
 * @property {(userId: string, limit?: number) => object[]} listContinueWatching
 * @property {(event: object) => object} recordEvent
 * @property {(sessionId: CatalogId) => object | null} getSession
 */

/**
 * Validate a domain dependency at its composition boundary. This catches an
 * accidentally incomplete adapter without coupling domains to an implementation.
 *
 * @param {string} name
 * @param {object} candidate
 * @param {string[]} methods
 * @returns {object}
 */
export const requireMediaContract = (name, candidate, methods) => {
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError(`${name} is required.`);
  }

  for (const method of methods) {
    if (typeof candidate[method] !== "function") {
      throw new TypeError(`${name}.${method} must be a function.`);
    }
  }

  return candidate;
};

export const CATALOG_REPOSITORY_METHODS = Object.freeze([
  "getItem",
  "getSource",
  "resolveContentPath",
  "listItems",
  "reconcileScan",
  "putExternalMetadata",
  "putProbeResult"
]);

export const PLAYBACK_REPOSITORY_METHODS = Object.freeze([
  "getState",
  "listContinueWatching",
  "recordEvent",
  "getSession"
]);
