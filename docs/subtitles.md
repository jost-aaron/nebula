# Subtitles

Nebula's provider-neutral subtitle domain discovers `.vtt` and `.srt` sidecars adjacent to a catalog source, plus embedded streams persisted by probing. Public records use stable opaque IDs and never contain filesystem paths.

Conservative names are `<media-base>[.<language>][.forced][.default].vtt|srt`. Unknown markers, symlinks, escapes, and files over 10 MiB are ignored. Delivery revalidates catalog/library authorization and content, then returns a private `nosniff` response.

Accounts persist an ordered language list and mode (`off`, `forced-only`, or `preferred`) in SQLite, so normal database backup/restore includes them. Guests can select a track for their in-memory session but cannot persist defaults.

API contracts:

- `GET|PUT /api/subtitles/preferences`
- `GET|PUT /api/subtitles/items/:itemId/sources/:sourceId`
- `GET|HEAD /api/subtitles/items/:itemId/sources/:sourceId/tracks/:trackId`
- `GET|PUT /api/subtitles/provider-status`

No acquisition provider is shipped or enabled. Enablement is rejected until an explicitly allowlisted implementation supplies bounded timeouts, download limits, and validated content. Arbitrary paths, URLs, uploads, credentials, and network acquisition are intentionally unavailable.

Planning deterministically selects an explicit session choice or account default. Compatible text sidecars remain separate; incompatible selected formats require HLS software transcode and are labeled burn-in. Subtitle errors never block video fallback.
