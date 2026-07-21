import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createJobsRepository, createJobsService, createJobsWorker, createMediaJobHandlers,
  JOBS_SCHEMA_SQL, jobsMigration, migrateJobsSchema
} from "../server/jobs/index.mjs";

const fixture = ({ now = () => Date.now() } = {}) => {
  const db = new DatabaseSync(":memory:");
  migrateJobsSchema(db);
  return { db, repository: createJobsRepository({ db, now }), service: createJobsService({ repository: createJobsRepository({ db, now }) }) };
};

test("jobs migration is injectable, idempotent, and does not own PRAGMA versioning", () => {
  assert.equal(jobsMigration.id, "jobs-v1");
  assert.doesNotMatch(JOBS_SCHEMA_SQL, /PRAGMA|user_version/i);
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA user_version = 91");
  assert.throws(() => createJobsRepository({ db }).list(), /no such table/);
  jobsMigration.apply(db);
  jobsMigration.apply(db);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 91);
  db.close();
});

test("manual service validates types and exposes enqueue, query, list, and cancellation", (t) => {
  const { db, service } = fixture();
  t.after(() => db.close());
  assert.throws(() => service.enqueue({ type: "transcode" }), { status: 400 });
  const first = service.enqueue({ type: "scan", payload: { libraryId: "library-a" }, dedupeKey: "library-a" });
  const duplicate = service.enqueue({ type: "scan", payload: { libraryId: "ignored" }, dedupeKey: "library-a" });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.id, first.job.id);
  assert.equal(service.get(first.job.id).payload.libraryId, "library-a");
  assert.equal(service.list({ state: "queued" }).length, 1);
  assert.equal(service.cancel(first.job.id).state, "cancelled");
  assert.equal(service.cancel(first.job.id).state, "cancelled");
});

test("manual service preserves delayed availability for load-scheduled jobs", (t) => {
  const { db, service } = fixture({ now: () => Date.parse("2026-07-20T00:00:00.000Z") });
  t.after(() => db.close());
  const availableAt = Date.parse("2026-07-20T00:05:00.000Z");
  const result = service.enqueue({ availableAt, payload: { sourceId: "source-a" }, type: "probe" });
  assert.equal(result.job.availableAt, "2026-07-20T00:05:00.000Z");
});

test("deduplicated queued work can be expedited without creating another job", (t) => {
  const clock = Date.parse("2026-07-20T12:00:00.000Z");
  const { db, repository } = fixture({ now: () => clock });
  t.after(() => db.close());
  const first = repository.enqueue({ type: "scan", dedupeKey: "library", availableAt: clock + 60_000 });
  const expedited = repository.enqueue({ type: "scan", dedupeKey: "library", availableAt: clock - 60_000 });
  assert.equal(expedited.created, false);
  assert.equal(expedited.job.id, first.job.id);
  assert.equal(expedited.job.availableAt, "2026-07-20T11:59:00.000Z");
  assert.equal(repository.claimNext().id, first.job.id);
});

test("worker persists progress and successful results", async (t) => {
  const { db, repository } = fixture();
  t.after(() => db.close());
  const { job } = repository.enqueue({ type: "probe", payload: { sourceId: "source-a" } });
  const worker = createJobsWorker({ repository, handlers: {
    probe: async (claimed, context) => {
      context.reportProgress(0.4, "reading-streams");
      assert.equal(repository.get(claimed.id).currentStage, "reading-streams");
      return { streams: 2 };
    }
  }});
  assert.equal(await worker.runOnce(), 1);
  assert.deepEqual(repository.get(job.id), {
    ...repository.get(job.id), state: "succeeded", progress: 1, currentStage: "completed", result: { streams: 2 }
  });
});

test("worker bounds concurrency and leaves additional work queued", async (t) => {
  const { db, repository } = fixture();
  t.after(() => db.close());
  for (let index = 0; index < 4; index += 1) repository.enqueue({ type: "cleanup", payload: { index } });
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = createJobsWorker({ concurrency: 2, repository, handlers: { cleanup: async () => {
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
  } } });
  const running = worker.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(repository.list({ state: "running" }).length, 2);
  assert.equal(repository.list({ state: "queued" }).length, 2);
  release();
  await running;
  assert.equal(peak, 2);
});

test("worker lifecycle snapshots expose only running state, heartbeat, and aggregate activity", async (t) => {
  let clock = 1_000;
  const { db, repository } = fixture({ now: () => clock });
  t.after(() => db.close());
  repository.enqueue({ type: "cleanup", payload: { batch: 1 } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = createJobsWorker({
    now: () => clock,
    repository,
    handlers: {
      cleanup: async () => {
        clock += 5;
        await gate;
      }
    }
  });

  assert.deepEqual(worker.snapshot(), { active: 0, heartbeatAt: 1_000, running: false });
  worker.start({ pollIntervalMs: 10 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.snapshot().running, true);
  assert.equal(worker.snapshot().active, 1);
  assert.ok(worker.snapshot().heartbeatAt >= 1_005);
  release();
  await worker.stop();
  assert.equal(worker.snapshot().running, false);
  assert.equal(worker.snapshot().active, 0);
});

test("retry policy requeues with delay and records terminal failure", async (t) => {
  let clock = Date.parse("2026-07-11T00:00:00.000Z");
  const { db, repository } = fixture({ now: () => clock });
  t.after(() => db.close());
  const { job } = repository.enqueue({ type: "metadata", maxAttempts: 2 });
  const worker = createJobsWorker({ repository, now: () => clock, retryDelay: () => 500, handlers: {
    metadata: async () => { throw Object.assign(new Error("provider unavailable"), { code: "UPSTREAM" }); }
  }});
  await worker.runOnce();
  assert.equal(repository.get(job.id).state, "queued");
  assert.equal(repository.get(job.id).attempt, 1);
  assert.equal(await worker.runOnce(), 0);
  clock += 500;
  await worker.runOnce();
  const failed = repository.get(job.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.attempt, 2);
  assert.deepEqual(failed.error, { code: "UPSTREAM", message: "provider unavailable" });
});

test("running cancellation is cooperative and terminal", async (t) => {
  const { db, repository } = fixture();
  t.after(() => db.close());
  const { job } = repository.enqueue({ type: "artwork" });
  const worker = createJobsWorker({ repository, handlers: { artwork: async (claimed, context) => {
    repository.requestCancellation(claimed.id);
    context.throwIfCancelled();
  } } });
  await worker.runOnce();
  assert.equal(repository.get(job.id).state, "cancelled");
});

test("startup recovery requeues interrupted attempts, fails exhausted jobs, and preserves cancellation", (t) => {
  const { db, repository } = fixture();
  t.after(() => db.close());
  const retry = repository.enqueue({ type: "probe", maxAttempts: 2 }).job;
  const exhausted = repository.enqueue({ type: "metadata", maxAttempts: 1 }).job;
  const cancelled = repository.enqueue({ type: "artwork" }).job;
  assert.equal(repository.claimNext().id, retry.id);
  assert.equal(repository.claimNext().id, exhausted.id);
  assert.equal(repository.claimNext().id, cancelled.id);
  repository.requestCancellation(cancelled.id);
  assert.deepEqual(repository.recoverInterrupted(), { cancelled: 1, failed: 1, requeued: 1 });
  assert.equal(repository.get(retry.id).state, "queued");
  assert.equal(repository.get(exhausted.id).state, "failed");
  assert.equal(repository.get(cancelled.id).state, "cancelled");
});

test("jobs with identical timestamps are claimed in enqueue order", (t) => {
  const { db, repository } = fixture({ now: () => Date.parse("2026-07-11T00:00:00.000Z") });
  t.after(() => db.close());
  const first = repository.enqueue({ type: "probe" }).job;
  const second = repository.enqueue({ type: "probe" }).job;
  assert.equal(repository.claimNext().id, first.id);
  assert.equal(repository.claimNext().id, second.id);
});

test("media orchestration contracts inject domain operations and can fan out idempotently", async (t) => {
  const { db, repository } = fixture();
  t.after(() => db.close());
  const calls = [];
  const operations = {
    scanLibrary: async (payload, context) => {
      calls.push(["scan", payload.libraryId]);
      context.enqueue({ type: "probe", payload: { sourceId: "source-a" }, dedupeKey: "source-a", maxAttempts: 3 });
      context.enqueue({ type: "probe", payload: { sourceId: "source-a" }, dedupeKey: "source-a", maxAttempts: 3 });
    },
    probeSource: async (payload) => calls.push(["probe", payload.sourceId]),
    fingerprintSource: async () => {},
    refreshMetadata: async () => {},
    cacheArtwork: async () => {},
    buildRendition: async () => {},
    cleanup: async () => {}
  };
  const handlers = createMediaJobHandlers(operations);
  repository.enqueue({ type: "scan", payload: { libraryId: "library-a" } });
  const worker = createJobsWorker({ repository, handlers });
  await worker.runOnce();
  assert.equal(repository.list({ type: "probe" }).length, 1);
  await worker.runOnce();
  assert.deepEqual(calls, [["scan", "library-a"], ["probe", "source-a"]]);
  assert.throws(() => createMediaJobHandlers({}), /scanLibrary/);
});
