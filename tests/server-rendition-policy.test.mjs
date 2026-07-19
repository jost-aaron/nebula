import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";
import { createRenditionCleanupScheduler, createRenditionPolicyRepository, createRenditionPolicyService, renditionPolicyMigration, validateRenditionPolicy } from "../server/renditionPolicy/index.mjs";

const fixture = () => {
  const database = new DatabaseSync(":memory:");
  applyDomainMigrations(database, [renditionPolicyMigration]);
  const repository = createRenditionPolicyRepository(database);
  return { database, repository };
};

test("renditions-v2 migration is centrally composed, idempotent, and bounded", () => {
  const { database, repository } = fixture();
  applyDomainMigrations(database, [renditionPolicyMigration]);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM nebula_domain_migrations WHERE migration_id='renditions-v2'").get().count, 1);
  assert.deepEqual(repository.get().allowedProfileIds, ["480p", "720p", "1080p"]);
  assert.throws(() => database.prepare("UPDATE rendition_storage_policy SET low_water_percent=95, high_water_percent=90 WHERE id=1").run());
  database.close();
});

test("policy validation rejects unsafe fields, bad water marks, and unknown profiles", () => {
  const { database, repository } = fixture();
  const current = repository.get(); delete current.updatedAt;
  assert.equal(validateRenditionPolicy(current).cleanupBatchSize, 50);
  assert.throws(() => validateRenditionPolicy({ ...current, storageRoot: "/tmp" }), { code: "invalid_rendition_policy" });
  assert.throws(() => validateRenditionPolicy({ ...current, lowWaterPercent: 95 }), { code: "invalid_rendition_policy" });
  assert.throws(() => validateRenditionPolicy({ ...current, allowedProfileIds: ["4k"] }), { code: "invalid_rendition_policy" });
  database.close();
});

test("cleanup is deduplicated and evicts only store-provided cache candidates", async () => {
  const { database, repository } = fixture();
  const removed = [];
  repository.set({ ...repository.get(), quotaBytes: 1_048_576, minimumFreeBytes: 0 });
  const store = {
    root: "/safe/renditions", usage: () => ({ groups: [{ bytes: 2_000_000, count: 2, retention: "cache", state: "ready" }, { bytes: 9_000_000, count: 1, retention: "pinned", state: "ready" }], totalBytes: 11_000_000, totalReadyBytes: 11_000_000 }),
    listEvictionCandidates: () => [{ id: "cache-old", sizeBytes: 900_000 }, { id: "cache-new", sizeBytes: 900_000 }],
    remove: async (id) => { removed.push(id); }, reconcileFilesystem: async () => ({ missing: 0, orphans: 0 }), pruneRecords: () => ({ failed: 0, stale: 0 })
  };
  const jobs = { enqueue: (request) => ({ created: true, job: request }) };
  const service = createRenditionPolicyService({ jobs, repository, store, stat: async () => ({ bavail: 100, blocks: 200, bsize: 4096 }) });
  assert.equal(service.enqueueCleanup("manual").job.dedupeKey, "cleanup:renditions");
  await service.cleanup({ scope: "renditions", reason: "quota-pressure" }, { throwIfCancelled() {} });
  assert.deepEqual(removed, ["cache-old", "cache-new"]);
  assert.equal(removed.includes("pinned"), false);
  assert.equal((await service.status()).operations.evictions.pressure, 2);
  database.close();
});

test("cleanup scheduler rereads the policy interval after every run", () => {
  const delays = [];
  const callbacks = [];
  let cleanupIntervalMinutes = 5;
  const scheduler = createRenditionCleanupScheduler({
    enqueue: () => {},
    getPolicy: () => ({ cleanupIntervalMinutes }),
    setTimer(callback, delay) { callbacks.push(callback); delays.push(delay); return { unref() {} }; },
    clearTimer() {}
  });
  scheduler.start();
  assert.deepEqual(delays, [300_000]);
  cleanupIntervalMinutes = 15;
  callbacks.shift()();
  assert.deepEqual(delays, [300_000, 900_000]);
  scheduler.stop();
});
