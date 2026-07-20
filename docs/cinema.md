# Cinema

When clustering is enabled on a coordinator, owner and service library requests
are projected through the federated catalog. Duplicate sources render as one
title with a shard-count badge and an `Available on` list. A local source keeps
the existing playback and metadata workflow. An owner can play a remote-only
title when an online shard advertises compatible direct play: the coordinator
schedules one source, activates a short-lived signed grant, and the browser
streams the original file directly from that shard. Remote metadata, watchlist,
playlist, watched-state, optimization, and TMDB mutations remain disabled.
Member and guest libraries remain local-only.

Remote Cinema delivery currently supports only original/direct playback. A
remote request that requires remux, HLS/live transcode, a prebuilt rendition,
subtitles, or fixed-quality conversion fails closed rather than falling back to
an unauthorized or incompatible path. Local Cinema retains all existing direct,
remux, HLS, rendition, subtitle, quality, and playback-state behavior.

Cinema is the local video browser and web player prototype.

## Content Source

Cinema scans the ignored `content/` folder for video files. Current supported
video extensions:

- `.mp4`
- `.m4v`
- `.mov`
- `.webm`

Audio files do not appear in Cinema. MP3, FLAC, M4A, WAV, AAC, OGG, and future
audio library behavior belong to Studio.

Files can be added with the Files app. Large files should use the resumable
upload path already built into Files.

## Frontend

The Cinema UI lives in:

```text
src/cinema/renderCinemaView.ts
```

Cinema uses the production Five-Blade Play identity under
`src/assets/branding/cinema/`. The canonical SVG family includes transparent
and dark-background symbols, a horizontal lockup, a square app icon, and a
monochrome mark; matching PNG exports are provided for distribution surfaces.
The aperture uses four warm bone-white blades, one amber-gold blade, a central
play symbol, and a four-point star. The UI extends that near-black, ivory, and
amber visual system so Cinema and Studio feel like members of the same media
family without sharing audio-specific imagery.

It renders:

- An explicit Dashboard/close command in the Cinema header.
- Plex-like category tabs for Movies and TV Shows.
- A searchable local video grid.
- A persistent per-account watchlist for saved video titles.
- A dedicated title details submenu after selecting a title.
- Lazy video playback through a native `<video>` engine with Nebula Cinema's
  custom play/pause, 10-second skip, seek, volume, mute, subtitle, quality, and fullscreen
  controls. Fullscreen includes the custom transport rather than falling back
  to browser-native chrome, and the fullscreen command toggles back to the
  normal Cinema surface from the same control.
- The transport exposes Back 10 and Forward 10 controls. Left Arrow and Right
  Arrow trigger the same skips while the player is active, except when a form
  field or slider owns keyboard focus.
- The transport sits flush with the video edge, shows played and buffered
  progress separately, and keeps subtitle and quality selectors in compact
  on-demand popovers. While video is playing, it fades after 2.5 seconds of
  inactivity and returns on pointer, touch, or keyboard interaction. It remains
  visible while paused, while a popover is open, or while a control has keyboard
  focus.
- A metadata editor for imported video items.
- Browser-generated preview thumbnails.
- A prototype visual identification workflow for selected videos.
- Stable catalog item/source identities when available, with path-based local
  library and streaming behavior retained as a compatibility fallback.
- Per-account Continue Watching, resume prompts, progress bars, watched state
  controls, and throttled playback lifecycle reporting.
- Owner-only remote original playback through account-bound cluster playback
  sessions. Scheduler responses identify the selected shard and explain the
  direct-play choice without returning local shard IDs or filesystem paths.
- On a remote media error, Cinema asks the coordinator for another source with
  the same strong exact-replica key, reopens the replacement grant URL, and
  seeks to the browser's last position. Alternate encodes are never treated as
  seamless replicas. This browser failover is best effort and still requires
  real-tailnet resume-tolerance verification.
- Embedded chapters when the catalog item response includes probed chapter
  data; prototype chapter markers are no longer shown.
- Catalog scan status and explicit local metadata/artwork fallback states.

The Dashboard command uses the same close-app path as Escape, returning from the
Cinema surface to the main dashboard without changing library state.

Thumbnails are generated client-side by loading video metadata, seeking near the
start of the file, drawing the frame to a canvas, and using that canvas image as
the poster background. If a browser cannot decode or seek a file, the card keeps
its fallback poster.

## Visual Identification Prototype

The Identify button appears after selecting a local video. The browser samples
ten frames across the runtime, skips very dark frames, renders thumbnails in the
detail panel, and posts compact JPEG data URLs to:

- `POST /api/cinema/identify`

The server currently behaves as an orchestrator layer. It always returns
search-ready queries based on the file title and sampled timestamps. If
`GOOGLE_VISION_API_KEY` is available in the Docker Compose environment, the
endpoint also calls Google Vision Web Detection and returns candidate web
entities, visually similar images, and matching pages.

Category assignment is local and heuristic:

- Video files under `TV`, `Shows`, or `Series` folders, or files named like
  `S01E01` or `1x01`, go to TV Shows.
- Other video files go to Movies.

## Metadata Editing

### Optional TMDB metadata

An owner can add a TMDB API Read Access Token in Settings / Account, or a server
operator can set `TMDB_API_TOKEN` as a fallback, to enable server-side movie and
TV search. A selected title can be matched from explicit candidates
and refreshed later by its stored TMDB media type and ID. Missing configuration
does not affect scanning, playback, watchlists, or manual editing. The credential
is never embedded in browser bundles or returned by API responses. See
[`docs/tmdb-metadata-design.md`](tmdb-metadata-design.md) for the full design.

TV files named with `SxxExxx` or `NxN` coordinates retain season and episode
numbers during series search. Applying a confirmed series match imports the
specific episode title, air date, synopsis, rating, credits, still, and series
poster. Other TV files continue to use series-level metadata.

Shared editable media properties are stored in:

```text
content/.cinema-metadata.json
```

The file is keyed by content-relative media path. Cinema scans real video files
from disk first, then overlays editable fields from the metadata file. The
source file path, stream URL, size, modified time, and media kind remain derived
from disk.

Current editable fields:

- Title
- Sort title
- Release year
- Rating
- Genres
- Studio
- Collection
- Poster URL
- Tagline
- Cast
- Summary
- Watchlist state

The legacy `watchlisted` metadata field is imported once into the first owner's
SQLite watchlist. Account-aware responses then overlay personal state from the
account database; members start with an independent empty watchlist. The legacy
field remains readable for rollback compatibility.

The frontend updates these through:

- `PATCH /api/cinema/metadata`
- `PATCH /api/cinema/watchlist`

## Server Endpoints

- `GET /api/cinema/library` - recursively scan `content/` for supported videos.
- `GET /api/cinema/media?path=<path>` - stream a video file.
- `HEAD /api/cinema/media?path=<path>` - return video metadata headers.
- `POST /api/cinema/identify` - search sampled video frames for candidate titles.
- `PATCH /api/cinema/metadata` - save editable metadata for a video file.
- `PATCH /api/cinema/watchlist` - add or remove a video file from the watchlist.
- `GET /api/cinema/tmdb/status` - report provider availability without secrets.
- `POST /api/cinema/tmdb/search` - return movie or TV match candidates.
- `POST /api/cinema/tmdb/apply` - explicitly apply a selected candidate.
- `POST /api/cinema/tmdb/refresh` - explicitly refresh a stored TMDB match.
- `GET /api/catalog/items?mediaKind=video` - resolve stable Cinema identities.
- `GET /api/catalog/items/:id` - read available catalog enrichment/chapter data.
- `POST /api/catalog/scan` - request a catalog rescan and return scan counts.
- `POST /api/playback/events` - report start, progress, pause, stop, and complete.
- `GET /api/playback/continue-watching` - load the current account's resumable titles.
- `POST /api/playback/delivery-sessions` - plan and create compatible account-bound delivery.
- `POST /api/cluster/playback-sessions` - create an owner-bound scheduled local
  or remote cluster playback session for a federated item.
- `POST /api/cluster/playback-sessions/:id/failover` - replace a failed shard
  only with an online exact replica.
- `DELETE /api/cluster/playback-sessions/:id` - release scheduler capacity and
  close the account-bound cluster session.

The media endpoint supports HTTP byte ranges and returns `206 Partial Content`
for range requests. This is required for normal browser video playback behavior,
especially seeking. It supports one normal, open-ended, or suffix range per
request. Invalid, multi-range, empty-file range, and unsatisfiable requests
return `416` with `Content-Range: bytes */<size>`.

Authenticated library responses use expiring media tickets bound to the user,
video path, and media kind. Tickets authorize only GET/HEAD streaming and are
revoked with account sessions.

## Boundaries

Cinema requests a delivery session when stable IDs and same-origin account
authentication are available. It declares conservative browser-derived MP4,
H.264, AAC, and native-HLS support, polls remux/transcode preparation, and
cancels generated sessions when playback closes. Planning or delivery failure,
catalog outages, and configured bearer clients retain the ticketed path-based
media fallback. Thumbnail and identification sampling also remain on that
fallback. Music remains intentionally handled by Studio.

For incompatible sources, `auto` planning selects a fixed 240p, 360p, 480p, 720p, or 1080p
profile within the client and account playback-policy limits. Fresh HLS playback
can begin after its first atomic segment; resumed transcodes wait for a complete
playlist so seeking uses the original timeline correctly. The client includes
the requested resume position in delivery creation, and active HLS asset access
extends the account-bound session expiry for long-running movies.

The player header offers Auto, Original, and each server-advertised profile.
Changing quality creates a new account-bound delivery, preserves the current
position, and cancels the prior delivery only after the replacement is ready.
The result chip distinguishes a requested Auto mode from its actual Direct,
Remux, or profile outcome. Safari/iOS uses native HLS; Chromium-family browsers
use the local pinned hls.js dependency rather than a CDN script.
