# Studio

Studio is the dedicated local music app.

## Content Source

Studio scans the ignored `content/` folder for audio files:

- `.mp3`
- `.flac`
- `.m4a`
- `.wav`
- `.aac`
- `.ogg`

Files can be added with the Files app. Media stays in ignored `content/` and
must not be committed.

## Frontend

The Studio UI lives in:

```text
src/studio/renderStudioView.ts
```

It renders:

- A Dashboard/close command in the Studio header.
- Searchable local music browsing with Library, Artists, and Albums views.
- Library grouping by artist first, then album within an artist.
- A responsive, eclipse-branded now-playing surface with local fallback album
  art, previous/next track commands, and a compact up-next queue.
- A real-time FFT visualizer that maps the audio window currently under the
  playhead from low to high frequencies across the existing bar, with a
  low-energy ambient animation when playback is paused, buffering, unsupported,
  or sourced from a server the browser cannot safely analyze.
- Native `<audio data-studio-player controls>` playback.
- Server, source-file, format, and related-library information.
- Friendly browser playback status and error messages for unsupported formats,
  including FLAC in browsers that cannot decode it.

The player layout follows the dark console-style reference under
`docs/studio-design/` and uses the tracked Nebula Studio branding variants under
`src/assets/branding/`. The branding assets are presentation-only; local music
metadata, grouping, queue selection, and playback still come from the existing
music API response.

Studio intentionally avoids the Cinema video player frame.

## Library Organization

Studio groups music with these rules:

- Tracks with an artist are grouped by artist first.
- Inside an artist, tracks with an album are grouped by album.
- Tracks with an artist but no album remain directly inside that artist group.
- Tracks with an album but no artist are grouped by album at the top level.
- Tracks with neither artist nor album are shown as individual library items.

## Server Endpoints

- `GET /api/music/library` - recursively scan `content/` for supported audio.
- `GET /api/music/media?path=<path>` - stream an audio file.
- `HEAD /api/music/media?path=<path>` - return audio metadata headers.

The media endpoint supports HTTP byte ranges and returns `206 Partial Content`
for one valid normal, open-ended, or suffix range. Invalid, multi-range,
empty-file range, and unsatisfiable requests return `416`.

## Boundary With Cinema

Cinema is video-only. Movies and TV Shows remain in Cinema through
`/api/cinema/*`; MP3, FLAC, M4A, WAV, AAC, OGG, and future audio library
behavior belong in Studio through `/api/music/*`.
