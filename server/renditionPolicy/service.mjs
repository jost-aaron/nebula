import { statfs } from "node:fs/promises";
import { listRenditionProfiles } from "../renditions/profiles.mjs";

const bad = (message) => Object.assign(new Error(message), { status: 400, code: "invalid_rendition_policy", expose: true });
const integer = (value, min, max, name, nullable = false) => {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw bad(`${name} is outside the supported range.`);
  return value;
};
export const validateRenditionPolicy = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad("Rendition policy must be an object.");
  const known = new Set(["allowedProfileIds","cacheInteractive","cleanupBatchSize","cleanupIntervalMinutes","failedRecordDays","highWaterPercent","lowWaterPercent","maxCacheAgeDays","minimumFreeBytes","pinScheduledByDefault","quotaBytes","staleRecordDays"]);
  if (Object.keys(value).some((key) => !known.has(key))) throw bad("Rendition policy contains unsupported fields.");
  const profiles = new Set(listRenditionProfiles().map((profile) => profile.id));
  if (!Array.isArray(value.allowedProfileIds) || value.allowedProfileIds.some((id) => !profiles.has(id)) || new Set(value.allowedProfileIds).size !== value.allowedProfileIds.length) throw bad("Allowed profiles are invalid.");
  if (typeof value.cacheInteractive !== "boolean" || typeof value.pinScheduledByDefault !== "boolean") throw bad("Policy flags must be boolean values.");
  const policy = {
    allowedProfileIds: [...value.allowedProfileIds], cacheInteractive: value.cacheInteractive,
    cleanupBatchSize: integer(value.cleanupBatchSize, 1, 1000, "Cleanup batch size"),
    cleanupIntervalMinutes: integer(value.cleanupIntervalMinutes, 5, 10080, "Cleanup interval"),
    failedRecordDays: integer(value.failedRecordDays, 1, 3650, "Failed retention"),
    highWaterPercent: integer(value.highWaterPercent, 50, 99, "High water"),
    lowWaterPercent: integer(value.lowWaterPercent, 25, 98, "Low water"),
    maxCacheAgeDays: integer(value.maxCacheAgeDays, 1, 3650, "Cache age", true),
    minimumFreeBytes: integer(value.minimumFreeBytes, 0, 2 ** 50, "Minimum free bytes"),
    pinScheduledByDefault: value.pinScheduledByDefault,
    quotaBytes: integer(value.quotaBytes, 1024 ** 2, 2 ** 50, "Quota", true),
    staleRecordDays: integer(value.staleRecordDays, 1, 3650, "Stale retention")
  };
  if (policy.lowWaterPercent >= policy.highWaterPercent) throw bad("Low water must be below high water.");
  return policy;
};

export const createRenditionPolicyService = ({ audit, jobs, repository, store, stat = statfs, now = () => Date.now() }) => {
  let cleanupRunning = false;
  const operations = { evictions: { age: 0, pressure: 0 }, lastCleanupDurationMs: 0 };
  const status = async () => {
    const policy = repository.get();
    const usage = store.usage();
    const disk = await stat(store.root).then((info) => ({ freeBytes: Number(info.bavail) * Number(info.bsize), totalBytes: Number(info.blocks) * Number(info.bsize) })).catch(() => ({ freeBytes: null, totalBytes: null }));
    return { disk, operations, policy, usage };
  };
  const enqueueCleanup = (reason = "manual") => jobs.enqueue({ type: "cleanup", payload: { scope: "renditions", reason }, dedupeKey: "cleanup:renditions", maxAttempts: 3 });
  const cleanup = async (payload, context) => {
    if (payload?.scope !== "renditions" || !["scheduled","quota-pressure","manual","startup"].includes(payload?.reason)) return { skipped: true };
    if (cleanupRunning) return { deduplicated: true };
    cleanupRunning = true;
    const started = now();
    try {
      const policy = repository.get();
      const before = policy.maxCacheAgeDays === null ? null : new Date(now() - policy.maxCacheAgeDays * 86400000).toISOString();
      let removed = 0; let bytesFreed = 0;
      await store.reconcileFilesystem();
      const disk = await status();
      const totalReady = disk.usage.totalReadyBytes;
      const high = policy.quotaBytes === null ? Infinity : policy.quotaBytes * policy.highWaterPercent / 100;
      const low = policy.quotaBytes === null ? 0 : policy.quotaBytes * policy.lowWaterPercent / 100;
      let pressure = totalReady > high || (disk.disk.freeBytes !== null && disk.disk.freeBytes < policy.minimumFreeBytes);
      const candidates = store.listEvictionCandidates({ before: pressure ? null : before, limit: policy.cleanupBatchSize });
      for (const candidate of candidates) {
        context?.throwIfCancelled?.();
        if (!pressure && before === null) break;
        const reason = pressure ? "pressure" : "age";
        bytesFreed += candidate.sizeBytes ?? 0; await store.remove(candidate.id); removed += 1;
        operations.evictions[reason] += 1;
        const remaining = totalReady - bytesFreed;
        const projectedFree = disk.disk.freeBytes === null ? Infinity : disk.disk.freeBytes + bytesFreed;
        pressure = remaining > low || projectedFree < policy.minimumFreeBytes;
        if (!pressure && payload.reason === "quota-pressure") break;
      }
      const cutoff = (days) => new Date(now() - days * 86400000).toISOString();
      const pruned = store.pruneRecords({ failedBefore: cutoff(policy.failedRecordDays), staleBefore: cutoff(policy.staleRecordDays) });
      operations.lastCleanupDurationMs = Math.max(0, now() - started);
      audit?.recordBestEffort({ actor: { kind: "system" }, eventType: "rendition.cleanup_completed", outcome: "success", metadata: { reason: payload.reason } });
      return { bytesFreed, durationMs: operations.lastCleanupDurationMs, removed, pruned };
    } finally { cleanupRunning = false; }
  };
  return {
    cleanup, enqueueCleanup, get: repository.get,
    set(value) { return repository.set(validateRenditionPolicy(value)); },
    status
  };
};
