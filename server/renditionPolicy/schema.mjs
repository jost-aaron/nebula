export const RENDITION_POLICY_DEFAULTS = Object.freeze({
  allowedProfileIds: ["240p", "360p", "480p", "720p", "1080p"], cacheInteractive: true,
  cleanupBatchSize: 50, cleanupIntervalMinutes: 60, failedRecordDays: 14,
  highWaterPercent: 90, lowWaterPercent: 75, maxCacheAgeDays: 30,
  minimumFreeBytes: 1024 ** 3, pinScheduledByDefault: false, quotaBytes: null,
  staleRecordDays: 14
});

export const renditionPolicyMigration = Object.freeze({
  domain: "renditions", id: "renditions-v2", version: 2,
  apply(database) {
    database.exec(`CREATE TABLE rendition_storage_policy (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      quota_bytes INTEGER CHECK (quota_bytes IS NULL OR quota_bytes BETWEEN 1048576 AND 1125899906842624),
      high_water_percent INTEGER NOT NULL CHECK (high_water_percent BETWEEN 50 AND 99),
      low_water_percent INTEGER NOT NULL CHECK (low_water_percent BETWEEN 25 AND 98),
      minimum_free_bytes INTEGER NOT NULL CHECK (minimum_free_bytes BETWEEN 0 AND 1125899906842624),
      max_cache_age_days INTEGER CHECK (max_cache_age_days IS NULL OR max_cache_age_days BETWEEN 1 AND 3650),
      failed_record_days INTEGER NOT NULL CHECK (failed_record_days BETWEEN 1 AND 3650),
      stale_record_days INTEGER NOT NULL CHECK (stale_record_days BETWEEN 1 AND 3650),
      cleanup_interval_minutes INTEGER NOT NULL CHECK (cleanup_interval_minutes BETWEEN 5 AND 10080),
      cleanup_batch_size INTEGER NOT NULL CHECK (cleanup_batch_size BETWEEN 1 AND 1000),
      cache_interactive INTEGER NOT NULL CHECK (cache_interactive IN (0, 1)),
      pin_scheduled_by_default INTEGER NOT NULL CHECK (pin_scheduled_by_default IN (0, 1)),
      allowed_profile_ids_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (low_water_percent < high_water_percent)
    ) STRICT;`);
    const d = RENDITION_POLICY_DEFAULTS;
    database.prepare(`INSERT OR IGNORE INTO rendition_storage_policy
      (id, quota_bytes, high_water_percent, low_water_percent, minimum_free_bytes, max_cache_age_days,
       failed_record_days, stale_record_days, cleanup_interval_minutes, cleanup_batch_size,
       cache_interactive, pin_scheduled_by_default, allowed_profile_ids_json, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(d.quotaBytes, d.highWaterPercent, d.lowWaterPercent, d.minimumFreeBytes, d.maxCacheAgeDays,
        d.failedRecordDays, d.staleRecordDays, d.cleanupIntervalMinutes, d.cleanupBatchSize,
        Number(d.cacheInteractive), Number(d.pinScheduledByDefault), JSON.stringify(d.allowedProfileIds), new Date().toISOString());
  }
});

export const renditionProfileExpansionMigration = Object.freeze({
  domain: "renditions", id: "renditions-v3", version: 3,
  apply(database) {
    const row = database.prepare("SELECT allowed_profile_ids_json FROM rendition_storage_policy WHERE id = 1").get();
    if (!row) return;
    const existing = JSON.parse(row.allowed_profile_ids_json);
    const allowedProfileIds = [...new Set(["240p", "360p", ...(Array.isArray(existing) ? existing : [])])];
    database.prepare("UPDATE rendition_storage_policy SET allowed_profile_ids_json = ? WHERE id = 1")
      .run(JSON.stringify(allowedProfileIds));
  }
});

export const renditionPolicyMigrations = Object.freeze([
  renditionPolicyMigration,
  renditionProfileExpansionMigration
]);
