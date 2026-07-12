# Testing And QA

There is no automated browser test suite yet. Current verification is a mix of
TypeScript checking and manual/in-browser QA.

## Required Check

```sh
docker compose run --rm dashboard npm run check
docker compose run --rm dashboard npm test
```

The Node test suite runs inside Docker and covers authentication (including
forged Host headers and localhost policy), bearer tokens, CORS and Capacitor
preflights, bounded/malformed JSON, resumable upload races and chunk bounds, and
Cinema/Studio byte ranges.
It also includes native-session source contracts for Keychain accessibility,
legacy local-storage removal, server scoping, and fail-closed cleanup.

Account coverage also includes salted scrypt verification, setup exactly once,
first-run guest eligibility, irreversible owner initialization, local-only
entry, in-memory expiration/restart loss, guest capability denial, media-ticket
isolation, and atomic guest revocation during owner setup,
SQLite persistence, generic/throttled login failure, disabled members, cookie
and native bearer sessions, expiration/logout/revocation/password rotation,
CSRF, owner/member capabilities, legacy service tokens, protected JSON and
media ranges, Files streaming/resumable uploads, per-user watchlists, legacy
watchlist migration, media-ticket revocation, provider-neutral library policy
migration, owner-only library administration, cross-member library isolation,
non-disclosing catalog/compatibility denials, ticket re-authorization, and
unchanged Files reads.

Media-platform coverage includes centrally composed migrations, stable catalog
UUIDs, duplicate/change/rename/missing/restore reconciliation, legacy metadata
import, shared episode provider IDs, playback lifecycle validation, idempotent
events, progress coalescing, Continue Watching, cross-user isolation, and
catalog validation of playback item/source pairs.
Wave 2 coverage also includes persistent job recovery and FIFO claiming,
container FFprobe availability, bounded subprocess failures, path/symlink
safety, normalized stream metadata, enriched catalog responses, and explicit
watched-state updates without synthetic sessions.
Wave 4 library-permission coverage additionally exercises playback-state
filtering and writes, planner denial, delivery admission, and active-session
denial after a grant is removed.
Wave 4 audit coverage includes idempotent migration, count/age retention,
allowlisted write/read redaction, best-effort storage failure, cursor pagination,
filter validation, owner/service-admin access, member denial, safe seam capture,
and desktop plus 390×844 Settings Activity layout contracts.
Wave 4 media-list coverage includes idempotent migration, naming and media-kind
validation, duplicate rejection, atomic ordering, unavailable-item retention,
owner-only collection mutation, playlist cross-user isolation, library grant
filtering, and path-free API projections. Cinema and Studio source contracts
cover focused stable-ID save controls and 390×844 responsive behavior.

## API Smoke Checks

```sh
curl -s http://127.0.0.1:5173/api/files
curl -s http://127.0.0.1:5173/api/cinema/library
curl -s http://127.0.0.1:5173/api/music/library
curl -s http://127.0.0.1:5173/api/catalog/items
curl -s http://127.0.0.1:5173/api/playback/continue-watching
curl -s http://127.0.0.1:5173/healthz
curl -s -i http://127.0.0.1:5173/readyz
curl -s -I -H "Range: bytes=0-1023" "http://127.0.0.1:5173/api/cinema/media?path=South%20Park%20The%20Streaming%20Wars.mp4"
```

The Cinema media range request should return `206 Partial Content` when that
test file is present.
`/healthz` should always return `200 {"live":true}` and `/readyz` should return
only `{ "ready": true|false }` with no component details.

## Auth Smoke Check

For normal account testing, use a fresh isolated Compose project/volume. The
first page must show owner setup exactly once; after setup, reload must restore
the cookie session and sign out must return to sign in.

Start a disposable authenticated instance with the localhost exemption turned
off so host curl requests exercise bearer validation:

```sh
NEBULA_REQUIRE_AUTH=true \
NEBULA_API_TOKEN='replace-with-a-long-random-token' \
NEBULA_AUTH_ALLOW_LOCALHOST=false \
docker compose up --build
```

Then verify `401` without the token and `200` with it:

```sh
curl -i http://127.0.0.1:5173/api/server/info
curl -i -H 'Authorization: Bearer replace-with-a-long-random-token' \
  http://127.0.0.1:5173/api/server/info
curl -i -H 'Authorization: Bearer replace-with-a-long-random-token' \
  http://127.0.0.1:5173/api/admin/observability/readiness
curl -i -H 'Authorization: Bearer replace-with-a-long-random-token' \
  http://127.0.0.1:5173/metrics
```

Owner/service admin backup smoke:

```sh
curl -i -H 'Authorization: Bearer replace-with-a-long-random-token' \
  http://127.0.0.1:5173/api/admin/backups
curl -i -H 'Authorization: Bearer replace-with-a-long-random-token' \
  -H 'Content-Type: application/json' \
  -d '{"backupId":"smoke-backup"}' \
  http://127.0.0.1:5173/api/admin/backups
```

There is intentionally no online restore endpoint. Restore stays an offline
maintenance flow that stages a separate data root while the server is stopped.

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

- A fresh volume shows owner setup before any dashboard content.
- A fresh eligible volume offers Create Owner Account and Continue as Guest;
  guest mode shows only Cinema, Studio, and Search plus a persistent Create
  Owner Account identity-menu command at desktop and 390x844.
- Failed sign-in is generic; successful sign-in and reload restore identity.
- The identity menu opens Account Settings and closes cleanly with Escape.
- Profile, password, member, session revocation, and sign-out controls work.
- A member can browse Files but receives a clear permission error for writes.

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
- Owner Settings includes a Jobs category with refresh, filtering, maintenance
  enqueue actions, and cancellation confirmation.
- Member Settings does not show the Jobs category or owner-only admin controls.
- Owner Account Settings can switch each member between all libraries and a
  responsive selected-library checklist; member Settings never shows it.
- Owner Settings includes an Activity category with event, outcome, actor,
  principal, and date filters plus bounded pagination; members do not see it.
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
- Settings includes Account and Client sections.

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
- Setup/sign-in uses safe-area padding and has no horizontal overflow.
- The compact account identity and menu remain on-screen.
- Detail panel does not reserve bottom-rail space.
- Full-screen app surface fits within the viewport.
- Cinema stacks the library and playback panel without overlap.
- Studio stacks the music library and player without overlap.
- Files layout keeps the list and preview usable on phone-sized viewports.
- App strip scrolls horizontally.
- Status pills wrap without text overlap.
- At `390 x 844`, the owner Jobs category keeps the enqueue actions in a
  two-column grid, filters stretch full width, and confirmation controls stay
  reachable without horizontal overflow.
- At `390 x 844`, owner Activity filters and event details use one column, the
  refresh/load-more controls span the panel, and the page has no horizontal
  overflow. Selecting Activity hides Jobs and other Settings sections.

## Playwright end-to-end suite

Run the browser suite only through its Docker wrapper:

```sh
./scripts/test-e2e.sh
```

The wrapper assigns a unique Compose project and free host port, then replaces
both `/app/data` and `/app/content` with per-run temporary bind mounts. It seeds
small deterministic video, audio, and text fixtures, disables TMDB credentials,
and runs Chromium inside the pinned Playwright image. The suite never reads the
normal `nebula-data` volume or developer `content/`, and it does not require port
5173 or outbound network access at test time.

Failure screenshots, videos, and traces are retained under `test-results/` and
the HTML report is written to `playwright-report/`; both directories are ignored.
Pass normal Playwright filters after the wrapper when narrowing a failure:

```sh
./scripts/test-e2e.sh --project=owner --grep "Cinema"
```

Coverage includes first-owner setup and cookie restoration, member sign-in and
role visibility, app-first and keyboard navigation, Cinema/Studio/Files smoke
paths, owner Jobs/Activity/Playback controls, and the 390x844 responsive contract.

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
APP_PATH=$(find ~/Library/Developer/Xcode/DerivedData -path '*/Build/Products/Debug-iphonesimulator/App.app' -type d -exec stat -f '%m %N' {} + | sort -nr | head -1 | cut -d' ' -f2-)
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
- A native sign-in survives app termination/relaunch without any
  `nebula.accountSessionToken:*` local-storage entry.
- Sign out, current-session revocation, session expiry, and Server URL changes
  require a fresh sign-in and do not reuse the previous Keychain credential.

Current command-line `simctl` can screenshot the launched dashboard, but it does
not provide tap automation in this setup. Use a quick manual simulator pass for
Cinema and Files surfaces after major layout changes.

## Future Automated Tests

Wave 3 server tests cover trusted planner routing, account isolation, expiry,
cancel/shutdown cleanup, remux/transcode recovery, safe HLS asset resolution,
and direct/remux byte-range delivery. Browser smoke checks should exercise
Cinema on desktop and at 390x844 while retaining the ticket fallback.

Wave 4 playback-policy tests cover unlimited defaults, migration/persistence,
global and per-user admission races, requested/remux-produced/HLS bitrate
enforcement, terminal cleanup, restart accounting, owner/service-admin access,
member denial, and the responsive Settings / Playback panel. Direct byte-range
playback is explicitly excluded; see `docs/playback-policies.md`.

Good next additions:

- Playwright smoke test in Docker.
- DOM tests for app-first navigation and panel state transitions.
- Visual screenshot checks for desktop and mobile.
- A repeatable iOS simulator UI test that taps through Cinema and Files safe
  areas.
- WebGPU capability test that accepts both WebGPU and Canvas fallback modes.
