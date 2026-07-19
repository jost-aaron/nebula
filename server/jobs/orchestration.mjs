import { JOB_TYPES } from "./service.mjs";

const REQUIRED_OPERATIONS = Object.freeze({
  artwork: "cacheArtwork",
  cleanup: "cleanup",
  fingerprint: "fingerprintSource",
  metadata: "refreshMetadata",
  probe: "probeSource",
  rendition: "buildRendition",
  scan: "scanLibrary"
});

export const createMediaJobHandlers = (operations = {}) => Object.fromEntries(JOB_TYPES.map((type) => {
  const operationName = REQUIRED_OPERATIONS[type];
  const operation = operations[operationName];
  if (typeof operation !== "function") throw new TypeError(`operations.${operationName} must be a function.`);
  return [type, async (job, context) => operation(job.payload, context)];
}));

export const mediaJobOperations = REQUIRED_OPERATIONS;
