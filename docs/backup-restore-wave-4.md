# Wave 4 Backup And Restore Handoff

Wave 4 adds an isolated backup domain under `server/backup/`. It provides a
versioned, integrity-checked export of Nebula's shared SQLite database, catalog
artwork cache files referenced by `media_artwork.local_path`, and attachment
blobs referenced by `party_attachments.storage_key`. It never copies `content/`,
upload partials, delivery caches, or arbitrary host paths.

## Service boundary

Compose `createBackupService` with the already-open shared database plus
absolute, injected `databasePath`, `dataRoot`, and `backupRoot` values. The
service exposes:

- `create({ backupId?, signal? })` — uses Node SQLite's online backup API so WAL
  state is captured consistently while the server is running.
- `startCreate({ backupId? })`, `getOperation({ operationId })`,
  `waitOperation({ operationId })`, and `cancelOperation({ operationId })` —
  run the same safe creation path outside the request lifetime. Operation
  records are atomically persisted beneath `.operations/`; progress reports the
  snapshot, collection, copy, and finalization phases. A process restart marks
  an orphaned queued/running record `interrupted` rather than pretending that
  the bundle completed.
- `inspect({ backupId, signal? })` — validates the manifest, every SHA-256 and
  size, SQLite `integrity_check`, foreign keys, required account/catalog/
  playback/jobs/probe tables, and referenced metadata cache coverage.
- `restore({ backupId, destinationDatabasePath, destinationDataRoot?,
  restoreMetadataCache?, signal? })` — validates first, then writes to new
  destinations with atomic no-clobber file publication. Any partial outputs are
  removed on error or cancellation.
- `setPinned({ backupId, pinned })` and `prune({ maxBackups })` — persist
  operator retention intent and remove only the oldest valid, unpinned bundles.
  Invalid bundles are retained for diagnosis, and pruning always protects both
  every pinned backup and the latest good backup.

`retentionMaxBackups` is an optional non-negative service setting. Zero (the
default) disables automatic deletion. A positive value prunes after a
successful creation. Pinned backups can cause the total to remain above the
configured target; this is intentional and must be surfaced in disk alerts.

The restore target must not be the open production database. Normal integration
should restore into a staging data root while the server is stopped, inspect it,
and then let an operator deliberately switch data roots. This prevents an open
SQLite connection from retaining stale WAL state and keeps rollback simple.

## Bundle format

Each backup is a directory under the injected backup root:

```text
<backup-id>/
  manifest.json
  database/nebula.sqlite
  metadata-cache/<catalog-referenced relative paths>
  party-attachments/<server-generated sharded storage keys>
```

The manifest identifies `nebula-backup` format version 1, creation time,
applied domain migrations, file roles, sizes, SHA-256 hashes, and the explicit
`includesContentMedia: false` guarantee. It contains no passwords, tokens, or
secret values. The database necessarily contains account credentials and
server settings, so backup storage must be protected like the live data volume.
Errors never include database rows, credentials, host paths, or SQLite error
details in user-facing messages.

Cached files and Party attachments are accepted only when their canonical real
path remains under the injected data root and they are regular files.
Bundle-relative paths and Party's generated storage-key grammar are checked
against traversal. Missing, extra, unsafe, or checksum-mismatched Party
attachments fail inspection rather than silently producing an incomplete
private-message export.

## Authorization and routing integration requests

No shared API, development startup, account, or authorization files were
changed. The integration owner should:

1. Construct one backup service from the existing database and storage roots.
2. Add owner-only routes for create, list/inspect, and restore staging under the
   existing `server.admin` capability. Members and unauthenticated principals
   without that capability must receive `403`.
3. Accept opaque backup IDs only; never accept client-provided filesystem paths.
   Server configuration must choose backup and restore staging roots.
4. Keep restore as a maintenance/offline workflow. Stop job and delivery
   workers, close SQLite, stage and inspect the restored root, then switch it in
   an operator-controlled restart.
5. Add audit events without logging manifest database references, credentials,
   authorization headers, raw SQLite failures, or user records.

The owner/service-admin API supports:

- `POST /api/admin/backups/operations` to accept background creation and return
  `202` with an operation id;
- `GET /api/admin/backups/operations/:operationId` for bounded status/progress;
- `DELETE /api/admin/backups/operations/:operationId` for best-effort
  cancellation;
- `PATCH /api/admin/backups/:backupId` with `{ "pinned": true|false }`.

The synchronous `POST /api/admin/backups` remains available for compatibility
with existing operator scripts. New interactive clients should use the
operation API so reverse-proxy request deadlines cannot make a healthy
long-running backup appear to fail. Both route families remain under the
existing `server.admin` authorization prefix.

Runtime integration should parse a bounded integer such as
`NEBULA_BACKUP_RETENTION_MAX` and pass it as `retentionMaxBackups`. Leave it
unset/zero until the operator explicitly chooses a policy. The backup mount
must have enough headroom for one complete staging bundle in addition to all
pinned bundles.

## Verification

Focused coverage lives in `tests/server-backup.test.mjs` and proves online WAL
capture, account/watchlist/catalog/playback/jobs/probe/Party retention,
migration metadata, cache and referenced Party attachment inclusion/restore,
tamper or omission rejection, no-clobber behavior, background progress and
cancellation cleanup, durable operation lookup, and retention protection for
pinned/latest-good/invalid bundles.

Party history is retained indefinitely by default; an explicitly configured
Party retention policy affects the live database, not already-created backup
bundles. Party attachments are included even though shared `content/` media is
not. Treat backups as private message archives. A staged recovery acceptance
pass must open Party as two restored members and download a referenced
attachment before promotion.

Run only through Docker Compose:

```sh
docker compose run --rm dashboard node --test tests/server-backup.test.mjs
docker compose run --rm dashboard npm run check
docker compose run --rm dashboard npm test
test ! -d node_modules && test ! -d dist && echo "host clean"
```
