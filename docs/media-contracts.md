# Media Platform Contracts

This document freezes the Wave 0 boundaries for Nebula's catalog and playback
work. It defines contracts only; it does not introduce catalog tables, scanning,
playback persistence, probing, jobs, or new routes.

## Canonical Identity

- Public library, item, source, stream, chapter, artwork, job, and playback
  session IDs are server-generated UUID strings and are opaque to clients.
- `MediaItem.id` is the canonical logical identity. A path is never an item ID.
- `MediaSource.id` identifies a concrete file. Its content-relative path is a
  mutable, server-controlled source attribute.
- Renames preserve source and item identity only when reconciliation can safely
  establish continuity. A same-path replacement may become a new source.
- Missing sources first become `missing`; they are not immediately deleted.
- Provider IDs live in external-ID mappings keyed by provider and never become
  primary media IDs.

## Metadata Boundaries

- Descriptive metadata and technical stream metadata remain separate.
- Provider refreshes write through the Catalog service, not directly to SQLite.
- Manual overrides record locked fields. Provider refreshes must preserve them.
- Items may be browsable while probing, matching, or artwork work is pending.
- `.cinema-metadata.json` remains a compatibility input until imported into the
  catalog. New catalog code must not make it the source of truth.
- The merged TMDB implementation is an adapter candidate. Its provider client
  remains reusable, while persistence moves behind `CatalogService.applyMetadata`.

## Compatibility Rules

Existing APIs remain functional during migration:

- `GET /api/cinema/library`
- `GET /api/music/library`
- path-based Cinema and Studio media URLs and media tickets
- `PATCH /api/cinema/metadata`
- `PATCH /api/cinema/watchlist`

Catalog identity fields are additive during rollout. Current entries may gain
`id`, `sourceId`, and `availability`; existing fields must not be removed or
change meaning until all clients use catalog-backed APIs. Compatibility adapters
resolve legacy paths to source IDs at the server boundary. New domain APIs use
stable IDs and must not accept arbitrary filesystem paths.

Playback state is per-user and keyed by item ID, with an optional selected
source ID. It must not be stored on shared media rows. During migration, a
server-only compatibility resolver may translate a validated content path to an
item ID before recording playback.

## Backend Composition

`server/mediaContracts.mjs` defines the structural repository boundaries.
Implementations are injected into route and service factories. Metadata,
playback, probe, and job modules must not import another domain's SQLite handle
or write its tables directly.

The first Catalog implementation owns:

- libraries, roots, items, sources, external IDs, artwork references, and scan
  state;
- the catalog repository and legacy metadata import;
- source reconciliation and path compatibility projection.

The first Playback implementation owns:

- per-user playback state and sessions;
- event validation and throttling;
- Continue Watching queries and user-isolation tests.

## Shared Ownership

While Wave 1 is active, only the main integration agent owns:

- `server/api.mjs` and `server/dev.mjs`;
- database migration registration and database lifecycle composition;
- `src/shared/catalogTypes.ts` and `src/shared/playbackTypes.ts`;
- compatibility response changes in `server/cinema.mjs` and `server/music.mjs`;
- cross-domain integration tests and final documentation.

Catalog and Playback agents should report required shared-file changes in their
handoffs rather than editing those files. Domain implementations belong under
`server/catalog/` and `server/playback/`, with focused tests.

## Frozen API Direction

The first implementation may refine route names during main-agent integration,
but its service contracts must support:

```text
GET  /api/catalog/items
GET  /api/catalog/items/:id
POST /api/catalog/libraries/:id/scan

POST /api/playback/events
GET  /api/playback/continue-watching
```

Mutations require existing account authorization and CSRF behavior. Catalog
reads require `media.read`; scans and shared metadata changes require
`media.manage`; playback state is always scoped to the authenticated user.

## Exit Criteria

Wave 0 is complete when these contracts are merged into `main`, all existing
tests pass, and Catalog and Playback worktrees branch from that commit. Any
contract change after that point requires main-agent review before a worker
depends on it.

## Cluster Federation Addendum

The sharding protocol extends these boundaries without changing local Catalog
identity. Shard-local item/source UUIDs remain opaque local identifiers. A
coordinator-owned federated projection groups logical works, editions, sources,
and exact replicas while retaining their contributing node and local IDs.

`src/shared/clusterTypes.ts` defines the versioned transport shapes.
`server/cluster/protocol.mjs` is the fail-closed runtime validation boundary.
Cluster implementations must read `docs/media-sharding-implementation-plan.md`
and `docs/media-sharding-threat-model.md` before changing those contracts.

Only the integration owner may change cluster shared types, protocol versions,
central migration composition, `server/api.mjs`, or `server/dev.mjs` after
parallel implementation begins.
