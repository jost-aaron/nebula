# Agent Handoff

This project is a container-first WebGPU dashboard scaffold. Treat it as an
early product shell, not a throwaway demo.

## Start Here

For a fresh session:

1. Confirm you are in `work/nebula-dashboard`.
2. Read this file, then `docs/session-handoff.md`, `README.md`, `docs/architecture.md`,
   `docs/cinema.md`, `docs/files.md`, and `docs/testing.md`.
3. Run the app with `docker compose up --build`.
4. Verify with `docker compose run --rm dashboard npm run check`.
5. Run backend tests with `docker compose run --rm dashboard npm test`.
6. Keep user media in ignored `content/`.

## Prime Directive

Do not install project dependencies or applications on the host system. Use
Docker Compose for development and verification.

Allowed:

```sh
docker compose up --build
docker compose run --rm dashboard npm run check
docker compose down
```

For additional Git worktrees, isolate Docker Compose from the main dashboard
instance by using a unique project name and a free host port:

```sh
export COMPOSE_PROJECT_NAME=nebula-$(basename "$PWD")
export DASHBOARD_PORT=$(python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    print(s.getsockname()[1])
PY
)
docker compose up --build
```

Then open the worktree app at:

```sh
echo "http://127.0.0.1:${DASHBOARD_PORT}"
```

Use the same environment variables for worktree checks and shutdown:

```sh
COMPOSE_PROJECT_NAME=nebula-$(basename "$PWD") DASHBOARD_PORT=$DASHBOARD_PORT docker compose run --rm dashboard npm run check
COMPOSE_PROJECT_NAME=nebula-$(basename "$PWD") DASHBOARD_PORT=$DASHBOARD_PORT docker compose down
```

Do not run side worktrees on the main `5173` port while the main dashboard is
open. If the chosen port collides, stop that worktree and choose another free
port before restarting.

Avoid:

```sh
npm install
npm run dev
npm run build
```

The host tree should not contain `node_modules` or `dist`.

## Current Runtime

- Browser app served by Vite inside Docker.
- Local URL: http://127.0.0.1:5173
- WebGPU renderer is active when `navigator.gpu` and a compatible adapter exist.
- Canvas 2D fallback is used when WebGPU is unavailable.

## Mental Model

The app has these main layers:

1. `src/webgpuRenderer.ts` owns the full-screen GPU/canvas background.
2. `src/main.ts` owns shell DOM rendering and app-surface bindings, while
   `src/shell/` owns typed state, persistence, and shared input commands.
3. `src/apps.ts` owns the list of app entries shown in the dashboard.
4. `src/diagnostics/` owns runtime diagnostic data collection.
5. `src/cinema/` owns the local video library and lazy playback UI.
6. `src/settings/` owns the Settings panel renderer.
7. `src/search/` owns the shared Search UI.
8. `src/library/` owns the installed-app Library grid.
9. `src/files/` owns the local content file browser UI.
10. `src/studio/` owns the local music library and native audio playback UI.
11. `src/account/` and `server/accountStore.mjs` own local accounts, sessions,
    authorization, personal watchlists, and the account gate.
12. `server/catalog/` owns stable media identities, indexed sources, metadata
    records, scan reconciliation, and compatibility projections.
13. `server/playback/` owns per-user playback state, sessions, idempotent events,
    and Continue Watching queries.

The UI is currently framework-free TypeScript. DOM is rendered with template
strings and event listeners. If you introduce a framework later, document why and
keep the migration focused.

## State Model

`src/shell/state.ts` defines three pieces of shell state, held by `src/main.ts`:

- `focusedAppId` - stable ID of the selected app tile.
- `detailAppId` - app detail panel currently open, or `null`.
- `activeAppId` - full-screen app surface currently open, or `null`.

Keyboard behavior:

- Arrow keys move the focused app without wrapping past the first or last app.
- Enter launches the focused app surface.
- Escape closes the active app surface first, otherwise closes detail panels.

Mouse behavior:

- Hovering or clicking a tile changes focus.
- Scrolling over the Applications strip advances selection one app at a time
  after a short gated threshold, without wrapping.
- Click-dragging the Applications strip pans the row without launching apps.
- Double-clicking a tile launches the app surface.
- The primary Open command launches the focused app into the full-screen app
  surface; the details button opens the compact app panel.
- Search is launched from the Applications strip and filters apps by name; Enter
  launches the active result.
- The Applications strip shows installed apps from `src/apps.ts`; clicking one
  focuses it, and opening it launches the full-screen app surface.
- Cinema scans ignored `content/` for Movies and TV Shows. The player is
  hidden until a title is selected.
- Studio scans ignored `content/` for MP3, FLAC, M4A, WAV, AAC, and OGG audio.
- Files browses and manages the ignored `content/` folder through the local API.
- Settings is launched from the Applications strip and uses the shared
  Settings/Diagnostics renderer.

## Current App Surface

- `Cinema` is a dedicated local video browser and player surface. It uses
  `/api/cinema/library`, `/api/cinema/media`, metadata editing, and persistent
  watchlist state.
- `Studio` is a dedicated local music browser and player surface. It uses
  `/api/music/library` and `/api/music/media`.
- `Files` is a ready local content browser. It supports drag/drop uploads,
  progress, cancel, resumable 64 MB chunks for files larger than 64 MB, and
  iOS-compatible Server URL/API token routing.
- `Settings` and `Search` are ready shell/system apps.
- First-run owner setup, sign-in, identity, Account Settings, member
  creation/disable, password changes, and session revocation are ready.
- The media backend indexes the shared content root into stable catalog UUIDs,
  persists authenticated playback progress, and supports account-bound direct,
  remux, progressive HLS, reusable and scheduled renditions, plus owner-managed
  rendition storage policy. Studio reports authenticated playback lifecycle,
  history, completion, and resume state using stable catalog IDs; guest playback
  remains non-persistent.
- `scripts/nebula-server.sh` provides the no-clobber single-host deployment and
  lifecycle CLI over `compose.deploy.yaml`.
- The dormant Tailscale companion supports owner-only enable/disable and
  browser-assisted enrollment under Settings / Remote Access. Preserve the
  fixed-file control/status bridge; never mount Tailscale or Docker sockets into
  the dashboard or enable Funnel.
- `Arcade` and `Party` are still planned placeholders.

## Content And Media

`content/` is intentionally ignored by Git and mounted into Docker at
`/app/content`.

Current known local media used during testing:

- `South Park The Streaming Wars.mp4`, around 441 MB, categorized by Cinema as
  a Movie.

Do not move or commit uploaded content unless the user explicitly asks.

## Known Product Direction

The user wants a modern console-like dashboard, closer to Xbox/PlayStation menu
systems than a web landing page. Future work should preserve:

- Controller-friendly navigation.
- Dense, fast, app-first UI.
- A capable rendering layer.
- A path toward a native-style video player.

## Recent Bug Context

The old Home/Search/Library/Settings rail has been removed. Keep navigation
app-first through the Applications strip unless the user explicitly asks for a
new global navigation surface.

## Verification Checklist

Before handing off changes:

```sh
docker compose run --rm dashboard npm run check
docker compose run --rm dashboard npm test
test ! -d node_modules && test ! -d dist && echo "host clean"
```

The account gate is always active: a new data volume requires deliberate owner
setup. `NEBULA_API_TOKEN` remains a service/admin path. To test it without the
localhost exemption, set `NEBULA_REQUIRE_AUTH=true`, provide the token, and set
`NEBULA_AUTH_ALLOW_LOCALHOST=false` when Compose creates the container. Account
data lives in the `nebula-data` volume, never `content/`.

Browser checks:

- Page loads at http://127.0.0.1:5173.
- GPU status shows either `WebGPU · ...` or `Canvas fallback`.
- Search, Settings, Files, and Cinema are available from the Applications strip.
- Studio is available from the Applications strip as the music app.
- The Applications strip scrolls horizontally, including when focus moves to an
  off-screen app tile.
- App selection follows hover, clamps at both ends for arrow/scroll navigation,
  and uses a gated scroll threshold so the selected app does not race through
  the row.
- Arrow keys, Enter, and Escape work.
- Reload restores the account; Account Settings can update profile/password,
  manage members/devices, and sign out.
- Mobile viewport does not reserve space for a bottom rail.
- iOS safe-area checks should confirm `viewport-fit=cover` and
  `env(safe-area-inset-*)` padding keep content clear of the status/Dynamic
  Island and home-indicator regions.

Media platform changes must also preserve:

- centrally ordered domain migrations in the shared `nebula.sqlite` database;
- stable catalog IDs across duplicate scans, safe renames, and restoration;
- per-user playback isolation and catalog validation of item/source IDs;
- current path-based Cinema and Studio APIs until their catalog projections are
  explicitly migrated and browser-verified.

## Read Next

- `docs/architecture.md`
- `docs/deployment.md`
- `docs/session-handoff.md`
- `docs/cinema.md`
- `docs/studio.md`
- `docs/arcade-moonlight.md`
- `docs/webgpu-renderer.md`
- `docs/files.md`
- `docs/library.md`
- `docs/search.md`
- `docs/settings-diagnostics.md`
- `docs/development.md`
- `docs/testing.md`
- `docs/roadmap.md`
