# Wave 4 Backup And Restore Handoff

Wave 4 adds an isolated backup domain under `server/backup/`. It provides a
versioned, integrity-checked export of Nebula's shared SQLite database and any
catalog artwork cache files referenced by `media_artwork.local_path`. It never
copies `content/`, upload partials, delivery caches, or arbitrary host paths.

## Service boundary

Compose `createBackupService` with the already-open shared database plus
absolute, injected `databasePath`, `dataRoot`, and `backupRoot` values. The
service exposes:

- `create({ backupId?, signal? })` — uses Node SQLite's online backup API so WAL
  state is captured consistently while the server is running.
- `inspect({ backupId, signal? })` — validates the manifest, every SHA-256 and
  size, SQLite `integrity_check`, foreign keys, required account/catalog/
  playback/jobs/probe tables, and referenced metadata cache coverage.
- `restore({ backupId, destinationDatabasePath, destinationDataRoot?,
  restoreMetadataCache?, signal? })` — validates first, then writes to new
  destinations with atomic no-clobber file publication. Any partial outputs are
  removed on error or cancellation.

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
```

The manifest identifies `nebula-backup` format version 1, creation time,
applied domain migrations, file roles, sizes, SHA-256 hashes, and the explicit
`includesContentMedia: false` guarantee. It contains no passwords, tokens, or
secret values. The database necessarily contains account credentials and
server settings, so backup storage must be protected like the live data volume.
Errors never include database rows, credentials, host paths, or SQLite error
details in user-facing messages.

Cached files are accepted only when their canonical real path remains under the
injected data root and they are regular files. Bundle-relative paths are checked
against traversal. Missing or unsafe references fail the backup rather than
silently producing an incomplete export.

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

## Verification

Focused coverage lives in `tests/server-backup.test.mjs` and proves online WAL
capture, account/watchlist/catalog/playback/jobs/probe retention, migration
metadata, cache inclusion and restore, tamper rejection, no-clobber behavior,
and cancellation cleanup.

Run only through Docker Compose:

```sh
docker compose run --rm dashboard node --test tests/server-backup.test.mjs
docker compose run --rm dashboard npm run check
docker compose run --rm dashboard npm test
test ! -d node_modules && test ! -d dist && echo "host clean"
```
