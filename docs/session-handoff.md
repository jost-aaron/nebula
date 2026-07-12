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
- Search app.
- Applications grid.
- Shared Settings/Diagnostics app.
- Files app for ignored local content under `content/`, with a Variant 2
  console-style layout and iOS-compatible API targeting.
- Cinema app with a dedicated full-screen video surface, browsing-first library,
  title details, watchlist, chapters, next-up rails, and lazy playback.
- Studio app with a dedicated full-screen music surface, searchable audio
  library, queue, selected-track summary, and native audio playback.
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
- Wave 4 bounded structured audit history with owner/service-admin APIs and an
  owner-only responsive Settings Activity surface.

The latest user direction is to keep building toward a modern console/Plex-like
media dashboard.

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

- A fresh `nebula-data` volume deliberately enters owner setup; there is no
  default password.
- Browser sessions use HttpOnly cookies plus CSRF. Capacitor/cross-origin
  sessions use bearer auth, with an acknowledged local-storage limitation.
- Account SQLite data is separate from `content/` at `/app/data/nebula.sqlite`.
- Owners can add/disable members. Members have shared media and Files read
  access but not Files mutations or shared Cinema metadata editing.
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
- Cinema and Studio still use their compatibility path APIs. Catalog-backed UI,
  playback lifecycle reporting, and Continue Watching presentation are active
  in Cinema while path playback remains as a compatibility fallback.
- Cinema now prefers `/api/playback/delivery-sessions` for same-origin stable-ID
  playback and falls back to its existing ticketed path URL if planning fails.

Studio:

- Uses `/api/music/library` to scan `content/` for audio files.
- Uses `/api/music/media?path=<path>` for range-enabled native audio playback.
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

- No automated browser test suite yet.
- Command-line simulator testing currently screenshots the launched dashboard,
  but tap-through Cinema/Files safe-area checks still need a manual simulator
  pass.
- TMDB matching is explicit and optional; automatic enrichment and artwork
  caching are not yet orchestrated in background jobs.
- Cinema thumbnails are generated client-side, not persisted.
- Playback progress persistence exists behind the new API, but Cinema and
  Studio do not report playback events yet.
- No password reset, MFA/passkeys, account deletion/role changes, second owner,
  folder-level Files ACLs, or Keychain-backed native token storage yet.
- `src/main.ts` is growing and should eventually be split into shell modules.
