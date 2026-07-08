# Testing And QA

There is no automated browser test suite yet. Current verification is a mix of
TypeScript checking and manual/in-browser QA.

## Required Check

```sh
docker compose run --rm dashboard npm run check
```

## API Smoke Checks

```sh
curl -s http://127.0.0.1:5173/api/files
curl -s http://127.0.0.1:5173/api/cinema/library
curl -s -I -H "Range: bytes=0-1023" "http://127.0.0.1:5173/api/cinema/media?path=South%20Park%20The%20Streaming%20Wars.mp4"
```

The Cinema media range request should return `206 Partial Content` when that
test file is present.

## Host Clean Check

```sh
test ! -d node_modules && test ! -d dist && echo "host clean"
```

## Manual Browser Smoke Test

Open:

```text
http://127.0.0.1:5173
```

Check:

- Dashboard heading is visible.
- GPU status says either `WebGPU · ...` or `Canvas fallback`.
- App strip shows Cinema, Arcade, Studio, Party, Settings, and Search.
- App strip includes Files.
- Clicking a tile updates the featured app.
- Double-clicking a tile launches the app surface.
- Open expands the focused app into the full-screen app surface.
- The details button opens the focused app detail panel.
- Escape closes the full-screen app surface.
- Close button hides the panel.
- The Search app filters apps by name and Enter launches the active result.
- Settings opens from the Applications strip and shows diagnostics.
- Cinema opens the local media browser and shows supported videos from
  `content/`.
- Cinema shows Movies, TV Shows, and Music category tabs.
- Cinema keeps the player hidden until a title is selected.
- Cinema can load selected media into the web player and the media endpoint
  supports byte-range requests.
- Cinema Music opens MP3 and FLAC entries in a dedicated music detail view
  without a large black video frame.
- Cinema Music Play opens the dedicated music player with native audio controls,
  title metadata, artwork/fallback art, server/status information, and next-up
  queue.
- Cinema Music does not show the fullscreen video command.
- Cinema Music shows a friendly player status if browser playback fails or a
  format is unsupported.
- Cinema video titles still use the normal video player and fullscreen command.
- Cinema Watchlist, More, Edit Details, Back to Library, Details, and Dashboard
  close paths still work for audio titles.
- Files opens the local content browser and is scoped to the ignored `content/`
  folder.
- Files supports upload by button and drag/drop into the current folder.
- Files streams uploads, shows upload progress, and exposes a Cancel button
  while uploading.
- Files uses resumable chunk sessions for files larger than 64 MB.
- Re-selecting the same interrupted large file resumes from uploaded chunks.
- Settings shows Renderer, Display, Performance, Apps, GPU Limits, and Runtime
  diagnostics.

## Keyboard Test

- ArrowRight/ArrowDown moves focus forward and stops on the last app.
- ArrowLeft/ArrowUp moves focus backward and stops on the first app.
- Enter launches the focused app surface.
- Escape closes the active app surface first, otherwise closes detail panels.

## Navigation Regression Test

The old Home/Search/Library/Settings rail was removed in favor of app-first
navigation.

Expected:

- `.rail-button` count is `0`.
- Search and Settings appear as application tiles.
- Opening Search or Settings uses the full-screen app surface.
- Hovering or clicking a tile selects that app.
- The selected app tile is slightly larger than the rest.
- Scrolling over the Applications strip uses a gated threshold: a small scroll
  does not change selection, and a deliberate scroll advances one app at a time.
- Scroll selection does not wrap past the first or last app.
- The Applications strip scrolls horizontally by touch/trackpad and supports
  click-drag panning.
- Keyboard/controller focus scrolls off-screen app tiles into view.

Browser console snippet:

```js
document.querySelectorAll(".rail-button").length;
```

The result should be `0`.

## Responsive Test

At a phone-like viewport, for example `390 x 844`:

- No bottom rail is visible.
- Detail panel does not reserve bottom-rail space.
- Full-screen app surface fits within the viewport.
- Cinema stacks the library and playback panel without overlap.
- Files layout keeps the list and preview usable on phone-sized viewports.
- App strip scrolls horizontally.
- Status pills wrap without text overlap.

## iOS Safe-Area Test

The app is intended to run under Capacitor with `viewport-fit=cover`, so iOS
notches, the Dynamic Island, status indicators, and the home indicator must be
kept clear by CSS safe-area padding.

Verify the source hooks:

- `index.html` includes `viewport-fit=cover`.
- `src/styles.css` defines `--safe-area-top`, `--safe-area-right`,
  `--safe-area-bottom`, and `--safe-area-left`.
- Mobile `.home` padding uses the safe-area variables.
- Cinema `.cinema-shell` padding uses the safe-area variables at desktop,
  tablet, and phone breakpoints.

Command-line simulator smoke test:

```sh
./scripts/ios-sync-dev-server.sh
./scripts/ios-build-simulator.sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl list devices available
```

Use a notched iPhone simulator, such as iPhone 17 Pro, then install and launch
the built app:

```sh
DEVICE_ID=<simulator-udid>
APP_PATH=$(find ~/Library/Developer/Xcode/DerivedData -path '*/Build/Products/Debug-iphonesimulator/App.app' -type d -print | sort | tail -1)
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl boot "$DEVICE_ID" || true
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl bootstatus "$DEVICE_ID" -b
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl install "$DEVICE_ID" "$APP_PATH"
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl launch "$DEVICE_ID" com.nebula.dashboard
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl io "$DEVICE_ID" screenshot /tmp/nebula-ios-safe-area-home.png
```

Expected:

- Dashboard content starts below the Dynamic Island/status bar region.
- The Applications strip remains above the home indicator.
- No bottom rail is present or reserving extra space.
- Native screenshot dimensions match the selected simulator display.

Current command-line `simctl` can screenshot the launched dashboard, but it does
not provide tap automation in this setup. Use a quick manual simulator pass for
Cinema and Files surfaces after major layout changes.

## Future Automated Tests

Good next additions:

- Playwright smoke test in Docker.
- DOM tests for app-first navigation and panel state transitions.
- Visual screenshot checks for desktop and mobile.
- A repeatable iOS simulator UI test that taps through Cinema and Files safe
  areas.
- WebGPU capability test that accepts both WebGPU and Canvas fallback modes.
