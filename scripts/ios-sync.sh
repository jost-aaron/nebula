#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

docker run --rm \
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
