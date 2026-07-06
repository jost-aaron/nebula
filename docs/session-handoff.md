# Session Handoff

Use this file when starting a new Codex session on this project.

## Current Location

```text
/Users/josta/Documents/Codex/2026-07-05/i-w/work/nebula-dashboard
```

## Current State

Nebula Dashboard is a Docker Compose first browser dashboard/runtime prototype.
The current app includes:

- WebGPU animated background with Canvas fallback.
- Console-like app shell with rail navigation and full-screen app launch
  animation.
- Search app and sidebar search.
- Library app grid.
- Shared Settings/Diagnostics app and sidebar panel.
- Files app for ignored local content under `content/`.
- Cinema app with Movies, TV Shows, and Music tabs plus lazy playback.

The latest user direction is to keep building toward a modern console/Plex-like
media dashboard.

## Must Follow

- Do not install dependencies or applications on the host.
- Use Docker Compose for running and checking.
- Keep uploaded content/media in ignored `content/`.
- Do not commit media files.

## Run And Verify

```sh
docker compose up --build
docker compose run --rm dashboard npm run check
test ! -d node_modules && test ! -d dist && echo "host clean"
```

Open:

```text
http://127.0.0.1:5173
```

## Current Local Media

The ignored `content/` folder currently contains a large MP4 used for Cinema
testing:

```text
South Park The Streaming Wars.mp4
```

Cinema categorizes it as a Movie. It is intentionally not tracked by Git.

## Key Feature Notes

Files:

- Uses `/api/files/*`.
- Supports drag/drop upload.
- Uses streamed upload for small files.
- Uses resumable 64 MB chunks for files larger than 64 MB.
- Stores partial upload sessions under hidden `content/.uploads/`.

Cinema:

- Uses `/api/cinema/library` to scan `content/`.
- Uses `/api/cinema/media?path=<path>` for range-enabled playback.
- Categories are heuristic:
  - Audio files go to Music.
  - `TV`, `Shows`, `Series`, `S01E01`, or `1x01` video files go to TV Shows.
  - Other videos go to Movies.
- The player is hidden until the user selects a title.

## Good First Reads

Read these in order:

1. `AGENTS.md`
2. `README.md`
3. `docs/architecture.md`
4. `docs/cinema.md`
5. `docs/files.md`
6. `docs/testing.md`
7. `docs/development.md`

## Recent Verification

At handoff time:

- `docker compose run --rm dashboard npm run check` passed.
- `content/` is ignored by Git.
- Host tree had no `node_modules` or `dist`.
- Cinema API returned the uploaded MP4 as a Movie.
- Cinema media endpoint returned `206 Partial Content` for range requests.

## Known Gaps

- No automated browser test suite yet.
- Cinema metadata is local and heuristic, not scraped.
- Cinema thumbnails are generated client-side, not persisted.
- Watch progress is not persisted.
- `src/main.ts` is growing and should eventually be split into shell modules.
