# Wave 1 Playback State

## Composition

Playback does not open or own a database. The integration layer applies the
exported `PLAYBACK_MIGRATION` from `server/playback/schema.mjs` to its injected
`DatabaseSync` connection, then constructs a repository with
`createPlaybackRepository({ db })` and injects that into
`createPlaybackService({ repository })`.

The migration deliberately has no `PRAGMA`, `user_version`, account foreign
key, or catalog foreign key statements. Central migration composition should
add lifecycle-compatible foreign keys if the final shared schema permits them.

## Event Semantics

- `eventId` is a client-generated UUID and the retry/idempotency key. Reusing it
  with an altered payload returns conflict.
- `start` creates a session. `progress` and `pause` keep it active or paused.
  `stop` and `complete` end it and later events are rejected.
- Progress state is coalesced until either 10 seconds pass or position changes
  by 10 seconds. Every event is still recorded. Start, pause, stop, and complete
  always update state and therefore cannot be hidden by throttling.
- Explicit completion requires duration and at least 90 percent progress. A
  stop at or above the same threshold also marks the item played.
- Completion clears resume position and increments play count only when moving
  from unplayed to played. Starting again makes the item unplayed while keeping
  its prior play count.
- Continue Watching includes only incomplete entries with a positive position
  and known duration, sorted newest-first and bounded to 1-100 rows.

## Authorization Boundary

The service accepts an authenticated principal and derives `userId` from it;
callers cannot submit a playback user ID. Service principals are rejected.
Session and state lookups filter ownership, and repository keys include the
user ID. Existing account authorization and CSRF checks remain route-layer
responsibilities during central integration.

## Compatibility

`createPlaybackCompatibilityResolver` is server-only. It requires path
validation before asking an injected Catalog adapter to return canonical
`itemId` and `sourceId` values. New callers should send stable IDs directly.
