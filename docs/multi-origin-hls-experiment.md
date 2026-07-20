# Multi-Origin HLS Phase 6 Experiment

## Recommendation: Defer

Do not connect the Phase 6 prototype to production playback yet. Nebula's
persistent rendition store calculates a SHA-256 checksum over the complete HLS
directory, but the cluster manifest advertises only profile ID, source revision,
and readiness. It does not publish the directory checksum or a cryptographic
playlist and segment map. Independent FFmpeg runs on different hosts have not
been demonstrated to produce byte-identical playlists and segments.

The coordinator therefore cannot prove that a same-named segment from two
shards is interchangeable. Filename, profile, source digest, and source revision
are necessary but insufficient.

## Bounded Prototype

- `server/cluster/multiOriginHls.mjs` constructs a contract only when source
  fingerprint, revision, profile/version, rendition digest, playlist digest,
  and every segment SHA-256/length match across two to four origins. Account,
  session, item, node, revision, expiry, revocation, and exact Tailscale origin
  are checked for every grant.
- `src/cinema/multiOriginHlsLoader.ts` is a bounded hls.js-compatible loader
  prototype. It uses approved origins only, omits credentials and referrers,
  rejects redirects, bounds body size/time/retries, verifies length and SHA-256
  before returning bytes, and coalesces concurrent requests for one segment.
- `scripts/benchmark-multi-origin-hls.mjs` is a deterministic generated-fixture
  scheduling model, not real network, browser, Tailscale Direct, or DERP evidence.

The server and client gates are exact opt-in through
`NEBULA_MULTI_ORIGIN_HLS_EXPERIMENT=true` and
`VITE_NEBULA_MULTI_ORIGIN_HLS_EXPERIMENT=true`; both default to false. There is no
production call site, API response, Compose setting, or client activation.
Native HLS and the single-best-shard scheduler are unchanged.

## Generated Evidence

The fixture models 120 two-MiB segments. A direct origin is modeled at 20 ms
latency and 8 MiB/s; a relay-like origin at 120 ms and 3 MiB/s. Two equivalent
direct origins approximately halve modeled completion time. A mixed pair beats
relay alone. This only proves parallel independent servers can improve a
synthetic makespan. It does not model browser connection limits, Tailscale
congestion, disk contention, decoder timing, retries, or actual rebuffering.

## Required Evidence Before Reconsideration

1. Repeatedly build the same profile/source on at least two supported shard
   platforms and FFmpeg versions; compare complete playlist and segment hashes.
2. Version and publish generator identity, rendition/playlist digests, and a
   bounded segment map through a reviewed cluster protocol migration.
3. Add coordinator lifecycle ownership for every origin grant, shard delivery,
   policy lease, cancellation, expiry, source change, and shutdown.
4. Browser-test hls.js over real Tailscale Direct and DERP, including tampering,
   stalls, origin loss, seek, subtitles, quality, resume, and teardown.
5. Require repeatable startup, rebuffer, or throughput improvement over the
   single-best-origin scheduler. Otherwise reject Phase 6.

Never weaken integrity to increase eligibility. Ticket URLs are short-lived
bearer capabilities and must stay out of logs, referrers, storage, and rendered
diagnostics. Guests remain denied federation. Native HLS remains single-origin.
