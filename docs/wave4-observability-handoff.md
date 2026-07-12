# Wave 4 Observability Handoff

## Delivered

`server/observability/` provides dependency-injected readiness checks for:

- SQLite query availability;
- content-root read/write access;
- jobs-worker running state, activity, and heartbeat freshness;
- catalog scan failures/freshness plus scanning-root and pending-probe counts;
- content and delivery-cache filesystem capacity.

It also provides Prometheus 0.0.4 text rendering with bounded gauges. Labels are
limited to fixed component and storage-class values. Raw exceptions are discarded,
and output never includes account names, paths, tokens, filenames, job/session IDs,
or other unbounded identifiers.

## Endpoint Boundary

- `GET /healthz`: public liveness only (`{ "live": true }`). It must not touch
  dependencies or disclose readiness details.
- `GET /readyz`: public, opaque readiness (`{ "ready": boolean }`) with 200/503.
- `GET /api/admin/observability/readiness`: authenticated owner/admin diagnostics.
- `GET /metrics`: authenticated owner/admin Prometheus scrape endpoint.

Deployments that need an unauthenticated infrastructure scrape should use a
network-private proxy that adds admin credentials; the application endpoint should
not become public.

## Integration Requests (shared files intentionally untouched)

The integration owner should:

1. Construct checks in `server/dev.mjs`, using the live database, content root,
   delivery-cache root, worker heartbeat snapshot, and SQL-backed catalog/job
   aggregate snapshots.
2. Add a worker heartbeat/snapshot adapter. It should expose only `running`,
   `heartbeatAt`, and aggregate `active`; no job identity or payload.
3. Query catalog/job state with aggregate counts only. Convert timestamps to epoch
   milliseconds before passing them to the catalog check.
4. Mount `createObservabilityRoutes` before the normal `/api/*` authorization gate
   so `/healthz` and `/readyz` remain reachable, while implementing `isAdmin` with
   the existing owner/service-token authorization primitives.
5. Ensure reverse-proxy access logs do not attach credentials to metrics URLs and
   configure scraper credentials outside the repository.

No migration or shared contract change is required.

## Verification

Focused coverage is in `tests/server-observability.test.mjs`. It exercises healthy
and degraded checks, stale workers, scan failures, low disk, bounded sanitization,
Prometheus formatting, access boundaries, and explicit secret/path leakage guards.

