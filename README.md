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

Nebula starts with deliberate local owner setup and requires an account for the
dashboard. Browser sessions use cookies and CSRF protection; Capacitor uses
revocable bearer sessions. Owners can add or disable members, and Cinema
watchlists are personal. Owners can also limit each member to selected media
libraries without changing the shared Files permission model.

Owners can set global and per-account concurrent stream and bitrate limits in
Settings / Playback. Limits default to unlimited and govern trusted remux and
HLS/transcode delivery. Direct byte-range playback remains outside reliable
stream accounting; see [docs/playback-policies.md](docs/playback-policies.md).
Owners also have a bounded, redacted Activity history for account, authorization,
scan/job, backup, and other server-administration actions.
Accounts can keep ordered video and audio playlists, while owners can publish
shared collections whose visible items follow each member's library grants.

## Local development

```sh
docker compose up --build
```

Open http://127.0.0.1:5173.

This is the source-mounted development stack, not the recommended persistent
deployment shape. For a single-host self-hosted preview, including storage,
security, proxy/TLS, backup/restore, upgrades, monitoring, and release checks,
read [docs/deployment.md](docs/deployment.md) and validate
`compose.deploy.yaml`. The current runtime is not HA or hardened for public
internet exposure.

## Check

```sh
docker compose run --rm dashboard npm run check
docker compose run --rm dashboard npm test
```

Dependencies are installed inside the Docker image. Compose mounts only the source
files needed for local development, so the host project should not need a local
`node_modules` directory.

## Optional Cinema metadata

An owner can add a TMDB API Read Access Token under Settings / Account to enable
Cinema metadata search and matching. `TMDB_API_TOKEN` remains a Docker Compose
fallback. The admin value is stored in the server data volume, is never returned
to the browser after saving, and must not be committed. Cinema remains usable
without either configuration source.

## New Session Quick Start

1. Read [AGENTS.md](AGENTS.md).
2. Start the app with `docker compose up --build`.
3. Open http://127.0.0.1:5173.
4. Verify with `docker compose run --rm dashboard npm run check`.
5. Keep all content/media in ignored `content/`; do not commit uploaded media.
6. Do not install dependencies on the host.

## Project Map

- `src/main.ts` - dashboard DOM rendering, detail panels, and app-surface
  integration.
- `src/shell/` - typed shell state, safe focus persistence, shared input
  commands/gates, and Gamepad API lifecycle.
- `src/apps.ts` - app registry and app metadata types.
- `src/diagnostics/` - renderer, display, runtime, app, and performance
  diagnostics collectors.
- `src/settings/` - shared Settings/Diagnostics panel renderer.
- `src/activity-admin/` - owner-only responsive audit history surface.
- `src/search/` - shared Search UI for the Search app.
- `src/library/` - installed-app Library grid renderer.
- `src/cinema/` - Plex-like local video library and lazy web player.
- `src/studio/` - local music library and native audio player.
- `src/files/` - local content file browser UI.
- `src/api/` - shared API base URL, token, fetch, and XHR helpers.
- `src/account/` - account gate, identity menu, profile, security, member, and
  device/session UI.
- `server/dev.mjs` - Vite dev server plus Files, Cinema, and Music APIs.
- `server/cors.mjs` - API-only CORS handling for Capacitor/mobile clients.
- `server/accountStore.mjs` - SQLite accounts, credentials, sessions,
  throttling, watchlists, and media tickets.
- `server/accounts.mjs` - account and session API routes.
- `server/playbackPolicy/` - persisted generated-stream limits, race-safe
  admission accounting, aggregate status, and stable policy denials.
- `server/audit/` - structured audit migration, retention, redaction, and API.
- `content/` - ignored local content root for Files and Cinema.
- `ios/` - Capacitor iOS shell.
- `scripts/ios-sync*.sh` - Docker-first Capacitor web asset sync helpers.
- `scripts/offline-restore.mjs` - validated, no-clobber offline backup restore.
- `src/webgpuRenderer.ts` - WebGPU full-screen shader renderer plus Canvas 2D
  fallback.
- `src/styles.css` - responsive shell layout and visual system.
- `compose.yaml` - container-first local development entrypoint.
- `compose.deploy.yaml` - locally built, single-host deployment example.
- `.env.example` - placeholder-only deployment configuration reference.
- `Dockerfile` - Node/Vite image used by Compose.
- `AGENTS.md` - handoff notes for another coding model or automation agent.
- `docs/` - deeper architecture, rendering, workflow, testing, and roadmap notes.

## Documentation

Start with:

- [AGENTS.md](AGENTS.md)
- [docs/session-handoff.md](docs/session-handoff.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/deployment.md](docs/deployment.md)
- [docs/accounts.md](docs/accounts.md)
- [docs/cinema.md](docs/cinema.md)
- [docs/studio.md](docs/studio.md)
- [docs/arcade-moonlight.md](docs/arcade-moonlight.md)
- [docs/webgpu-renderer.md](docs/webgpu-renderer.md)
- [docs/files.md](docs/files.md)
- [docs/library.md](docs/library.md)
- [docs/search.md](docs/search.md)
- [docs/settings-diagnostics.md](docs/settings-diagnostics.md)
- [docs/playback-policies.md](docs/playback-policies.md)
- [docs/development.md](docs/development.md)
- [docs/testing.md](docs/testing.md)
- [docs/roadmap.md](docs/roadmap.md)
