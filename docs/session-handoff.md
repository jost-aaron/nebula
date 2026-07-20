# Session Handoff

Use this file when starting a new Codex session on this project.

## Current Location

```text
/Users/josta/Documents/Codex/2026-07-05/i-w/work/nebula-dashboard
```

## Current State

Nebula Dashboard is a Docker Compose first browser dashboard/runtime prototype.
The current app includes:

- WebGPU animated background with Canvas fallback.
- Console-like app shell with app-first navigation and full-screen app launch
  animation.
- Modular typed shell state, account-scoped stable-ID focus persistence, roving
  tile focus, and shared keyboard/wheel/pointer/gamepad commands.
- Search app.
- Applications grid.
- Shared Settings/Diagnostics app.
- Files app for ignored local content under `content/`, with a Variant 2
  console-style layout and iOS-compatible API targeting.
- Cinema app with a dedicated full-screen video surface, browsing-first library,
  title details, watchlist, chapters, next-up rails, and lazy playback.
- Studio app with a dedicated full-screen music surface, searchable audio
  library, queue, selected-track summary, native audio playback, authenticated
  listening history, Continue Listening, and app-owned resume/start-over flow.
- Local-first accounts with first-owner setup, owner/member roles, profile and
  password settings, revocable sessions/devices, member administration,
  centralized API authorization, and personal Cinema watchlists.
- Optional owner-configured TMDB movie, series, and episode matching with
  explicit candidate selection and local-metadata fallback.
- Provider-neutral catalog and playback contracts plus the first Wave 1
  persistent backend implementations.
- Wave 2 media processing with persistent background jobs, containerized
  FFprobe, enriched catalog details, Cinema resume/Continue Watching, and
  explicit per-user watched state.
- Wave 3 account-bound playback delivery with server-authored direct, MP4 remux,
  and software HLS decisions plus expiring cache cleanup.
- Wave 4 owner-configurable global/account concurrent stream and bitrate policy
  for trusted remux and HLS/transcode delivery, with aggregate Settings status.
- Wave 4 bounded structured audit history with owner/service-admin APIs and an
  owner-only responsive Settings Activity surface.
- Server-authored 240p, 360p, 480p, 720p, and 1080p HLS quality selection with progressive
  playback, verified persistent reuse, scheduled optimization, owner storage
  policy, safe LRU cleanup, readiness, and bounded metrics.
- A no-clobber single-host deployment CLI for install, validation, lifecycle,
  logs, updates, and backups over `compose.deploy.yaml`.
- A pinned, userspace Tailscale Serve companion for private tailnet HTTPS. It is
  dormant until an owner enables it in Settings, retains node state when off,
  dynamically applies Secure cookies and its exact host, keeps HMR disabled in
  deployment, explicitly forbids Funnel, and never exposes daemon control. The
  owner-only Remote Access surface includes a sanitized live peer-path view for
  direct, peer-relay, DERP, and idle connections.

The latest user direction is to keep building toward a modern console/Plex-like
media dashboard. The next major feature under design is a coordinator-and-shards
media cluster over Tailscale. Read `docs/media-sharding-implementation-plan.md`
before implementing cluster identity, catalog federation, deduplication, or
distributed playback.

The cluster Phase 0 contracts and Phase 1 trust implementation are active in
development. Cluster mode is opt-in through `NEBULA_CLUSTER_ENABLED=true`.
Identity, pairing, signed requests, replay defense, revocation, catalog
federation, and unified browsing are implemented. Phase 4 scheduled playback is
in progress as described below.

## Must Follow

- Do not install dependencies or applications on the host.
- Use Docker Compose for running and checking.
- Keep uploaded content/media in ignored `content/`.
- Do not commit media files.
- Do not commit `/app/data` account databases, WAL/SHM files, credentials,
  session tokens, or exported user data.

## Run And Verify

```sh
docker compose up --build
docker compose run --rm dashboard npm run check
test ! -d node_modules && test ! -d dist && echo "host clean"
```

Open:

```text
http://127.0.0.1:5173
```

## Current Local Media

The ignored `content/` folder currently contains a large MP4 used for Cinema
testing:

```text
South Park The Streaming Wars.mp4
```

Cinema categorizes it as a Movie. It is intentionally not tracked by Git.

## Key Feature Notes

Accounts:

- A fresh server may use local, expiring, memory-only guest access until the
  first owner is created. Account schema v3 records irreversible owner
  initialization so deleting/restoring account rows never re-enables it.
- A fresh `nebula-data` volume deliberately enters owner setup; there is no
  default password.
- Browser sessions use HttpOnly cookies plus CSRF. Capacitor/cross-origin
  sessions use bearer auth, with an acknowledged local-storage limitation.
- Account SQLite data is separate from `content/` at `/app/data/nebula.sqlite`.
- Owners can add/disable members and choose all or selected media-library
  access per member. Existing and new members default to all libraries.
  Members retain shared Files read access but not Files mutations or shared
  Cinema metadata editing.
- Legacy `NEBULA_API_TOKEN` remains an owner-capability service path.
- See `docs/accounts.md` and `docs/account-design/README.md`.

Audit history:

- `server/audit/` owns migration, allowlisted recording/redaction, retention,
  pagination, and `/api/admin/audit`.
- Owners and service admins may filter/read events; members are denied.
- Settings / Activity is owner-only and responsive at 390×844.
- Audit recording is best-effort and never stores secrets, raw errors, media
  paths/filenames, or backup paths. See `docs/audit-history.md`.

Files:

- Uses `/api/files/*`.
- Uses the shared API base URL and bearer token helpers so desktop and iOS
  clients can point at the same Nebula server.
- Supports drag/drop upload.
- Uses streamed upload for small files.
- Uses resumable 64 MB chunks for files larger than 64 MB.
- Stores partial upload sessions under hidden `content/.uploads/`.
- Shows a native-client empty state when Files is opened without a configured
  Server URL in a bundled iOS client.

Cinema:

- Uses `/api/cinema/library` to scan `content/` for video files.
- Uses `/api/cinema/media?path=<path>` for range-enabled playback.
- Uses `PATCH /api/cinema/watchlist` for persistent watchlist state.
- Categories are heuristic:
  - `TV`, `Shows`, `Series`, `S01E01`, or `1x01` video files go to TV Shows.
  - Other videos go to Movies.
- Library and Watchlist open as browsing-first grids. Play/title detail UI stays
  hidden until the user selects a title.
- Title detail includes preview, Play, watchlist toggle, metadata, server rows,
  chapters, next-up, and modal sheets for More, chapters, and queue.
- Owners can configure a server-side TMDB token in Settings / Account. TMDB
  failures or missing configuration do not block local scanning or playback.

Media platform contracts:

- Read `docs/media-contracts.md` and `docs/media-platform-parallel-plan.md`
  before starting Catalog or Playback work.
- Stable UUID item/source IDs are canonical; content-relative paths remain
  server-controlled compatibility attributes.
- During Wave 1, the main integration agent exclusively owns shared routing,
  migration registration, shared contracts, and compatibility response files.
- Catalog workers own `server/catalog/`; Playback workers own
  `server/playback/`. Workers report shared-file requirements in handoffs.
- The server now applies centrally tracked Catalog and Playback migrations to
  the existing account database, starts an asynchronous shared-content scan,
  and exposes `/api/catalog/*` and `/api/playback/*` foundations.
- Cinema and Studio retain compatibility path APIs. Catalog-backed UI,
  playback lifecycle reporting, and Continue Watching presentation are active
  in Cinema while path playback remains as a compatibility fallback.
- Cinema now prefers `/api/playback/delivery-sessions` for same-origin stable-ID
  playback and falls back to its existing ticketed path URL if planning fails.
- `server/permissions/` persists provider-neutral member library policies and
  enforces them across catalog, Cinema/Studio compatibility APIs, direct media,
  playback state/planning, and delivery sessions without changing Files.
- Generated delivery admission passes through `server/playbackPolicy/`.
  Unlimited defaults preserve prior behavior. Direct byte-range playback is not
  counted because it lacks a reliable lifecycle boundary; see
  `docs/playback-policies.md`.

Studio:

- Uses `/api/music/library` to scan `content/` for audio files.
- Uses `/api/music/media?path=<path>` for range-enabled native audio playback.
- Uses stable Catalog IDs and `/api/playback/events` plus
  `/api/playback/history` for authenticated listening progress, completion,
  recent history, Continue Listening, and resume/start-over choices.
- Guest playback remains intentionally non-persistent and does not expose
  personal listening history.
- Supports MP3, FLAC, M4A, WAV, AAC, and OGG files through the local content
  policy.
- Shows local audio in Studio, not Cinema.

iOS:

- Capacitor iOS scaffold is present under `ios/`.
- Use `./scripts/ios-sync.sh` for normal syncs.
- Use `./scripts/ios-sync-dev-server.sh` to bake a default development Server
  URL into the iOS web bundle.
- Use `./scripts/ios-build-simulator.sh` for command-line simulator builds.
- `server/cors.mjs` adds API-only CORS for `capacitor://localhost` and other
  API clients that send an `Origin` header.
- The iOS app uses `viewport-fit=cover` plus CSS `env(safe-area-inset-*)`
  variables to keep dashboard and Cinema surfaces clear of the Dynamic Island,
  status bar, and home indicator.

## Good First Reads

Read these in order:

1. `AGENTS.md`
2. `README.md`
3. `docs/architecture.md`
4. `docs/cinema.md`
5. `docs/studio.md`
6. `docs/arcade-moonlight.md`
7. `docs/files.md`
8. `docs/mobile-clients.md`
9. `docs/testing.md`
10. `docs/development.md`
11. `docs/media-contracts.md`
12. `docs/media-platform-parallel-plan.md`
13. `docs/audit-history.md`

## Recent Verification

At handoff time:

- `docker compose run --rm dashboard npm run check` passed.
- `docker compose run --rm dashboard npm test` passed with 290 tests.
- `./scripts/test-e2e.sh` passed all 10 fresh-volume Playwright scenarios,
  including guest/owner bootstrap, shell input and focus persistence, app smoke
  paths, Studio playback history/resume, and 390×844 reachability.
- Fresh-server owner setup and owner Settings / Storage browser smoke checks
  passed at desktop and 390×844 during the rendition implementation.
- Rendition policy owner/service authorization, member denial, cookie CSRF,
  Capacitor CORS preflight, and v1-to-v2 preservation have automated coverage.
- Real-media QA verified progressive 480p playback while FFmpeg was active and
  scheduled pinned 720p playback after restart without a second encode.
- Containerized FFmpeg QA verifies bounded 240p and 360p HLS output in the
  permanent transcode suite.
- Chromium HLS capability false positives are routed through hls.js; Safari/iOS
  continues to use native HLS.
- `./scripts/ios-sync-dev-server.sh` passed.
- `./scripts/ios-build-simulator.sh` passed.
- iPhone 17 Pro simulator launch/screenshot passed for the dashboard safe-area
  smoke test.
- API CORS preflight from `Origin: capacitor://localhost` returned
  `access-control-allow-origin: capacitor://localhost`.
- `content/` is ignored by Git.
- `ios/App/App/public/` is generated and ignored by Git.
- Host tree had no `node_modules` or `dist`.
- Cinema API returned the uploaded MP4 as a Movie.
- Cinema media endpoint returned `206 Partial Content` for range requests.

## Known Gaps

- Browser coverage is intentionally focused on high-value integrated paths;
  new app workflows still need matching Playwright scenarios as they are added.
- Command-line simulator testing currently screenshots the launched dashboard,
  but tap-through Cinema/Files safe-area checks still need a manual simulator
  pass.
- TMDB matching is explicit and optional; fully automatic candidate selection
  is intentionally not enabled.
- Cinema thumbnails are generated client-side, not persisted.
- No password reset, MFA/passkeys, account deletion/role changes, second owner,
  folder-level Files ACLs, or Keychain-backed native token storage yet.
- App-surface rendering and feature-specific bindings remain in `src/main.ts`;
  shell state, persistence, input gates, and gamepad lifecycle live in
  `src/shell/`.
- Media sharding Phase 3 feeds the conservative coordinator projection into the
  existing Cinema and Studio compatibility APIs. Owners, service clients, and
  authorized members see one logical item for duplicate sources,
  shard-count/status badges, and an `Available on` source list. Member access is
  resolved against the coordinator's shared media-library scope before source
  details are loaded; guests remain local-only.
- Phase 4 schedules owner and authorized-member playback per session across online sources using
  deterministic direct/remux/transcode preference metadata, a local bonus,
  active-session load, drain state, and failure cooldown. Remote original,
  remux, HLS/live transcode, prebuilt rendition reuse, and fixed Cinema quality
  profiles and remote subtitles are activated through fixed signed shard routes.
- A coordinator signs a short-lived, account/device/session/source/revision-
  bound grant. The target shard validates the pinned paired-node signature and
  replay nonce, resolves only the bound catalog source, and serves `GET`/`HEAD`
  with range support through an opaque ticket. Server activation uses the fixed
  userspace Tailscale proxy, exact `.ts.net` endpoint, no redirects, bounded
  responses, and exact signed-client-origin CORS.
- The accepted media ticket is currently a short-lived bearer credential stored
  only as a hash on the shard. Revoking node trust blocks new grant activation,
  but an already accepted ticket lasts until expiry or shard restart. CORS is
  exact-origin defense in depth, not authentication; active-ticket revocation
  and per-request device binding remain hardening work.
- Cinema and Studio can play eligible remote-only files directly from the
  selected shard; Cinema also polls remote generated delivery for remux and HLS
  profiles. Both players react to a media error by requesting another
  online source with the identical strong fingerprint and seeking to the last
  browser position. Federated personal playback history, resume, completion,
  and Continue Watching are coordinator-owned and account-isolated. Remote
  mutations remain local-source-only.
- Member authorization is coordinator-owned and rechecked on session creation,
  polling, failover, release, and every new grant. Permission changes release
  the coordinator session and hide federated history/resume state. Shards never
  receive roles, library IDs, or mutable permission claims; accepted bearer
  tickets retain only the documented short expiry/restart revocation window.
- Coordinator playback assignments and shard-generated deliveries have hard,
  non-sliding expirations with periodic cleanup. Cleanup is idempotent and
  releases scheduler capacity plus generated delivery work after explicit
  cancellation, failure, expiry, or shutdown. Cinema and Studio use a finite,
  abortable preparation deadline with bounded exponential polling backoff and
  cancel on source changes, request supersession, app teardown, or timeout.
- Phase 4 generated-fixture checks cover scheduler, grants, ingress, activation,
  signed generated-delivery lifecycle, ticketed HLS playlist and segment
  delivery, federated playback state, account isolation, and exact-replica
  failover contracts. Real-tailnet Direct
  and DERP playback, simultaneous load distribution, browser CORS, grant expiry
  and revocation, shard-loss resume tolerance, and URL/log leakage checks remain
  operator verification. Do not claim production tailnet readiness; see
  `docs/media-sharding-implementation-plan.md`.
- Phase 5 now has owner-only Settings / Cluster controls for persistent display
  aliases, `-100..100` scheduling priority, bounded stream/live-transcode
  capacity, and maintenance drain/undrain. These controls are separate from
  signed identity, survive descriptor refresh and backup/restore, and affect
  only new scheduler admission.
- Phase 5 signing-key rotation is available through the exact owner/service-
  admin `GET|POST /api/admin/cluster/key-rotation` route. It prepares a bounded
  successor key with every active peer before local activation, commits with
  the successor key, rejects the old key per peer after confirmation, and can
  resume its persisted SQLite transition after restart or backup restore.
  Rotation status never includes public or private key material. Real-tailnet
  interrupted-transition acceptance remains an operator check.
- Phase 5 aggregate cluster readiness, low-cardinality metrics, bounded clock
  diagnostics, stale-manifest/cooldown reporting, mixed-version rolling tests,
  and backup/restore coverage are implemented. Public readiness stays opaque;
  detailed reasons and rotation controls remain owner/service-admin only.
- Media-sharding Phases 0-5 are implementation-complete. The remaining MVP
  acceptance work is a disposable real-tailnet Direct/DERP multi-node pass.
  Member federation is implemented for the current shared-content library;
  guest federation remains fail-closed, and future multi-library federation
  requires an explicit item-to-library projection. Optional multi-origin HLS
  remains a post-MVP experiment.
