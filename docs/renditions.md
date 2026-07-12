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

## Current Boundary

This contract wave adds profile definitions, additive playback types, and the
central migration only. It does not yet change Cinema's quality selector,
planner behavior, FFmpeg scaling, HLS startup, persistent storage, or jobs.
Those features land in later waves against this contract.
