# Wave 1 Durable Catalog Handoff

## Exports

`server/catalog/index.mjs` exports the catalog integration surface:

- `catalogMigration`, `applyCatalogMigration`, and `CATALOG_SCHEMA_VERSION`.
- `createCatalogRepository(database, options)` for an injected
  `DatabaseSync`-compatible connection.
- `bootstrapSharedContentRoot`, `discoverLocalMedia`, and `scanLocalRoot`.
- `importLegacyCinemaMetadata`.
- `projectCompatibilityEntry` and `projectRepositoryItems`.

Production catalog code does not open a database, set `PRAGMA user_version`, or
own the shared database lifecycle. `catalogMigration` is version 1 and applies
idempotent DDL only.

## Schema

Catalog schema version 1 creates:

- `media_libraries`
- `media_library_roots`
- `media_items`
- `media_sources`
- `media_external_ids`
- `media_artwork`
- `media_scan_runs`

IDs are server-generated UUIDs. Source paths are mutable and scoped to a root.
An active-path partial unique index allows same-path replacements to retain a
superseded source history while exposing only the replacement. External IDs are
provider-neutral, descriptive metadata is JSON on items, and manual locks are
stored separately in `locked_fields_json`.

## Integration Requests

The main integration agent should make these shared-file changes:

1. Centrally invoke `catalogMigration.apply(database)` from the shared migration
   lifecycle without allowing it to set `PRAGMA user_version`. The shared
   connection should have foreign-key enforcement enabled.
2. Construct `createCatalogRepository(database)` from that same injected
   connection and keep connection ownership outside the catalog module.
3. On startup, call `bootstrapSharedContentRoot(repository, {
   contentRoot: storage.contentRoot })`. The `shared-content` root key reuses its
   existing root and library UUIDs on later startups.
4. Schedule `scanLocalRoot` asynchronously rather than making Cinema or Studio
   reads wait on scanning. No scan path calls TMDB, FFprobe, or artwork
   downloads.
5. Run `importLegacyCinemaMetadata` after the first successful shared-root scan.
   A central migration marker may prevent unnecessary rereads. Repeated imports
   are safe and do not duplicate external IDs or artwork. Legacy `watchlisted`
   is intentionally excluded because it is per-user state.
6. Replace direct Cinema/Studio scan results with
   `projectRepositoryItems(repository, { availability: "available",
   mediaKind: "video" | "audio" })`, then retain the existing account-store
   media-ticket and watchlist decoration at the route boundary.
7. Add catalog routes and authorization in central routing. Catalog reads need
   `media.read`; scans and shared metadata mutations need `media.manage`.
8. Provider apply routes should call `repository.putExternalMetadata` with
   `mode: "provider"`. Manual edits should pass `mode: "manual"` and the edited
   field names in `lockedFields`.

No frozen shared files were changed by this branch.

## Reconciliation Semantics

- Duplicate scans are idempotent.
- Size or modification-time changes preserve source/item identity and increment
  `content_revision`.
- Local renames preserve identity only when the filesystem device/inode key
  proves continuity.
- A same-path file with a different device/inode key supersedes the prior
  source and receives new source/item UUIDs.
- Incremental scan omissions do not alter availability.
- Full scan omissions become `missing`; no source is physically deleted.
- Missing sources become cleanup-eligible only after both the configured scan
  count and grace duration. Restoration clears cleanup eligibility.
- Discovery failures persist a failed scan run and root error state.

## Deferred Boundaries

- Physical deletion of cleanup-eligible rows is not implemented. Wave 1 only
  exposes `listCleanupCandidates()` so later job orchestration can own cleanup.
- `putProbeResult` exists for the frozen repository shape but rejects calls until
  the Wave 2 stream/probe schema is centrally approved.
- A filesystem without stable device/inode values cannot safely preserve rename
  identity; those files are reconciled by path.
- Wave 1 creates one logical item per newly discovered source. The schema allows
  multiple sources per item, but automatic edition/duplicate grouping is a later
  catalog policy.
- Incremental local scans currently rediscover the root but do not mark omitted
  paths missing. Event-fed or path-scoped discovery can be added without changing
  repository reconciliation semantics.
