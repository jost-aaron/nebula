# Playback Planning

Wave 3 starts with an explainable playback decision before any FFmpeg process is
launched. Clients declare supported containers, codecs, subtitle formats,
resolution, bitrate, channel count, and HLS support. The server evaluates those
capabilities against catalog probe data.

Decision order is fixed:

1. `direct-play` when the original container and selected streams are supported.
2. `remux` when codecs are compatible but the container is not.
3. `transcode` when one or more selected codecs or limits are incompatible and
   the client supports the planned delivery protocol.
4. `unsupported` when no safe delivery plan exists.

Every response includes machine-readable and human-readable reasons. Planning
must not start a session, mutate playback state, or spawn FFmpeg. Item/source
IDs are catalog validated and authorization remains user/path scoped.

Initial API direction:

```text
POST /api/playback/plan
```

The first worker owns planner logic and focused tests under
`server/playback-planner/`. It must not implement hardware acceleration or a
broad Cinema redesign. Remuxing follows only after planner fixtures cover at
least direct-play, container-only incompatibility, codec incompatibility,
resolution/bitrate limits, subtitles, and unsupported clients.

## Delivery sessions

Wave 3 delivery is integrated through account-bound, process-local sessions:

```text
POST   /api/playback/delivery-sessions
GET    /api/playback/delivery-sessions/:id
DELETE /api/playback/delivery-sessions/:id
GET    /api/playback/delivery-sessions/:id/file
GET    /api/playback/delivery-sessions/:id/hls/:asset
```

Creation accepts item/source IDs and client capabilities only. The server runs
the planner, validates catalog and probe data, and selects direct delivery, an
MP4 stream-copy remux, or software H.264/AAC HLS. Sessions expire after 30
minutes and are cleaned on cancellation, expiry, restart, and graceful
shutdown. Responses never expose filesystem paths, and HLS requests use only
the transcode service's canonical playlist/segment resolver.
