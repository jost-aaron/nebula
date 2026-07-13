# Media Renditions

Nebula's rendition contract separates a requested playback quality from the
FFmpeg command that produces it. Clients may request `auto`, `original`, or a
server-owned profile ID. They never submit codecs, filters, filesystem paths,
encoder names, or process arguments.

## Built-In Profiles

The first profile version defines H.264/AAC MPEG-TS HLS targets:

| Profile | Maximum frame | Total bitrate ceiling | Video bitrate | Audio |
| --- | --- | ---: | ---: | --- |
| `480p` | 854x480 | 2 Mbps | 1.8 Mbps | AAC stereo, 128 Kbps |
| `720p` | 1280x720 | 4 Mbps | 3.6 Mbps | AAC stereo, 128 Kbps |
| `1080p` | 1920x1080 | 8 Mbps | 7.4 Mbps | AAC stereo, 192 Kbps |

These values are server-authored ceilings, not client-authored FFmpeg input.
Rendition generation must preserve aspect ratio, use even dimensions, and
never upscale. Versioned profiles allow future tuning without treating old
output as current.

The initial profiles are SDR-only. HDR tone mapping, HEVC, AV1, CMAF/fMP4, and
custom administrator profiles remain later work and must not be inferred from
these IDs.

## Persistence Contract

`media_renditions` records reusable output by:

- catalog source ID;
- source content revision;
- profile ID and profile version;
- lifecycle state;
- cache or pinned retention;
- interactive or scheduled origin;
- verified output dimensions, bitrates, size, and checksum;
- bounded failure details and access timestamps.

The uniqueness boundary is `(source_id, source_revision, profile_id,
profile_version)`. A source replacement therefore cannot reuse output produced
from an older file revision. Deleting a source cascades its rendition records.

`storage_key` is an internal data-root-relative identifier. Absolute paths must
never cross API or shared client contracts. Rendition media belongs under the
ignored `/app/data` volume, not `content/`, Git, or generated iOS assets.

## Planned Producers

Two producers will share this contract:

1. Interactive playback builds a low-latency rendition and exposes it when the
   first safe HLS segments are playable.
2. Background optimization builds the same versioned profile through a
   persistent, deduplicated, cancellable job.

Both producers must reuse the same argument builder, source authorization,
hardware-selection policy, output verification, and atomic publication logic.
Normal delivery remains account-bound even when the underlying rendition is
shared across authorized users.

## Current Runtime Boundary

The playback planner now consumes `auto`, `original`, and explicit profile
preferences. `auto` preserves direct play/remux when possible and otherwise
selects the highest standard profile allowed by the source, client, and
playback policy. `original` never silently downscales. Explicit profile requests
force HLS and fail closed if they exceed the client or would upscale the source.

Interactive HLS uses exact profile bitrate ceilings, fitted even dimensions,
four-second keyframe-aligned event segments, and atomic FFmpeg publication. A
fresh transcode becomes playable once the first playlist and segment are safe,
while FFmpeg continues to occupy its concurrency slot until completion. HLS
playlists are never cached; completed segments are private and immutable.

Resumed transcodes currently wait for the complete playlist before becoming
playable so the original timeline remains seekable. Start-offset transcoding is
future optimization work. Interactive output remains disposable under
`delivery-cache`; persistent reuse, scheduled/pinned generation, quota/LRU
management, and administrator controls are the next waves.

Cinema discovers profile labels and limits from `GET /api/renditions/profiles`.
Its player exposes Auto, Original, 480p, 720p, and 1080p choices and reports the
actual planned result. Native HLS remains preferred on Safari/iOS; browsers with
Media Source Extensions use the pinned hls.js adapter with credentialed
same-origin requests, one bounded media recovery attempt, sanitized failures,
and explicit teardown whenever delivery changes or Cinema closes.
