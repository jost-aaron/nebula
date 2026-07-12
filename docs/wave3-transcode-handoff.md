# Wave 3 Software Transcode Handoff

## Delivered scope

`server/transcode/` implements cancellable software FFmpeg sessions for trusted
planner responses whose decision is `transcode`. The initial rendition is fixed
to H.264 video and AAC stereo audio in MPEG-TS segments delivered by HLS. Each
session produces a master playlist, media playlist, and isolated segment files.

`createTranscodeService` accepts injected catalog/authorization resolution plus
dedicated content and cache roots. `createSession(plan, authorizationContext)`
validates the decision and exact output tuple before forwarding the identity and
authorization context to `resolveSource`. The returned source must be available,
belong to the planned item, and resolve to a real file inside the content root.

Sessions expose `queued`, `running`, `ready`, `failed`, or `cancelled` status, a
completion promise, cancellation, explicit cleanup, the ready master-playlist
path, and `resolveAsset(name)`. Asset resolution accepts only `master.m3u8`,
`media.m3u8`, and canonical `segment-00000.ts` names, then applies realpath and
regular-file containment checks. HTTP integration should use this resolver and
must not expose absolute paths.

FFmpeg uses argument arrays with `shell: false`, `-nostdin`, `-n`, first video
and audio stream mapping, subtitle exclusion, `libx264`, AAC stereo, MPEG-TS HLS,
and VOD playlists. Stderr, total output bytes, segment count, runtime, and worker
concurrency are bounded. Abort and limit failures kill FFmpeg. Failed and
cancelled sessions remove partial output; ready output remains until explicit
cleanup or service shutdown. Initialization removes interrupted prior-process
cache, and shutdown cancels active/queued sessions and removes the cache root.

## Integration requests

The integration owner should make these shared-file changes after merging:

1. Construct `createTranscodeService` in `server/dev.mjs` with the shared content
   root, a dedicated data/cache subdirectory, conservative concurrency and
   output limits, and an authorization-aware `resolveSource`. Call
   `initialize()` before serving and `shutdown()` during server shutdown.
2. The injected resolver must require a user principal, validate the catalog
   item/source relationship, availability, library/root access, and path access,
   and return the catalog source. Preserve authorization failures instead of
   converting them to missing-source responses.
3. Central playback-session routing must pass only the server-produced result
   returned by `playbackPlanner.plan(...)`. Never deserialize a client-authored
   object and treat it as a trusted transcode plan.
4. Route the session master/media playlists and segments through
   `session.resolveAsset(name)`. Serve playlists as
   `application/vnd.apple.mpegurl` and segments as `video/mp2t`. Bind session
   access to the creating principal and call `session.cleanup()` when delivery
   finishes, expires, or is abandoned.
5. Decide the central session URL/expiry response contract before adding routes.
   No shared contract, route, migration, account store, or Cinema UI file was
   changed in this branch.

## Tests

`tests/server-transcode.test.mjs` covers:

- an actual Docker-generated AVI with MPEG-4 Part 2 video and MP2 audio,
  transcoded by FFmpeg and verified by FFprobe as H.264/AAC MPEG-TS HLS;
- master/media playlist and segment production;
- malformed/non-transcode plans and unsupported output tuples;
- missing, mismatched, unavailable, traversal, absolute, and symlinked sources;
- authorization-context forwarding through the injected resolver;
- missing FFmpeg, timeout, cancellation, stderr bounds, no-overwrite behavior,
  byte limits, segment limits, and partial-output cleanup;
- bounded concurrency, startup recovery, shutdown, and explicit cleanup; and
- safe asset resolution, session isolation, and cache-ID collision rejection.

The small executable fake-FFmpeg fixture deterministically exercises process
timeout and output-limit monitors. The incompatible media fixture is generated
inside Docker from `tests/fixtures/transcode/incompatible-codec.json`; no media
binary is committed.

## Limitations

- There is one software rendition, not an adaptive bitrate ladder.
- Hardware acceleration, HDR tone mapping, subtitle extraction/burn-in, and
  broad Cinema changes are intentionally out of scope.
- Ready sessions are process-local disposable cache and are not restart
  resumable. Startup recovery deliberately deletes remnants.
- Route-level authentication, ownership, expiry, and lifecycle policy remain
  integration-owned.
