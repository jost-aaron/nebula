# Wave 3 Playback Planner Handoff

## Delivered scope

`server/playback-planner/` contains a side-effect-free planner and an injected
catalog/authorization boundary. It produces the shared
`PlaybackPlanResponse` shape for direct play, remux, software HLS transcode, or
unsupported decisions. It does not spawn FFmpeg, create playback sessions,
mutate playback state, or select hardware acceleration.

The planner selects the default video and audio stream (falling back to the
first stream of each type) and default or forced subtitle streams. It compares
the source container, codecs, dimensions, source bitrate, audio channels, and
subtitle formats with normalized client capabilities. Reasons are emitted in a
fixed evaluation order and retain the affected stream index.

Remux targets are restricted by a conservative container/codec compatibility
table. Software transcode output is deliberately fixed to H.264 video, AAC
audio, and MPEG-TS over HLS; a client must declare HLS and the applicable target
codecs. This is a plan only, not a claim that a session implementation exists.

## Integration requests

The integration owner should make these shared-file changes after merging:

1. Add an authorized `POST /api/playback/plan` route in `server/api.mjs` or the
   integration-owned playback routing layer. Parse `PlaybackPlanRequest`,
   require a user principal, and pass the authenticated authorization context
   to `planner.plan(request, context)`.
2. Construct `createPlaybackPlanner({ resolveMedia })` during server startup in
   `server/dev.mjs`. The injected resolver must validate that the requested
   item/source pair exists, that the source belongs to the item, and that the
   authenticated user may access the source's library/root/path. It should
   return `{ item, source, probe: probeReader.get(sourceId) }` and preserve
   authorization errors (for example HTTP 403) rather than converting them to
   compatibility decisions.
3. Keep request/response types in `src/shared/playbackPlanTypes.ts` unchanged.
   If future stream selection is required, extend the shared request contract
   centrally before changing planner selection behavior.
4. Do not register a migration for this change. The planner has no schema and
   requires no central migration entry.

## Tests

Focused coverage lives in `tests/server-playback-planner.test.mjs` and includes:

- direct play and codec/container alias normalization;
- safe container-only remux;
- video codec transcode;
- width, height, bitrate, and channel limits;
- selected and unselected subtitles;
- HLS and software target support;
- malformed capabilities without catalog resolution;
- missing, mismatched, unavailable, and unprobed catalog data;
- authorization-context forwarding and error preservation;
- audio-only planning; and
- deterministic reason ordering.

## Limitations

- There is no API route or startup wiring in this branch by ownership design.
- Stream selection is deterministic but not user-configurable because the
  frozen request contract contains no stream IDs.
- The first software rendition is limited to H.264/AAC HLS. HDR tone mapping,
  subtitle extraction versus burn-in detail, adaptive ladders, sessions,
  cleanup, concurrency policy, and hardware acceleration remain future work.
- Capability aliases are intentionally small and should expand only with
  fixtures demonstrating real client declarations and FFprobe names.
