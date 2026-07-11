# Wave 2 Persistent Background Jobs

Wave 2 adds a persistent, injected-DB jobs domain under `server/jobs/`. It does
not open a production database, change `PRAGMA user_version`, register itself in
the central migration list, or import Catalog, Probe, Metadata, or Artwork
SQLite handles.

## Composition

The integration owner must:

1. Add `jobsMigration` to the centrally ordered migrations passed to
   `applyDomainMigrations`.
2. Create `createJobsRepository({ db })` from the shared database after
   migrations run.
3. Supply all operations to `createMediaJobHandlers`: `scanLibrary`,
   `probeSource`, `refreshMetadata`, `cacheArtwork`, and `cleanup`.
4. Start one `createJobsWorker` after operation dependencies are ready and stop
   it during graceful shutdown.
5. Adapt authenticated, `media.manage`-authorized HTTP routes to the jobs
   service's `enqueue`, `get`, `list`, and `cancel` methods.

The service deliberately does not implement HTTP or authorization. Those are
composition concerns owned by the shared API layer.

## Lifecycle

Jobs move through `queued`, `running`, `succeeded`, `failed`, and `cancelled`.
Claims are serialized with `BEGIN IMMEDIATE`; worker concurrency is bounded.
Each failed claim increments the persisted attempt count, waits according to
the injected retry policy, and becomes terminal after `maxAttempts`.

Progress is a value from 0 to 1 with a current stage. Cancellation is immediate
for queued jobs and cooperative for running jobs through `throwIfCancelled`,
`isCancellationRequested`, and progress checkpoints. On startup, interrupted
running jobs are requeued when attempts remain, failed when exhausted, or
cancelled when cancellation was already requested.

An optional `(type, dedupeKey)` identity suppresses duplicate queued or running
work. Terminal jobs release that key, allowing a deliberate later refresh.

## Orchestration Boundary

Operations receive `(payload, context)`. The context exposes progress,
cancellation, and `enqueue`; it exposes no database. A scan can therefore
enqueue probe work, a probe can enqueue metadata work, and metadata can enqueue
artwork work without blocking the preceding stage or coupling persistence
domains. Cleanup uses the same boundary for future cache and database
maintenance hooks.
