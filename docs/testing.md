# Testing And QA

Verification combines TypeScript checking, the complete Node suite, the Docker
Playwright suite, and targeted manual/iOS QA.

## Multi-Origin HLS Research

The detached Phase 6 experiment has focused contract, loader, and deterministic
fixture checks:

```sh
docker compose run --rm dashboard node --test \
  tests/server-cluster-multi-origin-hls.test.mjs \
  tests/multi-origin-hls-loader.test.mjs \
  tests/multi-origin-hls-benchmark.test.mjs
docker compose run --rm dashboard node scripts/benchmark-multi-origin-hls.mjs
```

Coverage includes default-off behavior, exact rendition-map matching, scoped
and expired grants, wrong origins, tampered/oversized/stalled responses, bounded
retry, integrity verification, and duplicate-request coalescing. The benchmark
is generated deterministic data, not real-tailnet evidence. See
`docs/multi-origin-hls-experiment.md` before interpreting results.

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
Deployment CLI tests run in the same suite with fake Docker commands. They cover
argument parsing, prerequisite failure before host mutation, conservative
configuration generation, idempotent no-clobber initialization, backup token
file permissions, and exact `compose.deploy.yaml` command construction; they do
not start a production stack. Platform-contract tests also keep the Linux,
macOS, and Windows launchers aligned on localhost binding, account gating,
no-clobber initialization, Tailscale isolation, and secret handling.

Before a Windows release, additionally parse and run
`scripts/nebula-server.ps1` on a disposable Windows 11 Docker Desktop host.
Exercise initialization, ACL rejection, every lifecycle command, reboot
recovery, backup token handling, and interactive Tailscale enrollment. Static
cross-platform tests do not replace this native-host acceptance pass.

Tailscale coverage verifies that both stacks include a dormant companion;
`tailscaled` starts only after the fixed owner-controlled marker appears and
stops without deleting state; bootstrap files use conservative modes; `.env`,
argv, logs, and rendered Compose do not contain the auth key; the official image
is digest-pinned and userspace-only; the fixed proxy target is loopback; and
`AllowFunnel` is false. Server tests cover dynamic Secure cookie
creation, login, password rotation, and clearing under
`NEBULA_EXTERNAL_HTTPS=true`, prove forwarded headers alone do not enable the
flag, verify deployment HMR-off behavior, accept only the exact
sidecar-published hostname, and reject attacker-controlled or wildcard hosts.
Network-path tests cover direct, peer-relay, DERP, idle, and unknown
classification; reject malformed, oversized, and symlinked snapshots; and
confirm that endpoint addresses, node keys, and Tailscale user identities do
not appear in owner API responses.

Media-cluster Phase 1 through 4 tests cover strict protocol shapes, exact Tailscale HTTPS
origins, fixed userspace proxy configuration, Ed25519 identity persistence,
hashed one-time pairing codes, signed body/method/path binding, persistent nonce
replay rejection, clock windows, revocation, bounded responses, owner/shard
route separation, revision-bound full-file fingerprints, path-free manifests,
cursor-loss recovery, exact-replica collapse, provider-identity grouping,
ambiguous-title conflicts, merge/split overrides, authenticated coordinator
sync, local-source preference, remote-only browse safety, role-gated unified
libraries, client-safe availability projections, and Cinema/Studio responsive
availability UI contracts. They use generated keys, generated media fixtures,
and isolated SQLite databases and do not require tailnet credentials.

Phase 4 generated-fixture coverage additionally verifies deterministic
session-level balancing, stickiness, explainable score reasons, draining and
cooldown exclusion, account-bound session lookup/release, signed delegated
grant validation, nonce replay rejection, target/source/revision/method binding,
opaque ticket validation, bounded fixed-endpoint activation, signed remote
delivery create/status/cancel routes, range media responses, content-root
containment, exact coordinator-origin CORS, remote direct/remux/HLS activation,
safe ticketed playlist rewriting and segment delivery, fixed-quality planning,
coordinator-owned federated playback state, and exact-replica-only failover.
The lifecycle fixtures also hold generated delivery permanently in `queued`,
advance injected clocks beyond hard coordinator and shard deadlines, and verify
exactly-once scheduler/delivery release. Client polling tests inject time,
randomness, delays, and timers to prove finite deadlines, bounded exponential
backoff, source-switch abort, session cancellation, and zero retained timers.
These tests do not establish real Tailscale reachability or browser codec
compatibility.

Member-federation fixtures additionally verify allowed and denied Cinema and
Studio projections, guest non-query behavior, authorization before source
projection, direct and generated playback grants, exact-replica failover,
permission revocation across create/get/failover/release, account substitution
and replay rejection, and account-isolated history/resume filtering. Run them
with:

```sh
docker compose run --rm dashboard node --test \
  tests/server-cluster-member-federation.test.mjs \
  tests/server-cluster-library-projection.test.mjs \
  tests/server-cluster-playback-service.test.mjs \
  tests/server-cluster-grants.test.mjs \
  tests/server-playback-federated.test.mjs
```

Distributed playback-policy fixtures verify that account bitrate constraints
reach both scheduling and shard delivery without mutating the client request;
remote direct and local candidates are not double-counted; queued remux,
transcode, and prebuilt delivery each hold exactly one coordinator lease; local
and remote generated sessions share global/per-account limits; final output and
changed pending policy fail closed before grant activation; and release is
idempotent across normal cancellation, terminal status, failure, expiry,
failover, and shutdown. Run them with:

```sh
docker compose run --rm dashboard node --test \
  tests/server-cluster-playback-policy.test.mjs \
  tests/server-cluster-playback-service.test.mjs \
  tests/server-playback-policy.test.mjs \
  tests/server-cluster-member-federation.test.mjs
```

Phase 5 key-rotation fixtures generate fresh Ed25519 identities and verify the
exact owner/service-admin route boundary, old-key-signed preparation,
new-key-signed commit, consecutive-version enforcement, nonce replay and key
substitution rejection, bounded transition expiry, restart resume after an
interrupted commit, backup/restore of pending transition state, API redaction,
and rejection of the retired key. Run them with:

```sh
docker compose run --rm dashboard node --test \
  tests/server-cluster-key-rotation-client.test.mjs \
  tests/server-cluster-key-rotation.test.mjs \
  tests/server-cluster-routes.test.mjs \
  tests/server-backup.test.mjs
```

These fixtures do not prove cross-node delivery over a real tailnet. Complete
operator acceptance with paired disposable nodes, initiate rotation through
`POST /api/admin/cluster/key-rotation`, interrupt one node between prepare and
commit, restart it within 15 minutes, repeat the exact POST to resume, and then
confirm signed health/manifest requests succeed while a captured old-key test
request is rejected. Never capture or export private key rows for this test.

Static/Compose checks that need no tailnet credentials:

```sh
docker compose --env-file .env.example -f compose.deploy.yaml config --quiet
docker compose --env-file .env.example -f compose.deploy.yaml config --services
docker compose run --rm dashboard node --test \
  tests/server-cluster-client.test.mjs \
  tests/server-cluster-manifest.test.mjs \
  tests/server-cluster-library-projection.test.mjs \
  tests/server-cluster-scheduler.test.mjs \
  tests/server-cluster-operations.test.mjs \
  tests/server-cluster-grants.test.mjs \
  tests/server-cluster-grant-client.test.mjs \
  tests/server-cluster-media-routes.test.mjs \
  tests/server-cluster-playback-service.test.mjs \
  tests/server-cluster-shard-delivery.test.mjs \
  tests/delivery-polling.test.mjs \
  tests/server-cluster-protocol.test.mjs \
  tests/server-cluster-routes.test.mjs \
  tests/server-cluster-sync.test.mjs \
  tests/server-cluster-trust.test.mjs \
  tests/cluster-admin-ui.test.mjs \
  tests/shard-unified-ui.test.mjs \
  tests/server-catalog-fingerprints.test.mjs \
  tests/nebula-server-cli.test.mjs \
  tests/server-tailscale-enrollment.test.mjs \
  tests/server-vite-config.test.mjs \
  tests/tailscale-admin-ui.test.mjs \
  tests/tailscale-deployment.test.mjs
```

The service output must contain `dashboard` and `tailscale`; the latter should
run only its idle supervisor until enabled. Never save rendered Compose output
when a real secret source is in use.

### Real-tailnet verification

Automated tests cannot establish a private HTTPS endpoint without an approved
tailnet and operator-generated credential. After following the bootstrap runbook
in `deployment.md`, use an isolated tailnet/copied Nebula data and verify:

Record completed operator evidence and remaining gaps in
`media-sharding-tailnet-acceptance.md`.

1. `tailscale serve status` reports private HTTPS `/` proxying only to
   `http://127.0.0.1:5173`, and the reviewed config still has
   `AllowFunnel: false`.
2. Recreating the sidecar before and after emptying/revoking the bootstrap key
   preserves the same node identity and `*.ts.net` URL.
3. An allowed device reaches HTTPS; a Grant-denied tailnet device and a device
   outside the tailnet cannot connect.
4. Owner setup, sign-in, reload, password rotation, CSRF mutation, and sign-out
   work, and browser session cookies include `HttpOnly`, `SameSite=Lax`, and
   `Secure`.
5. Files browse/download, small upload, resumable 64 MB upload interruption and
   resume, Cinema `206` seek/direct play, remux, progressive HLS, quality
   switching, Studio playback/resume, and iOS Keychain restore all work.
6. Dashboard-only and sidecar-only restarts recover independently. Measure both
   direct and DERP-relayed throughput before considering any future opt-in
   kernel mode; the current implementation intentionally has no TUN device or
   network capabilities.
7. With an empty mode-0600 auth-key file and empty state, Settings / Remote
   Access starts Off. Enable it and confirm only a strict
   `login.tailscale.com/a/...` link appears for the owner, opens in a separate
   page, and changes to Connected after authorization. Disable it and confirm
   localhost stays healthy, `tailscaled` exits, and state remains. Confirm a
   member receives `403` and the dashboard has no daemon or Docker socket.
8. For experimental cluster verification, enroll two isolated Nebula/Tailscale
   nodes with distinct data and state directories. Enable the cluster variables
   on both, create a pairing code on the shard, pair it from the coordinator,
   verify signed health succeeds, replay the same envelope and expect rejection,
   revoke the shard, and verify subsequent signed requests fail. Confirm the
   dashboard reaches the shard through only `127.0.0.1:1055` and that the proxy
   is not published on the host. Add the same generated fixture to both nodes,
   wait for fingerprint jobs, explicitly sync the shard, and confirm the
   coordinator projection contains one item with two nodes. Add a same-title
   different-byte fixture and confirm it stays separate with an open conflict.
   Sign in as the coordinator owner and confirm Cinema and Studio show one card
   per logical item, a multi-shard badge, and every source in `Available on`.
   Configure one member for the shared media library and another with no media
   libraries. Confirm the authorized member sees and can play the same logical
   item while the denied member sees no federated metadata or availability.
   Revoke the first member's access during an active session and confirm polling,
   failover, release, new grants, history, and resume state fail closed while the
   coordinator releases its session. The already accepted shard ticket remains
   usable only until its short expiry or shard restart.
   Stop one shard and confirm stale/offline availability remains visible. A
   remote-only item with an online direct-play source must offer owner playback;
   one without a compatible source remains browseable and disabled. Guest
   sessions must remain local-only. Generated remote delivery should be
   exercised in the Phase 4 acceptance pass below.
9. For Phase 4 acceptance, place byte-identical generated media on at least two
   shards and a different encode of the same logical title on a third. From the
   coordinator origin, verify remote-only Cinema and Studio original playback,
   byte-range seeking, exact-origin CORS, short-lived grant behavior, and
   distribution of separate sessions across healthy replicas. Terminate the
   selected Cinema and Studio shards and confirm the coordinator chooses only the matching
   exact fingerprint, resumes near the last browser position, and reports no
   candidate when only the alternate encode remains. Record resume drift.
10. Repeat Phase 4 playback over measured Tailscale Direct and DERP-relayed
    paths. Verify an offline, draining, cooldown, or revoked node receives no new
    session, grants and URLs do not appear in logs or rendered HTML, and the
    deployment still rejects Funnel/public access. Verify remote remux,
    HLS/transcode, fixed-quality renditions, and coordinator-owned personal
    playback history and remote subtitle delivery explicitly.
    Also confirm that revocation blocks new grant activation while an already
    accepted bearer ticket remains bounded by its expiry or shard restart; an
    immediate distributed active-ticket revocation mechanism does not exist yet.
11. For Phase 5 rolling operations, drain one shard before updating it and
    confirm it receives no new sessions. Restart the coordinator and shard one
    at a time, then verify their persisted node identities still authenticate
    signed health requests. Force a catalog revision between manifest pages and
    confirm the coordinator discards the stale cursor, starts one fresh full
    reconciliation generation, and completes without deleting valid projected
    rows. Repeated cursor churn must fail boundedly rather than loop. Version 1
    peers remain compatible; legacy payloads missing required fields, future
    protocol versions, and unknown future trust/path fields must fail closed.
    Back up the coordinator, restore it offline into an empty data root, and
    confirm cluster identity, paired nodes, manifest cursor/generation state,
    draining state, and revocations are unchanged. A revoked node must remain
    excluded and unable to authenticate after both restart and restore.

Focused generated-fixture coverage for the Phase 5 slice:

```sh
docker compose run --rm dashboard node --test \
  tests/server-cluster-rolling.test.mjs \
  tests/server-cluster-sync.test.mjs \
  tests/server-cluster-protocol.test.mjs \
  tests/server-cluster-trust.test.mjs \
  tests/server-backup.test.mjs
```

These fixtures use temporary databases and generated manifests only. Success
and failure paths both remove their temporary roots; no `content/` media,
tailnet credentials, persisted test keys, or rendered secret-bearing Compose
configuration is required.
12. In Settings / Cluster, assign opposing priorities and verify deterministic
    selection, then saturate stream and live-transcode limits and confirm new
    sessions use another eligible node or fail closed. Drain a node while a
    stream is active: the stream must continue, new sessions must avoid it, and
    undrain must restore admission. Rename a node and confirm only the displayed
    alias changes; node ID, endpoint, public key, and signed traffic remain
    unchanged. Repeat at approximately 390x844 and verify no horizontal overflow.

Harmless operator CLI smoke checks:

```sh
./scripts/nebula-server.sh --help
./scripts/nebula-server.sh validate
docker compose run --rm dashboard node --test tests/nebula-server-cli.test.mjs
```

On Windows PowerShell 7, the equivalent smoke checks are:

```powershell
.\scripts\nebula-server.ps1 help
.\scripts\nebula-server.ps1 validate
```

`validate` requires an existing deployment `.env`; it renders the deployment
Compose configuration but does not build or start containers.

Shell coverage exercises stable-ID state transitions, end clamping, scoped
preference validation and v1 migration, wheel/repeat gates, standard gamepad
mapping, and roving-focus/modal source contracts.

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
safety, normalized stream metadata, revision-safe rename/restore reconciliation,
idempotent probe-revision migration with legacy-row compatibility, stale
in-flight probe rejection, enriched catalog responses, and explicit watched-state
updates without synthetic sessions.
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
- Studio playback uses one persistent `<audio data-studio-player>` engine behind
  custom Studio transport controls and no large black video frame. Returning to
  the library keeps playback active and exposes the responsive mini player.
- Authenticated Studio playback reports start, progress, pause, stop, and
  completion events against stable catalog IDs.
- Studio shows per-user Continue Listening and Listening History rails, and a
  centered resume/restart dialog for unfinished tracks.
- Guest Studio playback remains non-persistent and cannot access playback
  history.
- Studio shows a friendly player status if browser playback fails or a format
  is unsupported.
- Cinema video titles use one native video engine behind the custom Cinema
  transport. Seek, play/pause, mute/volume, subtitles, quality selection, and
  fullscreen remain reachable at desktop and phone widths.
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
- Tab reaches only the selected application tile; arrow navigation moves the
  roving focus target and closing a detail/app restores the invoking control.

## Controller Test

- Connect/disconnect updates the controller status without starting duplicate
  polling loops.
- D-pad or left stick moves one app at a time, clamps at both ends, then repeats
  after a short hold delay.
- A confirms/opens once per press and B closes the account menu, active app, or
  detail panel in that priority order.
- When no physical gamepad is available, record controller checks as an
  unverified manual limitation; automated mapping and repeat tests still run.

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
- The selected app is the grid's only `tabindex="0"` tile and has visible
  `:focus-visible` treatment.

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
small deterministic video, real 18-second MP3 audio, subtitle, and text fixtures,
disables TMDB credentials, gives the run unique account credentials, and runs
Chromium inside the pinned Playwright image. The suite never reads the normal
`nebula-data` volume or developer `content/`, and it does not require port 5173
or outbound network access at test time. Cleanup removes only the run's temporary
bind mounts and uniquely named Compose resources.

Failure screenshots, videos, and traces are retained under `test-results/` and
the HTML report is written to `playwright-report/`; both directories are ignored.
Pass normal Playwright filters after the wrapper when narrowing a failure:

```sh
./scripts/test-e2e.sh --project=owner --grep "Cinema"
```

Coverage includes eligible first-run guest entry and exit, first-owner setup,
cookie restoration, isolated sign-out, member sign-in, and owner/guest/member
visibility. Full-app interactions cover pointer and hover selection, roving
tabindex, keyboard arrows/Enter/Escape, clamped boundaries, deliberate gated
wheel steps, focus restoration, app/dialog close paths, and Cinema, Files,
Search, and Settings smoke flows. Studio uses the generated audio fixture to
exercise real browser play/pause reporting, Continue Listening and Recently
Played, accessible resume-dialog semantics, and both resume and restart requests;
guest playback verifies that no personal playback API or history UI is exposed.
Desktop and 390x844 checks assert reachable controls and no document-level
horizontal overflow.

Chromium media assertions intentionally avoid exact playback timestamps. They
wait only for bounded forward progress and validate the resume/restart positions
reported by the app. If the pinned headless Chromium image loses MP3 playback
support, the Studio scenario fails explicitly at `HTMLMediaElement.play()`; it
must not be marked passed by mocking media time or playback events.

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
global and per-user admission races across local and federated generation,
requested/remux-produced/HLS bitrate enforcement, pending remote revalidation,
terminal cleanup, restart accounting, owner/service-admin access, member denial,
and the responsive Settings / Playback panel. Direct byte-range playback is
explicitly excluded; see `docs/playback-policies.md`.

Hardware-transcode coverage normalizes malformed probes, exercises mode and
fallback outcomes, bounds public reasons/metrics, and verifies fixed FFmpeg
argument arrays. The Docker suite runs a real software fixture. A real hardware
fixture is reported passed only when the running container detects a backend
and completes it; otherwise the result is explicitly skipped/unavailable.

Rendition-contract coverage verifies fixed profile IDs and versions, bounded
H.264/AAC targets, fail-closed quality preferences, no-upscale profile
availability, idempotent central migration, source-revision uniqueness, schema
constraints, and source-delete cascading. Runtime tests additionally verify
exact profile bitrate/dimension arguments, keyframe-aligned event playlists,
atomic first-segment readiness before FFmpeg completion, sliding delivery
expiry, resume-safe complete-playlist gating, policy-aware profile selection,
real FFmpeg H.264/AAC output, native-HLS preference, hls.js MSE fallback,
credential configuration, bounded recovery, idempotent teardown, quality
request forwarding, actual-result labeling, and phone control reachability.
Persistent-rendition tests verify atomic publication beneath the data root,
reuse after delivery cleanup and service restart, exact revision invalidation,
corrupt/missing asset rebuilds, first-segment playback before publication,
same-key interactive build deduplication, authorization before lookup, and
absolute/traversal storage-key rejection. Scheduled-job lifecycle, retention,
quota, and LRU cleanup now have focused integration coverage.

The profile matrix includes 240p (426x240, 650 Kbps ceiling) and 360p
(640x360, 1.1 Mbps ceiling). Contract and planner tests verify both are
server-owned, source-eligible without upscaling, selectable by Cinema, and
available to scheduled optimization and owner storage policy.

### Real-Media Transcoding Smoke Test

Complement automated fixtures with one real library title:

1. Start a fixed profile at position zero and confirm the video clock advances
   from a hls.js `blob:` URL while FFmpeg and a `building` rendition are still
   present.
2. Queue another profile through Cinema **Optimize**, wait for a successful
   durable job and a checksummed `ready` rendition, then restart Compose.
3. Select that profile after restart and confirm playback advances without a
   new FFmpeg process or rendition job.

This was last completed against the 48-minute local Cinema fixture in July
2026. It exposed and fixed Chromium falsely advertising native HLS support;
Chromium now uses hls.js while Safari/iOS retains native HLS.

Run the focused persistence regression set through Docker:

```sh
docker compose run --rm dashboard node --test \
  tests/server-rendition-persistence.test.mjs \
  tests/server-transcode.test.mjs \
  tests/server-playback-delivery.test.mjs
```

Good next additions:

- DOM tests for app-first navigation and panel state transitions.
- Visual screenshot checks for desktop and mobile.
- A repeatable iOS simulator UI test that taps through Cinema and Files safe
  areas.
- WebGPU capability test that accepts both WebGPU and Canvas fallback modes.
Rendition storage-policy coverage verifies the bounded central migration,
validation, cleanup dedupe, cache-only LRU and pinned exclusion, aggregate
metrics, and responsive owner Settings controls. Scheduled rendition coverage verifies server-derived canonical job payloads,
revision-safe workers, active/ready deduplication, persistent publication,
owner/service-admin mutation boundaries, CSRF enforcement, path-free responses,
and Cinema Optimize controls. Rendition jobs are visible in Settings jobs
filters but cannot be enqueued without a validated Cinema title.
