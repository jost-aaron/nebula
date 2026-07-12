# Persistent Playlists And Collections

Nebula stores provider-neutral media lists in the shared SQLite database using
stable Catalog item UUIDs. No content path, filename, provider identifier, or
stream URL is stored in a list or returned by its API.

## Semantics

- Playlists belong to one account, are either video or audio, and are invisible
  to every other account. Owners do not implicitly read a member's playlists.
- Collections are shared, owner-managed groupings. They may be video, audio, or
  mixed. Members can read only collection items in libraries they can currently
  access.
- Membership is ordered and duplicate-free. Adding an existing item returns
  `409`. Reordering is atomic and must contain every current item exactly once.
- Names are trimmed and contain 1–80 Unicode characters.
- Missing media sources remain in their lists with `available: false`, allowing
  restoration to preserve membership and position. Catalog item deletion is
  restricted while a list references the item; remove the list membership
  before permanent catalog cleanup. Deleting a playlist or collection deletes
  only the grouping, never media or Catalog records.
- Library permissions are checked on every read and write. Inaccessible items
  are omitted without placeholders, counts, paths, or other existence clues.

## API

The same shape is exposed under `/api/playlists` and `/api/collections`:

- `GET /api/<type>?mediaKind=video|audio` lists visible groupings.
- `POST /api/<type>` creates a grouping from `name` and `mediaKind`.
- `GET|PATCH|DELETE /api/<type>/:id` reads, renames, or deletes it.
- `POST /api/<type>/:id/items` adds one stable `itemId`.
- `DELETE /api/<type>/:id/items/:itemId` removes one item and compacts order.
- `PUT /api/<type>/:id/items` atomically reorders with `itemIds`.

Collection mutations require owner/service-admin authorization. Playlist
mutations require the owning authenticated account. Cookie mutations continue
to require the shared CSRF header; bearer/native requests use their existing
session authorization.

The `media-lists-v1` composable domain migration creates `media_lists` and
`media_list_items`. Online backup captures both tables automatically because
they live in `nebula.sqlite`; no media content or path is added to the bundle.

Cinema and Studio load list summaries and offer a focused “Save to playlist”
command for stable-ID entries. Each app creates a personal default Favorites
playlist on first use. The controls collapse to full width at phone sizes and
inherit the existing safe-area layout.
