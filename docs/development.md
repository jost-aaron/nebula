# Development Workflow

This project is Docker Compose first. Do not install dependencies on the host.

## Requirements

- Docker
- Docker Compose
- A browser with WebGPU support for the GPU path

The app still works without WebGPU through the Canvas 2D fallback.

## Run Locally

```sh
docker compose up --build
```

Open:

```text
http://127.0.0.1:5173
```

If the container is already running after code changes that affect
`server/dev.mjs`, rebuild/recreate it:

```sh
docker compose up -d --build
```

## Type Check

```sh
docker compose run --rm dashboard npm run check
```

## Stop

```sh
docker compose down
```

## Dependency Policy

Dependencies are installed inside the Docker image via `npm ci`.

Compose mounts only:

- `index.html`
- `package.json`
- `server/`
- `tsconfig.json`
- `src/`
- `content/`

This keeps host `node_modules` and `dist` out of the project folder.
The `content/` folder is mounted for the Files app and is intentionally ignored
by Git. Cinema also scans this folder for local media.

## Local Content

Keep local uploads, test media, and generated partial upload state under:

```text
content/
```

The Files app hides `content/.uploads/` from listings. That folder is used for
resumable upload chunks and should remain ignored.

## Adding Dependencies

If a dependency is needed:

1. Edit `package.json`.
2. Update `package-lock.json` using a containerized npm command, not host npm.
3. Rebuild the image.

Use:

```sh
docker run --rm -v "$PWD":/app -v nebula_npm_tmp:/app/node_modules -w /app node:25-alpine npm install <package>
docker compose build
```

Then verify:

```sh
docker compose run --rm dashboard npm run check
test ! -d node_modules && test ! -d dist && echo "host clean"
```

## Coding Style

- Keep files ASCII unless there is a clear reason to do otherwise.
- Keep comments rare and useful.
- Prefer deterministic render functions.
- Do not append UI nodes in repeated render paths unless duplicates are intended.
- Preserve controller-friendly interaction.
- Use existing visual language before adding new UI patterns.

## Browser Support Notes

WebGPU requires a secure context, but localhost qualifies. Expect:

- WebGPU path on modern supported browsers/devices.
- Canvas fallback elsewhere.

Always feature-detect. Do not assume WebGPU is present.

## Arcade And Moonlight Notes

Arcade should start as a browser app surface for host/session setup, mock
connection lifecycle, stream preferences, controller diagnostics, and clear
sidecar-unavailable states. Do not present real Moonlight streaming as available
until a native sidecar/plugin or equivalent bridge exists.

Follow `docs/arcade-moonlight.md` for the intended split:

- Browser frontend: host cards, pairing flow, settings, diagnostics, overlays,
  and future WebGPU presentation.
- Backend facade: current mock `/api/arcade/*` host, capability, pairing,
  session, and event routes in `server/arcade.mjs`.
- Native sidecar/plugin: future Moonlight Core integration, sockets, decode or
  frame forwarding, audio, and input forwarding.

Keep the current boundary explicit: the mock facade is useful for frontend and
lifecycle work, but it does not discover hosts, create pairing credentials, or
open a Moonlight media session.

Keep Moonlight Core experiments isolated from the normal Docker-first frontend
workflow. Do not add host-installed native dependencies or generated build
artifacts to this repository while spiking the sidecar.

## Mobile Client Notes

The first recommended native target is a Capacitor iOS client. Keep it separate
from normal Docker development:

- Do not install Capacitor dependencies on the host.
- Do not leave ad-hoc host `dist/` output behind.
- Use the Settings app Client tab to configure the API Server URL for mobile or
  private-network clients.
- The iOS wrapper permits local HTTP networking for web content so simulator and
  same-LAN Docker server URLs work during development.
- Use `./scripts/ios-sync.sh` to rebuild and sync the Capacitor iOS wrapper.
- Use `./scripts/ios-sync-dev-server.sh` when the iOS development bundle should
  default to the current Docker server. Set `NEBULA_IOS_DEV_SERVER_URL` for a
  real iPhone LAN URL; otherwise it defaults to `http://127.0.0.1:5173` for the
  simulator.
- Use `./scripts/ios-build-simulator.sh` to compile the iOS simulator app after
  Xcode and an iOS simulator runtime are installed.

See:

```text
docs/mobile-clients.md
```

## API Auth Scaffold

API authentication is off by default for local Docker development.

To require a bearer token for non-local API clients:

```sh
NEBULA_REQUIRE_AUTH=true
NEBULA_API_TOKEN=<long-random-token>
```

By default, localhost requests are still allowed when auth is enabled. To require
the token even for localhost:

```sh
NEBULA_AUTH_ALLOW_LOCALHOST=false
```

Client apps can store the matching token in:

```text
Settings -> Client -> API Token
```
