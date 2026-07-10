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
- Arcade app with a full-screen Moonlight-oriented host/session prototype,
  mock `/api/arcade/*` lifecycle facade, controller diagnostics, and a
  WebGPU/WebCodecs capability probe.

The active large-PR branch is `codex/archade-moonlight`. It is rebased onto
current `main` and pushed to `origin/codex/archade-moonlight`.

The latest user direction is to keep building toward a modern console/Plex-like
media dashboard.

## Must Follow

- Do not install dependencies or applications on the host.
- Use Docker Compose for running and checking.
- Keep uploaded content/media in ignored `content/`.
- Do not commit media files.

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

Studio:

- Uses `/api/music/library` to scan `content/` for audio files.
- Uses `/api/music/media?path=<path>` for range-enabled native audio playback.
- Supports MP3, FLAC, M4A, WAV, AAC, and OGG files through the local content
  policy.
- Shows local audio in Studio, not Cinema.

Arcade:

- Uses `/api/arcade/hosts`, `/api/arcade/capabilities`,
  `/api/arcade/sessions`, pairing routes, and `/api/arcade/events`.
- The API and UI are intentionally mock-only. Pair, Connect, Stream, and
  Disconnect exercise product-shaped state but do not contact Sunshine.
- Reports the native sidecar as unavailable and does not claim a real stream.
- Feature-detects WebGPU, WebCodecs, `VideoFrame`, and external texture import
  for the future stream compositor path.
- The next technical milestone is the isolated native sidecar spike documented
  in `docs/arcade-sidecar-spike.md`, after this PR is reviewed and hardened.

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

## Recent Verification

At handoff time:

- `docker compose run --rm dashboard npm run check` passed.
- The large Arcade branch was clean and synchronized with its remote before the
  final documentation hardening commit.
- Dashboard, Arcade, Studio, Cinema, Files, Settings, and Search all launched in
  the in-app browser after the branch rebase.
- Arcade loaded its mock host and capabilities, reported the sidecar as
  unavailable, and emitted pairing, session-created, and session-deleted events.
- Arcade Pair, Stream, Disconnect, Dashboard, close, Search-to-Arcade, and
  Escape close paths passed.
- Arcade had no horizontal overflow at a 390 x 844 viewport.
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
- Arcade has no real Moonlight sidecar, Sunshine pairing, media transport,
  decoder pipeline, audio output, or host input forwarding yet.
- Command-line simulator testing currently screenshots the launched dashboard,
  but tap-through Cinema/Files safe-area checks still need a manual simulator
  pass.
- Cinema metadata is local and heuristic, not scraped.
- Cinema thumbnails are generated client-side, not persisted.
- Watch progress is not persisted.
- `src/main.ts` is growing and should eventually be split into shell modules.
