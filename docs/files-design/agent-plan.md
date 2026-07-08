# Agent Plan: Files Variant 2 Worktree

## Goal

Implement the Files app redesign inspired by:

```text
docs/files-design/nebula-files-variant-2-concept.png
```

Use the design philosophy in:

```text
docs/files-design/README.md
```

The target product shape is a three-zone Files app:

- Left column: file sections plus total storage.
- Center area: large controller-friendly file and folder cards.
- Right pane: selected-file summary, preview, metadata, and actions.

## Worktree Setup

From the main repo work directory:

```sh
cd /Users/josta/Documents/Codex/2026-07-05/i-w/work/nebula-dashboard
git worktree add ../nebula-files-work -b codex/files-variant-2 main
```

Then start the agent in:

```text
/Users/josta/Documents/Codex/2026-07-05/i-w/work/nebula-files-work
```

## Required Agent Prompt

```text
Work in:

/Users/josta/Documents/Codex/2026-07-05/i-w/work/nebula-files-work

Branch:

codex/files-variant-2

Read AGENTS.md first, then docs/session-handoff.md, README.md,
docs/architecture.md, docs/files.md, docs/testing.md,
docs/files-design/README.md, and docs/files-design/agent-plan.md.

Redesign the Files app toward the Variant 2 concept image:

docs/files-design/nebula-files-variant-2-concept.png

Preserve the existing local API, uploads, progress, cancel, resumable chunks,
and content folder behavior. Keep the implementation framework-free TypeScript.
Use Docker Compose only. Do not install host dependencies.
```

## Isolated Docker Run

The worktree must not collide with the main dashboard on port `5173`.

Inside the worktree:

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

Open:

```sh
echo "http://127.0.0.1:${DASHBOARD_PORT}"
```

Use the same `COMPOSE_PROJECT_NAME` and `DASHBOARD_PORT` for checks and
shutdown.

## Implementation Sequence

1. Audit the current Files app structure and identify render/state boundaries.
2. Preserve API calls and behavior before changing layout.
3. Build the three-zone layout with responsive desktop/mobile behavior.
4. Add section navigation for Files, Movies, TV Shows, Music, Uploads, Recent.
5. Add a storage module using available data first; use clearly marked fallback
   values only if storage totals are not yet exposed by the API.
6. Convert the main file area to large cards with strong focused states.
7. Add the right selected-file summary pane with preview, metadata, and actions.
8. Verify keyboard/controller flow: arrows, Enter, Escape, and destructive
   confirmation.
9. Verify uploads still work, including large-file chunk behavior.
10. Update docs if behavior or architecture changes.

## Verification

Run:

```sh
COMPOSE_PROJECT_NAME=nebula-$(basename "$PWD") DASHBOARD_PORT=$DASHBOARD_PORT docker compose run --rm dashboard npm run check
test ! -d node_modules && test ! -d dist && echo "host clean"
```

Browser checks:

- Worktree app loads on the assigned `DASHBOARD_PORT`, not `5173`.
- Files app shows left sections, storage, central file cards, and right summary.
- Arrow keys, Enter, and Escape work inside Files.
- Upload, cancel, and progress still work.
- Large files still use resumable chunks.
- Mobile viewport remains usable with no bottom rail overlap.

## Handoff

Before handing back:

- Summarize changed files and behavior.
- Include the assigned local URL used for browser checks.
- Mention any storage data that is mocked, estimated, or not yet API-backed.
- Do not move or commit `content/` media.

