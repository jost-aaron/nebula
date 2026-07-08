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
curl -s http://127.0.0.1:5173/api/music/library
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
- Cinema opens the local video browser and shows supported videos from
  `content/`.
- Cinema has a visible Dashboard command that returns to the main dashboard.
- Cinema shows Movies and TV Shows category tabs.
- Cinema keeps the player hidden until a title is selected.
- Cinema can load selected media into the web player and the media endpoint
  supports byte-range requests.
- Cinema does not show MP3, FLAC, M4A, WAV, AAC, or OGG files as Cinema titles.
- Studio opens the local music browser and shows supported audio from
  `content/`.
- Studio groups tracks by artist first, then album; untagged tracks remain
  individual tiles.
- Studio search filters tracks by title, artist, album, folder, and genre.
- Studio track selection shows a music-specific detail/player UI with album
  art/fallback art, title metadata, server/status information, and next-up queue.
- Studio playback uses native `<audio data-studio-player controls>` and no
  large black video frame.
- Studio shows a friendly player status if browser playback fails or a format
  is unsupported.
- Cinema video titles still use the normal video player and fullscreen command.
- Cinema Watchlist, More, Edit Details, Back to Library, Details, and Dashboard
  close paths still work for video titles.
- Files opens the local content browser and is scoped to the ignored `content/`
  folder.
- Files supports upload by button and drag/drop into the current folder.
- Files streams uploads, shows upload progress, and exposes a Cancel button
  while uploading.
- Files uses resumable chunk sessions for files larger than 64 MB.
- Re-selecting the same interrupted large file resumes from uploaded chunks.
- Settings shows Renderer, Display, Performance, Apps, GPU Limits, and Runtime
  diagnostics.

## Arcade Planned Surface Smoke Test

Arcade is currently planned work. Use this checklist after the first Arcade app
surface lands; until then, the app tile may remain a placeholder and real
Moonlight streaming should not be expected.

Expected once implemented:

- Arcade appears in the Applications strip and launches through the same
  app-first full-screen surface as other apps.
- Arcade has an obvious Dashboard or close command that returns to the main
  dashboard without adding a new global navigation rail.
- The surface shows host cards for mock/dev hosts, including at least one
  unavailable or unknown host state.
- Host cards expose product-shaped states such as unpaired, paired, online,
  connecting, streaming, poor connection, disconnected, and offline without
  claiming a real Moonlight stream is active.
- Add Host, Pair, Test Connection, and Start/Stop Session controls are visible
  or intentionally disabled based on the mock state.
- Stream settings are visible for resolution, FPS, bitrate, codec, HDR, and
  audio mode, and the UI makes clear these are preferences for a future
  Moonlight session.
- The sidecar unavailable state is friendly and explicit when no native
  Moonlight sidecar/plugin is connected.
- Controller diagnostics show browser Gamepad API availability, connected
  controllers, button/axis activity, mapping, and timestamp when supported.
- Keyboard/controller navigation can move through host cards, settings, and
  diagnostics without trapping focus.
- Escape closes the Arcade surface and returns to the dashboard.
- WebGPU/WebCodecs capability messaging is informational only; Arcade remains
  usable as a setup/control surface when those capabilities are missing.

Future backend checks after `server/arcade.mjs` exists:

- `GET /api/arcade/capabilities` reports whether the Moonlight sidecar is
  unavailable, mock-only, or connected.
- `GET /api/arcade/hosts` returns mock/dev hosts before real pairing support
  exists.
- Session APIs return clear unavailable/not-implemented responses when the
  sidecar is absent.
- No API response implies that live Moonlight streaming exists before the
  bridge is implemented.

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
- Arcade host cards, stream settings, sidecar unavailable state, and controller
  diagnostics stack without overlap once the Arcade surface exists.
- Cinema stacks the library and playback panel without overlap.
- Studio stacks the music library and player without overlap.
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
- Arcade DOM tests for host cards, mock lifecycle states, stream settings,
  controller diagnostics, and sidecar-unavailable messaging.
- Visual screenshot checks for desktop and mobile.
- A repeatable iOS simulator UI test that taps through Cinema and Files safe
  areas.
- WebGPU capability test that accepts both WebGPU and Canvas fallback modes.
