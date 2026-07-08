#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
IOS_DESTINATION=${IOS_DESTINATION:-generic/platform=iOS Simulator}

DEVELOPER_DIR="$DEVELOPER_DIR" xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Debug \
  -destination "$IOS_DESTINATION" \
  build
