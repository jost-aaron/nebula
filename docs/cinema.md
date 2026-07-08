# Cinema

Cinema is the local media browser and web player prototype.

## Content Source

Cinema scans the ignored `content/` folder for media files. Current supported
video extensions:

- `.mp4`
- `.m4v`
- `.mov`
- `.webm`

Current supported audio extensions:

- `.mp3`
- `.m4a`
- `.flac`
- `.wav`
- `.aac`
- `.ogg`

Files can be added with the Files app. Large files should use the resumable
upload path already built into Files.

## Frontend

The Cinema UI lives in:

```text
src/cinema/renderCinemaView.ts
```

It renders:

- Plex-like category tabs for Movies, TV Shows, and Music.
- A searchable local media grid.
- A persistent watchlist for saved titles.
- A dedicated title details submenu after selecting a title.
- Separate playback surfaces for video and music.
- A dedicated music player for audio files with album art/fallback art, native
  audio controls, server/status information, metadata, and next-up queue.
- A metadata editor for every imported media item.
- Browser-generated preview thumbnails.
- A prototype visual identification workflow for selected videos.

Thumbnails are generated client-side by loading video metadata, seeking near the
start of the file, drawing the frame to a canvas, and using that canvas image as
the poster background. If a browser cannot decode or seek a file, the card keeps
its fallback poster.

Audio files, including MP3 and FLAC, use the Music path instead of the video
preview/player frame. Selecting an audio title shows a track-focused detail
layout without the large black video area. Pressing Play opens a music player
surface built around a real `<audio data-cinema-player controls autoplay>`
element. Browser autoplay blocks or unsupported formats, such as FLAC in some
browsers, are reported in the player status line.

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

This keeps the first version aligned with the product idea: use a model/search
provider to gather online evidence from sampled screenshots, then rank candidate
movie or TV titles by corroborated web results instead of trusting internal
model knowledge.

Category assignment is currently local and heuristic:

- Audio files go to Music.
- Video files under `TV`, `Shows`, or `Series` folders, or files named like
  `S01E01` or `1x01`, go to TV Shows.
- Other video files go to Movies.

## Metadata Editing

Editable media properties are stored in:

```text
content/.cinema-metadata.json
```

The file is keyed by content-relative media path. Cinema scans real files from
disk first, then overlays editable fields from the metadata file. The source file
path, stream URL, size, modified time, and media kind remain derived from disk.

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

- `GET /api/cinema/library` - recursively scan `content/` for supported media.
- `GET /api/cinema/media?path=<path>` - stream a media file.
- `HEAD /api/cinema/media?path=<path>` - return media metadata headers.
- `POST /api/cinema/identify` - search sampled video frames for candidate titles.
- `PATCH /api/cinema/metadata` - save editable metadata for a media file.
- `PATCH /api/cinema/watchlist` - add or remove a media file from the watchlist.

The media endpoint supports HTTP byte ranges and returns `206 Partial Content`
for range requests. This is required for normal browser video playback behavior,
especially seeking.

## Boundaries

Cinema is still a local-library prototype. It does not scrape metadata, persist
watch progress, transcode files, detect seasons deeply, or create server-side
thumbnails yet.
