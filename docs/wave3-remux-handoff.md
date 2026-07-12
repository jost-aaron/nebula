# Wave 3 Remux Handoff

## Delivered scope

`server/remux/` implements a software FFmpeg stream-copy session boundary for
planner responses whose decision is `remux`. The first supported target is an
MP4 file containing copied video and audio streams. It does not transcode
codecs, create HLS playlists, select hardware acceleration, or own HTTP routes.

`createRemuxService` accepts injected catalog/authorization resolution and a
dedicated content/output root. `createSession(plan, authorizationContext)`
validates the planner decision and item/source relationship before resolving a
content-relative, real filesystem path. It returns a session with observable
`queued`, `running`, `ready`, `failed`, or `cancelled` state, a completion
promise, cancellation, explicit cleanup, and the completed output path.

FFmpeg is spawned with an argument array and `shell: false`. Arguments include
`-nostdin`, `-n`, optional audio/video maps, `-c copy`, subtitle exclusion, and
the `--` option delimiter. Stderr and produced-file size are bounded. Processes
have timeouts and AbortSignal cancellation. Failed and cancelled sessions remove
partial output; service startup removes remnants from an interrupted prior
process, and shutdown cancels work and removes the dedicated output root.

## Integration requests

The integration owner should make these shared-file changes after merging:

1. Construct `createRemuxService` in `server/dev.mjs` with a dedicated data/cache
   subdirectory, the shared content root, and bounded concurrency. Call
   `initialize()` before accepting sessions and `shutdown()` during server
   shutdown.
2. Inject a `resolveSource({ itemId, sourceId }, principal)` implementation that
   requires an authenticated user, verifies source ownership by the item,
   library/root access, availability, and path authorization, then returns the
   catalog source. Preserve authorization errors rather than converting them to
   missing-source errors.
3. Add integration-owned playback-session routing after deciding the response
   contract. Pass only the server-produced result of
   `playbackPlanner.plan(...)`; never accept an arbitrary client-authored plan.
   Await `session.completion` before serving `session.outputPath`, and call
   `session.cleanup()` when delivery finishes or the client abandons it.
4. Add MP4 to the media response content-type mapping if the new route does not
   reuse the existing media sender. Do not expose absolute input or output paths.
5. Consider persisting only session metadata if restart-resumable delivery is
   later required. This implementation deliberately treats startup remnants as
   disposable cache and needs no database migration.

## Tests

`tests/server-remux.test.mjs` covers:

- an FFmpeg-generated H.264/AAC Matroska source genuinely remuxed to MP4;
- fixed argument arrays, shell-disabled execution, no-overwrite behavior, and
  bounded stderr;
- malformed/non-remux plans and unsupported output containers;
- missing, mismatched, unavailable, and traversal source paths;
- authorization-context forwarding through the injected resolver;
- missing FFmpeg, timeout, cancellation, and partial-output cleanup;
- bounded concurrency; and
- startup recovery, explicit session cleanup, and shutdown cleanup.

## Limitations

- MP4 file output is the only target in this increment.
- Subtitle streams are excluded. Subtitle extraction/remux/burn-in policy
  remains a later planner/session contract decision.
- Output is complete-file delivery, not progressive HLS or codec transcoding.
- Ready output persists until explicit session cleanup or service shutdown.
