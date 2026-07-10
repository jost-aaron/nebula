# Nebula Dashboard

A container-first WebGPU dashboard scaffold inspired by modern console home screens.

The goal is to grow this into a capable dashboard/runtime for multiple apps,
eventually including a native-style video player surface. The current app is a
browser-hosted prototype with a WebGPU background renderer, app registry, shell
navigation, Search, Library, Settings/Diagnostics, detail panels, and animated
full-screen app launch surfaces. It also has product-shaped Files, Cinema, and
Studio apps: Files manages local ignored content with resumable uploads and iOS
client support, Cinema scans video into a Plex-like Movies/TV Shows library, and
Studio scans local audio into a dedicated music player.

## Run

```sh
docker compose up --build
```

Open http://127.0.0.1:5173.

## Check

```sh
docker compose run --rm dashboard npm run check
docker compose run --rm dashboard npm test
```

Dependencies are installed inside the Docker image. Compose mounts only the source
files needed for local development, so the host project should not need a local
`node_modules` directory.

## New Session Quick Start

1. Read [AGENTS.md](AGENTS.md).
2. Start the app with `docker compose up --build`.
3. Open http://127.0.0.1:5173.
4. Verify with `docker compose run --rm dashboard npm run check`.
5. Keep all content/media in ignored `content/`; do not commit uploaded media.
6. Do not install dependencies on the host.

## Project Map

- `src/main.ts` - dashboard shell, app selection state, detail panels,
  full-screen app launch surfaces, keyboard/mouse handlers.
- `src/apps.ts` - app registry and app metadata types.
- `src/diagnostics/` - renderer, display, runtime, app, and performance
  diagnostics collectors.
- `src/settings/` - shared Settings/Diagnostics panel renderer.
- `src/search/` - shared Search UI for the Search app.
- `src/library/` - installed-app Library grid renderer.
- `src/cinema/` - Plex-like local video library and lazy web player.
- `src/studio/` - local music library and native audio player.
- `src/files/` - local content file browser UI.
- `src/api/` - shared API base URL, token, fetch, and XHR helpers.
- `server/dev.mjs` - Vite dev server plus Files, Cinema, and Music APIs.
- `server/cors.mjs` - API-only CORS handling for Capacitor/mobile clients.
- `content/` - ignored local content root for Files and Cinema.
- `ios/` - Capacitor iOS shell.
- `scripts/ios-sync*.sh` - Docker-first Capacitor web asset sync helpers.
- `src/webgpuRenderer.ts` - WebGPU full-screen shader renderer plus Canvas 2D
  fallback.
- `src/styles.css` - responsive shell layout and visual system.
- `compose.yaml` - container-first local development entrypoint.
- `Dockerfile` - Node/Vite image used by Compose.
- `AGENTS.md` - handoff notes for another coding model or automation agent.
- `docs/` - deeper architecture, rendering, workflow, testing, and roadmap notes.

## Documentation

Start with:

- [AGENTS.md](AGENTS.md)
- [docs/session-handoff.md](docs/session-handoff.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/cinema.md](docs/cinema.md)
- [docs/studio.md](docs/studio.md)
- [docs/arcade-moonlight.md](docs/arcade-moonlight.md)
- [docs/webgpu-renderer.md](docs/webgpu-renderer.md)
- [docs/files.md](docs/files.md)
- [docs/library.md](docs/library.md)
- [docs/search.md](docs/search.md)
- [docs/settings-diagnostics.md](docs/settings-diagnostics.md)
- [docs/development.md](docs/development.md)
- [docs/testing.md](docs/testing.md)
- [docs/roadmap.md](docs/roadmap.md)
