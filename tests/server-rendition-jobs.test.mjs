import assert from "node:assert/strict";
import test from "node:test";
import { createRenditionService } from "../server/renditions/service.mjs";

const ids = {
  item: "10000000-0000-4000-8000-000000000001",
  source: "20000000-0000-4000-8000-000000000002",
  user: "30000000-0000-4000-8000-000000000003"
};

const fixture = ({ activeJobs = [], ready = false, revision = 4, suppliedRows = null } = {}) => {
  const enqueued = [];
  const cancelled = [];
  const source = { availability: "available", contentRevision: revision, id: ids.source, itemId: ids.item, mediaKind: "video" };
  const rows = suppliedRows ?? (ready ? [{ id: "40000000-0000-4000-8000-000000000004", itemId: ids.item, profileId: "480p", profileVersion: 1, sourceId: ids.source, sourceRevision: revision, state: "ready" }] : []);
  const service = createRenditionService({
    audit: null,
    catalog: {
      getItem: (id) => id === ids.item ? { id, mediaKind: "video" } : null,
      getSource: (id) => id === ids.source ? source : null,
      listItems: () => [{ id: ids.item, source }]
    },
    jobs: {
      cancel(id) { cancelled.push(id); }, list: () => activeJobs,
      enqueue(request) { enqueued.push(request); return { created: true, job: { id: "50000000-0000-4000-8000-000000000005", state: "queued", type: "rendition" } }; }
    },
    planner: { plan: async () => ({ decision: "transcode", itemId: ids.item, sourceId: ids.source, output: { profileId: "480p" } }) },
    probeReader: { get: () => ({ streams: [{ height: 1080, type: "video", width: 1920 }] }) },
    store: { get: () => null, listForItem: () => rows, remove: async () => true, setRetention: () => null },
    transcode: { createSession: async () => ({ completion: Promise.resolve(), cleanup: async () => {}, reused: false }) }
  });
  return { cancelled, enqueued, service };
};

test("title builds derive canonical payloads and reject caller worker controls", () => {
  const { enqueued, service } = fixture();
  assert.throws(() => service.enqueue(ids.item, {
    sourceId: ids.source, profileIds: ["480p"], retention: "pinned",
    path: "/private/movie.mp4", ffmpegArgs: ["-f", "null"], dedupeKey: "attacker", maxAttempts: 99
  }, { kind: "account", principalId: ids.user, user: { role: "owner" } }), { code: "invalid_rendition_request" });
  const result = service.enqueue(ids.item, {
    sourceId: ids.source, profileIds: ["480p"], retention: "pinned"
  }, { kind: "account", principalId: ids.user, user: { role: "owner" } });
  assert.equal(result.builds[0].created, true);
  assert.deepEqual(enqueued[0], {
    dedupeKey: `rendition:${ids.source}:r4:480p:v1`,
    payload: {
      itemId: ids.item, profileId: "480p", profileVersion: 1, requestedBy: ids.user,
      retention: "pinned", sourceId: ids.source, sourceRevision: 4
    },
    type: "rendition"
  });
  assert.doesNotMatch(JSON.stringify(enqueued), /private|ffmpeg|attacker|maxAttempts/);
});

test("ready renditions are reused without jobs and stale job revisions fail closed", async () => {
  const ready = fixture({ ready: true });
  assert.equal(ready.service.enqueue(ids.item, { sourceId: ids.source, profileIds: ["480p"] }, { kind: "service" }).builds[0].created, false);
  assert.equal(ready.enqueued.length, 0);
  const stale = fixture({ revision: 5 });
  await assert.rejects(() => stale.service.build({
    itemId: ids.item, profileId: "480p", profileVersion: 1, requestedBy: ids.user,
    retention: "cache", sourceId: ids.source, sourceRevision: 4
  }, { reportProgress() {}, throwIfCancelled() {}, isCancellationRequested: () => false }), { code: "STALE_RENDITION_JOB" });
});

test("title status ignores old revisions and queued builds can be cancelled before publication", async () => {
  const job = {
    createdAt: "2026-07-12T00:00:00.000Z", id: "50000000-0000-4000-8000-000000000005",
    payload: { itemId: ids.item, profileId: "480p", profileVersion: 1, retention: "cache", sourceId: ids.source, sourceRevision: 4 },
    state: "queued", updatedAt: "2026-07-12T00:00:00.000Z"
  };
  const old = { id: "40000000-0000-4000-8000-000000000004", itemId: ids.item, profileId: "720p", profileVersion: 1, sourceId: ids.source, sourceRevision: 3, state: "ready" };
  const current = fixture({ activeJobs: [job], suppliedRows: [old] });
  const listed = current.service.list(ids.item);
  assert.equal(listed.renditions.some((entry) => entry.id === old.id), false);
  assert.equal(listed.renditions.some((entry) => entry.id === job.id && entry.state === "pending"), true);
  await current.service.remove(ids.item, job.id);
  assert.deepEqual(current.cancelled, [job.id]);
});
