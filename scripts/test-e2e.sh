#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
run_id="$(date +%s)-$$"
run_root="$root_dir/.tmp/e2e/$run_id"
export COMPOSE_PROJECT_NAME="nebula-e2e-$run_id"
export E2E_RUN_ID="$run_id"
export DASHBOARD_PORT="${DASHBOARD_PORT:-$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)}"
export E2E_CONTENT_DIR="$run_root/content"
export E2E_DATA_DIR="$run_root/data"

compose() {
  docker compose -f "$root_dir/compose.yaml" -f "$root_dir/compose.e2e.yaml" "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$run_root"
}
trap cleanup EXIT INT TERM

mkdir -p "$E2E_CONTENT_DIR/Movies" "$E2E_CONTENT_DIR/Music" "$E2E_DATA_DIR" "$root_dir/playwright-report" "$root_dir/test-results"
printf 'WEBVTT\n\n00:00.000 --> 00:01.000\nNebula subtitle fixture\n' > "$E2E_CONTENT_DIR/Movies/E2E Movie.en.default.vtt"
printf 'Nebula Playwright fixture\n' > "$E2E_CONTENT_DIR/fixture-note.txt"

echo "Playwright dashboard: http://127.0.0.1:$DASHBOARD_PORT"
compose build dashboard
compose run --rm --no-deps dashboard ffmpeg -nostdin -v error \
  -f lavfi -i color=c=blue:s=320x180:r=24:d=4 \
  -f lavfi -i sine=frequency=440:sample_rate=48000:duration=4 \
  -c:v libvpx-vp9 -pix_fmt yuv420p -c:a libopus -y \
  "/app/content/Movies/E2E Movie.webm"
compose run --rm --no-deps dashboard ffmpeg -nostdin -v error \
  -f lavfi -i sine=frequency=523.25:sample_rate=48000:duration=18 \
  -c:a libmp3lame -b:a 128k -metadata title="E2E Track" -metadata artist="Nebula Tests" -y \
  "/app/content/Music/E2E Track.mp3"
compose up --detach dashboard

attempt=0
until compose exec -T dashboard node -e "fetch('http://127.0.0.1:5173/api/auth/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    compose logs dashboard
    exit 1
  fi
  sleep 1
done

compose run --rm playwright npm run test:e2e -- "$@"
