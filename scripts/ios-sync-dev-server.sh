#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

DASHBOARD_PORT=${DASHBOARD_PORT:-5173}
NEBULA_IOS_DEV_SERVER_URL=${NEBULA_IOS_DEV_SERVER_URL:-http://127.0.0.1:${DASHBOARD_PORT}}

printf 'Syncing iOS app with default server URL: %s\n' "$NEBULA_IOS_DEV_SERVER_URL"

docker run --rm \
  -e VITE_API_BASE_URL="$NEBULA_IOS_DEV_SERVER_URL" \
  -v "$PWD":/app \
  -v nebula_npm_tmp:/app/node_modules \
  -w /app \
  node:25-alpine \
  npm run build

docker run --rm \
  -v "$PWD":/app \
  -v nebula_npm_tmp:/app/node_modules \
  -w /app \
  node:25-alpine \
  npx cap sync ios

rm -rf dist
rmdir node_modules 2>/dev/null || true
