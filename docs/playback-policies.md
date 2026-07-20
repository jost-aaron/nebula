# Playback Policies

Wave 4 adds owner-configurable limits for server-produced playback delivery.
Every limit defaults to unlimited, so upgrading preserves prior behavior.

## Policy model

- The global concurrent-stream limit is an aggregate ceiling across all users.
- A per-user concurrent-stream limit independently caps that account.
- Global and per-user bitrate ceilings combine using the strictest configured value.
- A blank global value means unlimited. A blank per-user stream value adds no
  account-specific cap, while a blank per-user bitrate inherits the global cap.
- Configuration persists through the centrally ordered `playback-policy-v1`
  domain migration.

Owners configure policy from Settings / Playback. Owners and the legacy
service-admin bearer token may use:

```text
GET  /api/admin/playback-policy
PUT  /api/admin/playback-policy
PUT  /api/admin/playback-policy/users/:userId
GET  /api/admin/playback-policy/status
```

Members receive `permission_denied`. Aggregate status includes active governed
session totals and per-account effective limits; it does not expose media paths,
tokens, or playback history.

## Admission and cleanup

`server/playbackPolicy/` governs both local and federated server-produced
delivery. Local delivery admits after its trusted planner selects a remux or
transcode plan and before worker creation. Federated delivery first clamps the
client bitrate capability to the account's current effective limit before the
coordinator scheduler and remote shard see the request. A remote generated
result then receives one coordinator-owned lease, shared with the local lease
pool. The coordinator revalidates that same lease against current policy and
the shard's final output immediately before issuing the first media grant.

Local cluster candidates continue through the existing local delivery service
and do not receive a second coordinator lease. Remote queued generation holds
its lease while pending, so queued work cannot bypass global or per-account
concurrency. The in-memory reservation is synchronous, so concurrent local and
remote requests cannot both consume the same final slot. Configuration
persists, but leases are process-local: restart begins with zero active leases
instead of resurrecting stale accounting.

Leases release idempotently when Cinema reports playback completion, the client
cancels, worker creation or execution fails, delivery expires, a remote result
becomes terminal, a cluster session fails over, or the server shuts down.

Cinema reports a natural end with
`POST /api/playback/delivery-sessions/:id/complete`; explicit stop and surface
cleanup continue to use the existing delivery-session `DELETE` route.

Stable denial codes are:

- `global_stream_limit_reached` (429)
- `user_stream_limit_reached` (429)
- `bitrate_limit_exceeded` (422)
- `produced_bitrate_limit_exceeded` (422)

Software HLS uses the admitted ceiling for bounded FFmpeg video/audio targets,
reserves five percent for MPEG-TS/HLS overhead, and advertises the ceiling as
HLS master bandwidth. Remux output cannot be bitrate-shaped, so admission is
denied when its probed source bitrate exceeds the effective cap. Remote remux,
fixed/prebuilt rendition, and live-transcode results are also checked against
the coordinator's current effective limit; a shard result above that limit is
rejected before grant activation.

## Direct-play limitation

Direct file byte ranges are intentionally not counted or bitrate-shaped. The
current HTTP range endpoint has no durable client session boundary and cannot
reliably distinguish completion, seeking, disconnect, or abandonment. Counting
those requests would either leak slots or release them too early. Planner
capability checks still apply. Trustworthy direct-play policy requires a future
heartbeat/session protocol or connection-aware delivery layer.

## Verification

Policy tests cover migration/defaults, persistence, atomic global and per-user
admission, combined local/remote accounting, scheduler capability clamping,
requested and produced bitrate behavior, pending-policy revalidation,
idempotent release across cluster terminal paths, restart accounting,
owner/service authorization, member denial, and responsive Settings.
