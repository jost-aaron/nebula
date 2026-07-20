# Studio

When clustering is enabled on a coordinator, owners and service clients see a
deduplicated music library with shard availability badges and source details.
Tracks with a local source use the existing persistent audio player. Remote-only
tracks can be inspected but are excluded from the queue and playback controls
until delegated shard delivery is implemented. Member and guest libraries stay
local-only.

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
- A custom Nebula Studio transport with branded play/pause, seek, volume, mute,
  previous, and next controls instead of browser-native audio chrome.
- A persistent mini player that keeps the active track playing while the user
  browses Library, Artists, Albums, search results, and playback history. It
  exposes quick transport controls and a shortcut back to the full track view.
- A real-time 4096-point FFT visualizer that maps the current audio window from
  the lowest resolvable audible frequency through 20 kHz using logarithmic
  spacing and up to 192 responsive bars, with a
  low-energy ambient animation when playback is paused, buffering, unsupported,
  or sourced from a server the browser cannot safely analyze.
- A single persistent native `<audio data-studio-player>` playback engine hidden
  behind Studio's custom full and mini-player controls.
- Authenticated, per-user playback lifecycle reporting with periodic progress,
  pause, stop, and completion events.
- Continue Listening and Listening History rails ordered by recent playback.
- A centered in-app resume prompt that can continue from the saved position or
  restart the selected track. Guest listening remains non-persistent.
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
- `GET /api/playback/history` - return the authenticated user's recent playback
  state, including completed tracks.
- `POST /api/playback/events` - record authenticated Studio playback lifecycle
  events using stable catalog item and source IDs.

The media endpoint supports HTTP byte ranges and returns `206 Partial Content`
for one valid normal, open-ended, or suffix range. Invalid, multi-range,
empty-file range, and unsatisfiable requests return `416`.

The library is server-shared. Queue order remains client-local, while playback
history and resume positions are persisted per authenticated user in the shared
Nebula database. The first library request reconciles newly discovered audio
with the catalog before returning tracks, ensuring lifecycle events always use
stable item and source IDs. First-run guests can play music but cannot read or
write this personal history.
Authenticated library responses issue expiring, audio-path-bound media tickets
so browser and Capacitor `<audio>` playback can use byte ranges without exposing
an account session token.

## Boundary With Cinema

Cinema is video-only. Movies and TV Shows remain in Cinema through
`/api/cinema/*`; MP3, FLAC, M4A, WAV, AAC, OGG, and future audio library
behavior belong in Studio through `/api/music/*`.
