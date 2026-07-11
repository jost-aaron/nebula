# Wave 2 Media Probe

`server/probe/` provides bounded FFprobe execution, normalization, content-root
path enforcement, concurrency control, and an injected catalog write boundary.
It never opens the production database and never changes `PRAGMA user_version`.

## Composition

The integration owner should centrally apply `probeMigration` after the catalog
migration, construct `createProbeCatalogWriter(database)`, and inject it as
`catalogWriter` into `createProbeService`. `resolveSource(sourceId)` must return
the catalog source shape (`path` and `availability`). Probe work should be queued
after catalog reconciliation rather than awaited by scans.

The migration descriptor creates `media_probe_results`, `media_streams`, and
`media_chapters`. Re-probing atomically replaces a source's stream and chapter
rows. The adapter validates the source foreign key and writes no descriptive or
per-user metadata.

## Safety And Failure Contract

- FFprobe receives a fixed argument array with `shell: false`; the media path is
  passed after `--`.
- Paths must be relative to the configured content root. Canonical real paths
  reject traversal and symlink escapes.
- Default limits are 15 seconds, 4 MiB combined output, and two concurrent
  probes. Callers may lower these limits through `runnerOptions`.
- Failures use codes: `missing`, `partial_or_corrupt`, `unsupported`,
  `ffprobe_unavailable`, `timeout`, `output_limit`, `invalid_output`, and
  `probe_failed`. Partial/corrupt and timeout failures are retryable.
- Failed probes are not persisted as successful technical metadata. Job-level
  status, retries, and failure persistence belong to the background-jobs track.

## Integration Requests

1. Register `probeMigration` in the central domain migration list after catalog.
2. Compose the writer/service in server startup and enqueue probes for new or
   changed catalog sources.
3. Decide whether the catalog repository's placeholder `putProbeResult` should
   delegate to this adapter or be removed in favor of direct writer injection.
