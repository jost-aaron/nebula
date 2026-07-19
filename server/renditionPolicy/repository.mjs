const fromRow = (row) => ({
  allowedProfileIds: JSON.parse(row.allowed_profile_ids_json), cacheInteractive: Boolean(row.cache_interactive),
  cleanupBatchSize: row.cleanup_batch_size, cleanupIntervalMinutes: row.cleanup_interval_minutes,
  failedRecordDays: row.failed_record_days, highWaterPercent: row.high_water_percent,
  lowWaterPercent: row.low_water_percent, maxCacheAgeDays: row.max_cache_age_days,
  minimumFreeBytes: row.minimum_free_bytes, pinScheduledByDefault: Boolean(row.pin_scheduled_by_default),
  quotaBytes: row.quota_bytes, staleRecordDays: row.stale_record_days, updatedAt: row.updated_at
});

export const createRenditionPolicyRepository = (database, { now = () => new Date() } = {}) => ({
  get: () => fromRow(database.prepare("SELECT * FROM rendition_storage_policy WHERE id = 1").get()),
  set(policy) {
    database.prepare(`UPDATE rendition_storage_policy SET quota_bytes=?, high_water_percent=?, low_water_percent=?,
      minimum_free_bytes=?, max_cache_age_days=?, failed_record_days=?, stale_record_days=?, cleanup_interval_minutes=?,
      cleanup_batch_size=?, cache_interactive=?, pin_scheduled_by_default=?, allowed_profile_ids_json=?, updated_at=? WHERE id=1`)
      .run(policy.quotaBytes, policy.highWaterPercent, policy.lowWaterPercent, policy.minimumFreeBytes,
        policy.maxCacheAgeDays, policy.failedRecordDays, policy.staleRecordDays, policy.cleanupIntervalMinutes,
        policy.cleanupBatchSize, Number(policy.cacheInteractive), Number(policy.pinScheduledByDefault),
        JSON.stringify(policy.allowedProfileIds), now().toISOString());
    return this.get();
  }
});
