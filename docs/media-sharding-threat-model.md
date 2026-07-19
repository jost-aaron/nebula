# Media Sharding Threat Model

## Scope

This threat model covers the coordinator-and-shards design in
`docs/media-sharding-implementation-plan.md`. It applies before any cluster
route, migration, or discovery mechanism is enabled.

## Protected Assets

- Nebula account identities, password hashes, sessions, CSRF secrets, and roles.
- Per-user library permissions, history, resume state, playlists, and watchlists.
- Cluster signing keys, pairing codes, delegated grants, and revocation state.
- Media filenames, content paths, content fingerprints, metadata, and artwork.
- Media bytes, prebuilt renditions, transcode capacity, and storage details.
- Node health, tailnet names, topology, addresses, and traffic diagnostics.

## Trust Boundaries

1. Tailscale admits a network connection but does not authenticate a Nebula
   account or authorize a media operation.
2. The coordinator owns user identity, policy, personal state, and federated
   catalog decisions.
3. A shard owns local media and may serve only coordinator-authorized grants.
4. The browser/native client is untrusted input and never receives node private
   keys or unrestricted shard credentials.
5. A paired shard is not trusted to mutate coordinator accounts or another
   shard's catalog.

## Principal Threats And Controls

| Threat | Required control |
| --- | --- |
| Pairing-code theft or brute force | Owner-only creation, high entropy, short expiry, one use, rate limiting, no logging, audited consumption. |
| Malicious or compromised shard | Signed bounded manifests, strict schemas, no paths, least-privilege node capabilities, revocation, and coordinator-side authorization. |
| Coordinator impersonation | Pinned Ed25519 identity established during explicit pairing; key rotation requires an authenticated owner flow. |
| Replay of signed requests | Signed timestamp and nonce, short clock window, persisted/bounded nonce cache, canonical method/path/body digest. |
| SSRF through shard enrollment | Exact owner-entered HTTPS origin, `.ts.net` hostname validation, no credentials/path/query/fragment, no redirects, DNS-rebinding defense, bounded timeouts. |
| Confused-deputy media access | Grants bind cluster, coordinator, shard, account, device, session, item, local source, revision, methods, prefix, quality, nonce, and expiry. |
| Grant theft or leakage | Short lifetime, HTTPS only, no logs/HTML/metrics, referrer suppression, optional one-session binding, immediate trust revocation. |
| Path traversal or arbitrary file read | Opaque local source IDs, fixed media route prefix, server-side source resolution, canonical path containment, no manifest content paths. |
| Catalog poisoning or false dedupe | Provider identity is scoped by media type; exact replicas require strong digest; ambiguous matches remain separate; owner merge/split overrides. |
| Hash collision or stale digest | Versioned strong algorithm, byte length, source revision binding, background recomputation after content change. |
| Cross-user metadata disclosure | Coordinator filters federated items, artwork, availability, and grants through existing library permissions before response. |
| Resource exhaustion | Manifest/page/body limits, polling backoff, hash I/O limits, rate limits, scheduler capacity, transcode admission, and cooldown. |
| Node removal race | Block new grants immediately, revoke node key, bounded active-grant lifetime, fail over only to an authorized exact replica. |
| Downgrade or mixed-version confusion | Exact protocol version, capability negotiation, fail-closed unknown fields at trust boundaries, rolling compatibility tests. |
| Sensitive observability | Low-cardinality node IDs, redacted errors, no paths/hashes/grants/tokens in logs, metrics, audit details, or UI. |
| Public exposure | Tailscale Serve only, Funnel forbidden, localhost binding retained, Nebula authentication remains required. |

## Security Invariants

- No node receives another node's private signing key.
- No shard receives the coordinator account database, password hashes, browser
  session cookie, CSRF secret, or unrestricted service token.
- No client chooses an arbitrary shard endpoint, filesystem path, transcode
  command, or proxy target.
- No manifest field alone authorizes media delivery.
- No title, filename, size, or modification time proves an exact replica.
- No tailnet identity silently becomes a Nebula identity.
- No request is trusted solely because it arrived from localhost, a `.ts.net`
  hostname, a Tailscale IP, or a forwarded header.
- Standalone mode exposes no cluster routes until explicitly enabled.

## Validation And Abuse Tests

- Pairing expiration, reuse, brute force, owner/member/service authorization,
  and concurrent consumption.
- Signature alteration, nonce replay, timestamp skew, key rotation, revocation,
  protocol downgrade, and unknown fields.
- Endpoint credentials, redirects, DNS rebinding, non-HTTPS schemes, alternate
  ports, paths, queries, fragments, loopback, and non-Tailscale hosts.
- Oversized/deep manifests, duplicate IDs, invalid tombstones, stale revisions,
  cursor loss, malformed metadata, and digest/revision mismatch.
- Grant substitution across users, devices, nodes, sources, revisions, methods,
  assets, profiles, and expired sessions.
- Library permission changes while a shard is offline or playback is active.
- Coordinator/shard compromise simulations, partition, restore, and node removal.

## Deferred Risks

The first release has one coordinator, so it is an availability dependency for
new browsing and playback sessions. Active shard grants may continue only until
their short expiry. Redundant coordinators require account and personal-state
replication and need a separate consensus/conflict threat model.

Multi-origin HLS is also deferred. It expands grant distribution, segment
integrity, origin selection, and client attack surface and must receive a new
threat-model review before its feature flag can be enabled.
