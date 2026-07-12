# Release Readiness

Date: 2026-07-11  
Candidate: `bd1088750eb40c0592dc47f6c6aba97d1a901b0e`  
Scope: single-host self-hosted preview

## Recommendation

**GO for the documented single-host preview scope.** No release blocker was
found. This is not approval for public-Internet exposure, HA, multi-node use,
hardware transcoding, or the unsupported features listed below.

All QA used an isolated worktree, unique Compose projects, dynamically assigned
loopback ports, and disposable content, data, backup, and restore roots. Port
5173, the normal `content/` directory, and the main data volume were not used.
No host npm command or host dependency installation was used.

## Objective results

| Area | Result | Evidence |
| --- | --- | --- |
| Build and static checks | Pass | Deployment and development images built; `npm run check` passed in Docker. |
| Server suite | Pass | `npm test`: 160 passed, 0 failed, 0 skipped. Includes real FFmpeg remux and software-HLS transcode fixtures. |
| Browser suite | Pass | `./scripts/test-e2e.sh`: 7 passed. Owner/member, Cinema, Studio, Files, subtitles, Settings administration, navigation, and 390x844 coverage passed. |
| Fresh deployment | Pass | Setup and guest entry rendered; guest exposed only Cinema, Studio, and Search plus the owner CTA. Owner creation returned 201, closed guest eligibility atomically, and survived restart. Reload/sign-in restoration is covered by Playwright. |
| Authorization and leakage | Pass | Unauthenticated Files returned 401; service Files returned 200. Automated guest/member/owner/service matrices, CSRF/CORS, library grants, media tickets, playlists, subtitles, admin routes, traversal, symlink, safe-error, metrics-label, audit-redaction, and path-free API tests passed. |
| Upgrade | Pass | Synthetic existing-database migration tests passed for account owner marker, catalog, playback, jobs/probe, permissions, audit, policies, media lists, and subtitles. Migrations were idempotent and centrally composed. No live/user database was read. |
| Backup/restore | Pass | Populated online backup returned 201 and inspected valid. After shutdown, documented offline restore succeeded into an empty sibling root. Re-running against the occupied root failed (`rc=1`). A checksum-tampered copy failed (`rc=1`) and published no database. Restored owner marker, backup listing, and catalog endpoints remained usable. |
| Playback | Pass | Deterministic direct play, byte ranges, ticket isolation/fallback contract, MP4 remux, software HLS, subtitle selection/attachment, policy admission/release, cancellation, expiry, shutdown, and cache cleanup passed automated coverage. |
| Operations | Pass | Both Compose configurations validated. Deployment health and opaque readiness returned 200/true; authenticated metrics and detailed admin routes returned 200. Restart preserved owner and backup state; graceful shutdown and staged restart passed. Deployment image includes FFmpeg/FFprobe and `restart: unless-stopped`. |
| iOS web sync/build | Pass | Docker-first dev-server sync passed; root `dist/` was removed; generated `ios/App/App/public/` remained ignored. Xcode simulator build succeeded. |
| iOS simulator launch | Partial | Clean iPhone 17 Pro simulator install/launch and 1206x2622 screenshot succeeded. The expected iOS local-network connection prompt blocked command-line-only interaction; `simctl` cannot tap it. No physical device was tested. |
| Host cleanliness | Pass | No host `node_modules` or root `dist`; generated iOS assets, Playwright output, disposable data/media/backups, credentials, and screenshots remain ignored or outside the repository. |

## Fresh and browser observations

- Fresh status reported `setupRequired: true` and `guestAvailable: true`.
- Guest mode showed three applications only and described the session as
  temporary/not saved. The identity menu retained **Create Owner Account**.
- First owner creation changed status to `setupRequired: false` and
  `guestAvailable: false`; the state persisted after container restart and
  after offline restore.
- Desktop automation exercised setup, dashboard, Cinema, Studio, Files,
  Settings, playlists integration, subtitle attachment, owner/member
  visibility, and keyboard/app-first navigation.
- At 390x844, the setup/sign-in and owner dashboard had matching 390-pixel
  client/scroll widths, `viewport-fit=cover`, seven owner applications, and no
  `.rail-button` elements. Focused Settings phone-layout contracts passed.

## Security and sensitive-data review

The automated suite proved authorization and non-disclosure at the server
boundaries, including forged Host handling, localhost policy, exact bearer
matching, allowlisted API-only CORS, cookie CSRF, account isolation, library
grant re-authorization, range media, Files write restrictions, admin APIs,
playlist/subtitle isolation, and traversal/symlink rejection. Metrics use
bounded component/storage labels; readiness is opaque; audit and user-facing
errors exclude raw paths, credentials, authorization headers, media filenames,
and raw SQLite failures.

Tracked/generated-file inspection found no committed `.env`, credential,
media, SQLite/WAL/SHM, backup, delivery-cache, `dist`, `node_modules`,
Playwright-output, or generated iOS web-asset additions. Backup manifests do
not expose secrets, but the bundled database contains password verifiers,
hashed sessions, account metadata, audit history, and reversible server
settings; backups must therefore be protected as secrets.

## Non-blocking limitations and unverified external items

- Physical-device iOS networking, local-network permission acceptance,
  Keychain persistence/revocation through interactive taps, logout cleanup,
  and real-device LAN/TLS behavior were not tested. Source-contract tests for
  Keychain accessibility, server scoping, legacy token removal, fail-closed
  cleanup, and non-persistence in WebView storage passed.
- The simulator build and launch passed, but command-line `simctl` cannot accept
  the iOS local-network prompt or tap through account, Cinema, and Files flows.
- No public-Internet hardening, TLS termination, reverse-proxy Secure-cookie
  correction, HA, multi-node operation, load testing, or hardware acceleration
  is claimed.
- Live TV, DVR, DLNA, casting, synchronized playback, plugins, external
  subtitle acquisition, password reset, MFA/passkeys, account deletion, role
  changes, second owners, and encrypted database-at-rest remain unsupported.
- Direct byte-range playback intentionally is not counted by concurrent-stream
  policy because it lacks a reliable server lifecycle boundary.
- Backups exclude content media; operators need a separate consistent media
  snapshot for disaster recovery.

## Commands recorded

All Node commands below ran inside Compose containers:

```sh
docker compose -f compose.yaml -f compose.e2e.yaml config --quiet
docker compose -f compose.yaml -f compose.e2e.yaml build dashboard
docker compose -f compose.yaml -f compose.e2e.yaml run --rm dashboard npm run check
docker compose -f compose.yaml -f compose.e2e.yaml run --rm dashboard npm test
./scripts/test-e2e.sh
docker compose --env-file <isolated-env> -f compose.deploy.yaml config --quiet
docker compose --env-file <isolated-env> -f compose.deploy.yaml build
docker compose --env-file <isolated-env> -f compose.deploy.yaml up -d
docker compose --env-file <isolated-env> -f compose.deploy.yaml restart dashboard
docker compose --env-file <isolated-env> -f compose.deploy.yaml down
NEBULA_DATA_PATH=<empty-stage> docker compose --env-file <isolated-env> \
  -f compose.deploy.yaml run --rm --no-deps dashboard \
  node scripts/offline-restore.mjs /app/backups release-qa /app/data
NEBULA_IOS_DEV_SERVER_URL=<isolated-url> ./scripts/ios-sync-dev-server.sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer ./scripts/ios-build-simulator.sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl install <device> <app>
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl launch <device> com.nebula.dashboard
```

No concrete product defect was discovered, so no source fix was made.
