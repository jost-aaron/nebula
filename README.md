# Nebula Dashboard

A container-first WebGPU dashboard scaffold inspired by modern console home screens.

The goal is to grow this into a capable dashboard/runtime for multiple apps,
eventually including a native-style video player surface. The current app is a
browser-hosted prototype with a WebGPU background renderer, app registry, shell
navigation, and detail panels.

## Run

```sh
docker compose up --build
```

Open http://127.0.0.1:5173.

## Check

```sh
docker compose run --rm dashboard npm run check
```

Dependencies are installed inside the Docker image. Compose mounts only the source
files needed for local development, so the host project should not need a local
`node_modules` directory.

## Project Map

- `src/main.ts` - dashboard shell, app selection state, rail navigation, panels,
  keyboard/mouse handlers.
- `src/apps.ts` - app registry and app metadata types.
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
- [docs/architecture.md](docs/architecture.md)
- [docs/webgpu-renderer.md](docs/webgpu-renderer.md)
- [docs/development.md](docs/development.md)
- [docs/testing.md](docs/testing.md)
- [docs/roadmap.md](docs/roadmap.md)
