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
- `tsconfig.json`
- `src/`

This keeps host `node_modules` and `dist` out of the project folder.

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
