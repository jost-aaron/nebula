# Cinema

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

It renders:

- An explicit Dashboard/close command in the Cinema header.
- Plex-like category tabs for Movies and TV Shows.
- A searchable local video grid.
- A persistent watchlist for saved video titles.
- A dedicated title details submenu after selecting a title.
- Lazy video playback with the normal browser video player.
- A metadata editor for imported video items.
- Browser-generated preview thumbnails.
- A prototype visual identification workflow for selected videos.

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

Editable media properties are stored in:

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

The media endpoint supports HTTP byte ranges and returns `206 Partial Content`
for range requests. This is required for normal browser video playback behavior,
especially seeking. It supports one normal, open-ended, or suffix range per
request. Invalid, multi-range, empty-file range, and unsatisfiable requests
return `416` with `Content-Range: bytes */<size>`.

## Boundaries

Cinema is still a local video-library prototype. It does not scrape metadata,
persist watch progress, transcode files, detect seasons deeply, or create
server-side thumbnails yet. Music is intentionally handled by Studio.
