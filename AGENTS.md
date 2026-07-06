# Agent Handoff

This project is a container-first WebGPU dashboard scaffold. Treat it as an
early product shell, not a throwaway demo.

## Prime Directive

Do not install project dependencies or applications on the host system. Use
Docker Compose for development and verification.

Allowed:

```sh
docker compose up --build
docker compose run --rm dashboard npm run check
docker compose down
```

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

The app has seven main layers:

1. `src/webgpuRenderer.ts` owns the full-screen GPU/canvas background.
2. `src/main.ts` owns shell state and DOM rendering.
3. `src/apps.ts` owns the list of app entries shown in the dashboard.
4. `src/diagnostics/` owns runtime diagnostic data collection.
5. `src/settings/` owns the Settings panel renderer.
6. `src/search/` owns the shared Search UI.
7. `src/library/` owns the installed-app Library grid.

The UI is currently framework-free TypeScript. DOM is rendered with template
strings and event listeners. If you introduce a framework later, document why and
keep the migration focused.

## State Model

`src/main.ts` keeps four pieces of shell state:

- `focusedIndex` - selected app tile.
- `launchedApp` - app detail panel currently open, or `null`.
- `activeRail` - active rail item: `home`, `search`, `library`, or `settings`.
- `activeApp` - full-screen app surface currently open, or `null`.

Keyboard behavior:

- Arrow keys cycle `focusedIndex`.
- Enter launches the focused app surface.
- Escape closes the active app surface first, otherwise closes panels and returns
  the rail to Home.

Mouse behavior:

- Clicking a tile changes focus.
- Double-clicking a tile launches the app surface.
- The primary Open command launches the focused app into the full-screen app
  surface; the details button opens the compact app panel.
- Rail buttons open shell panels or return Home.
- Sidebar Search and the Search app both filter apps by name; Enter launches the
  active result.
- Library shows all installed apps from `src/apps.ts`; clicking one launches it.
- Sidebar Settings and the Settings app use the same Settings/Diagnostics
  renderer.

## Known Product Direction

The user wants a modern console-like dashboard, closer to Xbox/PlayStation menu
systems than a web landing page. Future work should preserve:

- Controller-friendly navigation.
- Dense, fast, app-first UI.
- A capable rendering layer.
- A path toward a native-style video player.

## Recent Bug Context

Rail icons are rendered once by `renderRailIcons()` using `replaceChildren(...)`.
Do not move icon creation into repeated panel or grid render paths; that caused
icons to appear late and duplicate during clicks.

## Verification Checklist

Before handing off changes:

```sh
docker compose run --rm dashboard npm run check
test ! -d node_modules && test ! -d dist && echo "host clean"
```

Browser checks:

- Page loads at http://127.0.0.1:5173.
- GPU status shows either `WebGPU · ...` or `Canvas fallback`.
- Four rail icons are visible.
- Rail buttons do not duplicate SVGs after repeated clicks.
- Arrow keys, Enter, and Escape work.
- Mobile viewport does not overlap bottom rail and detail panel.

## Read Next

- `docs/architecture.md`
- `docs/webgpu-renderer.md`
- `docs/library.md`
- `docs/search.md`
- `docs/settings-diagnostics.md`
- `docs/development.md`
- `docs/testing.md`
- `docs/roadmap.md`
