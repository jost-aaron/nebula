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

## Mobile Client Notes

The first recommended native target is a Capacitor iOS client. Keep it separate
from normal Docker development:

- Do not install Capacitor dependencies on the host.
- Do not leave ad-hoc host `dist/` output behind.
- Use the Settings app Client tab to configure the API Server URL for mobile or
  private-network clients.
- Use `./scripts/ios-sync.sh` to rebuild and sync the Capacitor iOS wrapper.
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
