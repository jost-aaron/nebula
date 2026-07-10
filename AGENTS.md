# Agent Handoff

This project is a container-first WebGPU dashboard scaffold. Treat it as an
early product shell, not a throwaway demo.

## Start Here

For a fresh session:

1. Confirm you are in `work/nebula-dashboard`.
2. Read this file, then `docs/session-handoff.md`, `README.md`, `docs/architecture.md`,
   `docs/cinema.md`, `docs/studio.md`, `docs/arcade-moonlight.md`,
   `docs/files.md`, and `docs/testing.md`.
3. Run the app with `docker compose up --build`.
4. Verify with `docker compose run --rm dashboard npm run check`.
5. Keep user media in ignored `content/`.

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

## Current Development State

Active branch:

```text
codex/archade-moonlight
```

This branch is the large Arcade/Moonlight PR. It has been rebased onto current
`main` after the Studio music move and pushed to `origin/codex/archade-moonlight`.

Product baseline:

- Nebula is past the blank scaffold phase and should be treated as an early
  product shell with real app surfaces.
- The app-first dashboard shell is the primary navigation model. The old
  bottom/global rail has been removed; do not restore it casually.
- Files is the local content manager for ignored `content/` media and supports
  desktop plus iOS-compatible API targeting.
- Cinema is now video-only and should stay focused on Movies and TV Shows.
- Studio is now the dedicated music app for MP3, FLAC, M4A, WAV, AAC, and OGG.
- Settings owns client/server configuration and diagnostics.
- Search remains a shared system app and should stay fast to launch.
- iOS compatibility matters for ordinary web changes: preserve safe-area
  padding, configurable server URLs, API tokens, and API-only CORS.

Near-term direction:

- Keep moving toward a modern console/Plex-like experience: dense, fast,
  controller-friendly, and comfortable on a TV or handheld device.
- Use focused worktrees for larger efforts so multiple agents can work safely
  in parallel without sharing Docker ports or Compose project names.
- Split large shell/app files when doing meaningful refactors, especially
  `src/main.ts`, but avoid framework migrations unless there is a clear product
  reason.
- Protect user media and generated output. Do not commit `content/`,
  `ios/App/App/public`, host `node_modules`, or host `dist`.

Arcade is now a mock/prototype app surface, not just a placeholder:

- `src/arcade/renderArcadeView.ts` renders the full-screen Arcade surface.
- `server/arcade.mjs` exposes the mock `/api/arcade/*` facade.
- `src/api/arcadeApi.ts` and `src/shared/arcadeTypes.ts` define the frontend
  Arcade API client and contracts.
- `src/arcade/inputDiagnostics.ts` reads browser Gamepad API diagnostics.
- `src/arcade/streamRenderer.ts` feature-detects the future
  WebGPU/WebCodecs stream-compositor path.
- `docs/arcade-moonlight.md` and `docs/arcade-sidecar-spike.md` document the
  Moonlight Core sidecar direction.

The current Arcade implementation is intentionally mock-only. It does not pair
with Sunshine, link Moonlight Core, open a native sidecar, decode stream frames,
or forward real controller input to a host yet.

## Mental Model

The app has these main layers:

1. `src/webgpuRenderer.ts` owns the full-screen GPU/canvas background.
2. `src/main.ts` owns shell state and DOM rendering.
3. `src/apps.ts` owns the list of app entries shown in the dashboard.
4. `src/diagnostics/` owns runtime diagnostic data collection.
5. `src/arcade/` owns the mock game-streaming host/session surface.
6. `src/cinema/` owns the local video library and lazy playback UI.
7. `src/settings/` owns the Settings panel renderer.
8. `src/search/` owns the shared Search UI.
9. `src/library/` owns the installed-app Library grid.
10. `src/files/` owns the local content file browser UI.
11. `src/studio/` owns the local music library and native audio playback UI.
12. `server/arcade.mjs` owns the mock Arcade API facade.

The UI is currently framework-free TypeScript. DOM is rendered with template
strings and event listeners. If you introduce a framework later, document why and
keep the migration focused.

## State Model

`src/main.ts` keeps three pieces of shell state:

- `focusedIndex` - selected app tile.
- `launchedApp` - app detail panel currently open, or `null`.
- `activeApp` - full-screen app surface currently open, or `null`.

Keyboard behavior:

- Arrow keys move `focusedIndex` without wrapping past the first or last app.
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
- `Arcade` is a prototype Moonlight/Sunshine-oriented game streaming shell. It
  uses `/api/arcade/hosts`, `/api/arcade/capabilities`,
  `/api/arcade/sessions`, pairing routes, and `/api/arcade/events` for mock
  host/session lifecycle state.
- `Files` is a ready local content browser. It supports drag/drop uploads,
  progress, cancel, resumable 64 MB chunks for files larger than 64 MB, and
  iOS-compatible Server URL/API token routing.
- `Settings` and `Search` are ready shell/system apps.
- `Party` is still a planned placeholder.

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

## Where We Are Going

Near-term Arcade work should harden the large PR rather than jumping straight
to real Moonlight streaming:

- Keep Arcade honest about mock/dev state and sidecar unavailability.
- Finish visual/browser smoke checks across Dashboard, Arcade, Studio, Cinema,
  Files, Settings, Search, and mobile Arcade.
- Update docs when implementation catches up with previously planned items.
- Prepare a clear PR summary that separates real functionality from mock-only
  scaffolding.

The next technical milestone after this PR is a native Moonlight sidecar spike:

- Build a separate local process around `moonlight-common-c`.
- Prove pairing/session startup against a known Sunshine host.
- Translate Moonlight callbacks into product-shaped Arcade events.
- Keep media frame transport separate from the sidecar control channel at first.
- Do not add native dependencies, vendored Moonlight code, generated binaries,
  or host-installed tooling to this Docker-first frontend workflow without a
  deliberate follow-up plan.

## Recent Bug Context

The old Home/Search/Library/Settings rail has been removed. Keep navigation
app-first through the Applications strip unless the user explicitly asks for a
new global navigation surface.

## Verification Checklist

Before handing off changes:

```sh
docker compose run --rm dashboard npm run check
test ! -d node_modules && test ! -d dist && echo "host clean"
```

Browser checks:

- Page loads at http://127.0.0.1:5173.
- GPU status shows either `WebGPU · ...` or `Canvas fallback`.
- Search, Settings, Files, and Cinema are available from the Applications strip.
- Studio is available from the Applications strip as the music app.
- Arcade is available from the Applications strip as a prototype app.
- Arcade loads mock hosts from `/api/arcade/hosts`, shows sidecar unavailable
  status from `/api/arcade/capabilities`, and updates lifecycle events after
  Pair, Stream, and Disconnect actions.
- The Applications strip scrolls horizontally, including when focus moves to an
  off-screen app tile.
- App selection follows hover, clamps at both ends for arrow/scroll navigation,
  and uses a gated scroll threshold so the selected app does not race through
  the row.
- Arrow keys, Enter, and Escape work.
- Mobile viewport does not reserve space for a bottom rail.
- iOS safe-area checks should confirm `viewport-fit=cover` and
  `env(safe-area-inset-*)` padding keep content clear of the status/Dynamic
  Island and home-indicator regions.

## Read Next

- `docs/architecture.md`
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
