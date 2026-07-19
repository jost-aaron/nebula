import { apiJson } from "./http";

export interface RenditionStoragePolicy {
  allowedProfileIds: string[]; cacheInteractive: boolean; cleanupBatchSize: number;
  cleanupIntervalMinutes: number; failedRecordDays: number; highWaterPercent: number;
  lowWaterPercent: number; maxCacheAgeDays: number | null; minimumFreeBytes: number;
  pinScheduledByDefault: boolean; quotaBytes: number | null; staleRecordDays: number; updatedAt?: string;
}
export interface RenditionStorageStatus {
  disk: { freeBytes: number | null; totalBytes: number | null };
  operations: { evictions: { age: number; pressure: number }; lastCleanupDurationMs: number };
  policy: RenditionStoragePolicy;
  usage: { groups: Array<{ bytes: number; count: number; retention: "cache" | "pinned"; state: string }>; totalBytes: number; totalReadyBytes: number };
}
export const getRenditionPolicy = () => apiJson<{ policy: RenditionStoragePolicy }>("/api/admin/rendition-policy");
export const saveRenditionPolicy = (policy: RenditionStoragePolicy) => apiJson<{ policy: RenditionStoragePolicy }>("/api/admin/rendition-policy", { method: "PUT", body: JSON.stringify(policy) });
export const getRenditionStorageStatus = () => apiJson<RenditionStorageStatus>("/api/admin/renditions/status");
export const runRenditionCleanup = () => apiJson<{ created: boolean; job: { id: string; state: string } }>("/api/admin/renditions/cleanup", { method: "POST", body: "{}" });
