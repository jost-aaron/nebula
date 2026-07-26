# Performance and reliability budgets

Nebula is designed to remain responsive while discovery, metadata, artwork, and
rendition work run in the background. New work should preserve these budgets.

## Browser

- Opening and closing an app must leave no additional timers, animation frames,
  observers, global listeners, media sessions, or audio contexts.
- Library requests are generation-owned. A response from an aborted or
  superseded search, category, or page must never update the active view.
- Background animation runs only while its visible UI is mounted and active.
- Artwork status refreshes back off while idle and stop while the document is
  hidden.
- Browse windows are bounded. Server-side search remains responsible for
  locating content outside the active client window.
- The initial dashboard bundle must not eagerly include Cinema, Studio, or their
  playback dependencies.

## API and database

- Page projection uses a bounded number of queries rather than per-card
  enrichment queries.
- Merely displaying a card must not create a durable playback credential.
- Principal permissions are resolved once per request or applied in the catalog
  query.
- Filesystem discovery and catalog reconciliation run as background work, not
  inside a request advertised as asynchronously accepted.
- SQLite is the runtime metadata authority. Compatibility files are import or
  export artifacts, not a second writable database.

## Jobs and media processing

- A long healthy job must not make readiness stale.
- Shutdown stops claiming work, signals active handlers, and completes or fails
  within the container grace period.
- Provider, filesystem, maintenance, and CPU-heavy work have independent
  concurrency and priority controls.
- User-visible playback and artwork cannot sit indefinitely behind bulk
  metadata or scan work.
- Transcode progress checks must not rescan and restat all previously published
  segments.

## Release gates

For large-library changes, capture a trace using at least 1,000 visible catalog
entries and an active artwork queue. Check:

1. no repeated main-thread tasks over 50 ms during continuous scrolling;
2. no increase in live resources after ten open/close cycles;
3. bounded DOM/card count and request rate;
4. bounded SQL statement count per page;
5. interactive jobs start while maintenance queues are saturated;
6. a job longer than 30 seconds leaves `/readyz` healthy;
7. SIGTERM drains or requeues active work before the configured grace period;
8. the production image serves compiled assets without Vite or HMR.

Record regressions in tests or benchmark notes rather than relying on a manual
visual check alone.
