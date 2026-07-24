const JOB_TYPES = Object.freeze(["scan", "probe", "fingerprint", "metadata", "artwork", "cleanup", "rendition"]);
const positiveInteger = (value, fallback) => Number.isInteger(value) && value > 0 ? value : fallback;

export const createJobsService = ({ repository, allowedTypes = JOB_TYPES } = {}) => {
  if (!repository || typeof repository.enqueue !== "function") throw new TypeError("A jobs repository is required.");
  const types = new Set(allowedTypes);
  const enqueue = (request) => {
    if (!request || !types.has(request.type)) throw Object.assign(new Error("Unsupported job type."), { status: 400 });
    if (request.payload !== undefined && (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload))) {
      throw Object.assign(new Error("Job payload must be an object."), { status: 400 });
    }
    return repository.enqueue({
      type: request.type,
      payload: request.payload ?? {},
      dedupeKey: request.dedupeKey === undefined ? null : String(request.dedupeKey),
      maxAttempts: positiveInteger(request.maxAttempts, 3),
      reuseTerminal: request.reuseTerminal === true,
      ...(request.availableAt !== undefined ? { availableAt: request.availableAt } : {})
    });
  };
  const get = (id) => repository.get(id);
  const findByDedupe = (type, dedupeKey) => repository.findByDedupe(type, dedupeKey);
  const list = (query = {}) => repository.list({ ...query, limit: Math.min(200, positiveInteger(query.limit, 50)) });
  const cancel = (id) => repository.requestCancellation(id);
  const cancelAll = () => repository.requestCancellationAll();
  return { cancel, cancelAll, enqueue, findByDedupe, get, list, types: [...types] };
};

export { JOB_TYPES };
