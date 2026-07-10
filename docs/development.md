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

## Backend Tests

```sh
docker compose run --rm dashboard npm test
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
- the `nebula-data` named volume at `/app/data`

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

## Accounts And Service Authentication

Account authentication is active on every server. A new `nebula-data` volume
starts at first-owner setup; no account or password is generated silently.
SQLite data persists at `/app/data/nebula.sqlite` and must not be committed.

The older service-token path remains available for automation and server
administration. Compose passes its three settings into the dashboard container:

```sh
NEBULA_REQUIRE_AUTH=true \
NEBULA_API_TOKEN='<long-random-token>' \
docker compose up --build
```

By default, localhost requests are still allowed when auth is enabled. To require
the token even for localhost:

```sh
NEBULA_REQUIRE_AUTH=true \
NEBULA_API_TOKEN='<long-random-token>' \
NEBULA_AUTH_ALLOW_LOCALHOST=false \
docker compose up --build
```

With the localhost exemption disabled, verify the container actually requires
the token:

```sh
curl -i http://127.0.0.1:5173/api/server/info
curl -i -H 'Authorization: Bearer <long-random-token>' \
  http://127.0.0.1:5173/api/server/info
```

The first request should return `401`; the second should return `200`. The
localhost decision uses only the connection's socket address and never the
request `Host` header.

JSON API bodies are limited to 1 MiB. Raw `PUT` upload and resumable chunk
streams are not JSON-parsed and retain their streaming behavior.

Client apps may still store the matching service token in:

```text
Settings -> Client -> API Token
```

Normal users should sign in through the account UI. Same-origin browser
sessions use HttpOnly cookies and CSRF; native/cross-origin clients receive a
revocable account bearer token. See `docs/accounts.md`.
