# Deployment And Operations

Nebula currently supports a **single-host, self-hosted preview deployment** built
from this repository. Linux hosts with Docker Engine plus Compose v2 are the
recommended target. Docker Desktop on macOS is suitable for evaluation. The
server embeds Vite middleware and has not been hardened or load-tested as a
general public internet service. Do not treat it as HA, multi-node, or a
production media appliance.

`compose.yaml` is the development stack: it bind-mounts source and enables file
watch polling. `compose.deploy.yaml` is the operator example: it builds an image
locally, mounts only content/data/backup paths, restarts after failure or reboot,
runs as an explicit UID/GID, and checks liveness. No image is published.

## Prerequisites and storage

- Docker Engine 26+ and Docker Compose v2; approximately 2 GB free for build
  layers, plus media, database, backup, and transient delivery-cache capacity.
- A 64-bit Linux Docker host is the recommended persistent server. WebGPU is a
  client/browser feature; server GPU access and hardware transcoding are not
  implemented or claimed.
- The image includes FFmpeg and FFprobe. Probing, remux, and software HLS depend
  on them. Direct byte-range playback may still work when conversion does not.
- Three host directories on one durable host: content, data, and backups.
  Content contains user media and Files uploads. Data contains `nebula.sqlite`,
  WAL state, settings, catalog state, artwork metadata, and disposable delivery
  cache (including the embedded Vite cache). Backups contain database/metadata
  bundles but **never media**.

## Operator CLI and fresh-host install

Clone or check out a reviewed Nebula revision on a Linux host with Docker, then
run the repository-owned CLI. This is the one-command install path after Docker
is installed:

```sh
sudo ./scripts/nebula-server.sh install
```

The command checks Docker daemon access and Compose v2 before changing the host,
creates `/srv/nebula/{data,content,backups}` as mode `0750`, writes a mode `0600`
`.env` from conservative documented defaults, validates and starts
`compose.deploy.yaml`, waits for `/readyz`, and prints the owner setup URL. When
run through `sudo`, the directories are owned by the invoking user's numeric
UID/GID. An existing `.env` is retained byte-for-byte; existing storage is never
deleted. Re-running `install` is safe and reconciles the current Compose stack.

Inspect the generated `.env` before making the service reachable beyond
loopback. For a different storage root or noninteractive provisioning, use
flags or their documented environment equivalents:

```sh
sudo ./scripts/nebula-server.sh \
  --base-dir /mnt/nebula \
  --bind 127.0.0.1 \
  --port 5173 \
  install
```

Use `./scripts/nebula-server.sh --help` for every option. `--env-file` and
`--compose-file` make configuration locations explicit. `init` only creates
missing storage/configuration and validates it; `validate` never starts the
stack. The CLI does not edit Git, generate passwords/tokens, remove volumes,
reset accounts, or replace configuration.

Adjust `NEBULA_UID`, `NEBULA_GID`, and paths in `.env` together. The selected
user needs read/write/execute access to all three directories. Content may be
read-only only if Files uploads, renames, deletes, and media-sidecar changes are
not needed; readiness currently checks that content is writable, so a read-only
mount reports not ready. Never commit `.env`, data, backups, credentials, media,
SQLite files, or delivery caches.

## First boot

The equivalent lifecycle commands are:

```sh
./scripts/nebula-server.sh validate
./scripts/nebula-server.sh up
./scripts/nebula-server.sh status
./scripts/nebula-server.sh logs --tail 200 --follow
./scripts/nebula-server.sh down
```

`up` builds as needed, starts in the background, and waits for readiness. Use
`--no-wait` only when an external supervisor owns readiness. All commands use
the same `.env` and `compose.deploy.yaml`; localhost development Compose remains
unchanged.

Open the configured URL and create the first owner. There is no generated
password or recovery flow. Use a unique 12-128 character password and retain it
outside Nebula. Owner creation is irreversible for that data root; later users
are members, not additional owners.

The deployment example disables guest mode. If deliberately enabled, guest
entry is offered only while there are zero accounts and `owner_initialized` has
never been set. It is further restricted to socket addresses classified as
loopback, private, link-local, or unique-local. Guest sessions are memory-only,
expire after eight hours by default, vanish on restart, and are atomically
revoked when the owner is created. A same-host reverse proxy appears local to
Nebula, so do not enable guest mode behind one unless that eligibility is
acceptable.

## Network, proxy, and TLS

The safe default publishes only on `127.0.0.1`. Put an HTTPS reverse proxy on
the same host and forward to `http://127.0.0.1:5173`; preserve WebSocket upgrade
headers because the current embedded Vite runtime may use them. Pass the
original host, but do not use forwarded headers as an authentication boundary.
Set `NEBULA_VITE_ALLOWED_HOSTS` to the exact external DNS names if Vite rejects
them. Terminate TLS at the proxy, set normal request/body timeouts generously
for media and uploads, and avoid logging Authorization headers, cookies, query
strings, or media-ticket URLs. Nebula sets a Secure session cookie only when
its direct request is HTTPS, so TLS termination at a proxy does not currently
make that cookie Secure. This is a known limitation: keep the proxy-to-Nebula
hop and client network trusted, and do not expose the current runtime publicly.

For direct LAN evaluation, set `NEBULA_BIND_ADDRESS=0.0.0.0`, allow only the
chosen TCP port in the host firewall, and connect to
`http://<server-lan-ip>:<NEBULA_PORT>`. Prefer HTTPS on stable private DNS or a
private overlay network. Never assume `NEBULA_AUTH_ALLOW_LOCALHOST` protects LAN
traffic; it controls only the legacy service-token guard and defaults to false
in the deployment example.

CORS applies only to `/api/*`. Defaults allow Capacitor localhost plus the two
development localhost origins. Add exact comma-separated client origins with
`NEBULA_CORS_ALLOWED_ORIGINS`; arbitrary origins are not reflected and `*` is
not supported. Browser cookie mutations require `X-Nebula-CSRF`. Native bearer
sessions do not require CSRF. HTML media uses narrow, expiring, revocable media
tickets instead of bearer headers.

## iPhone and native sessions

On a real iPhone, `127.0.0.1` means the phone. Configure Settings / Client /
Server URL with a reachable URL such as `http://192.168.1.20:5173` for same-LAN
development or preferably `https://nebula.home.example` over private DNS/TLS.
The phone and server must be mutually reachable; client isolation on guest Wi-Fi
often blocks this. Leave API Token blank for normal account sign-in.

The Capacitor client stores its revocable account bearer session in the native
Keychain, scoped by Server URL, as `WhenUnlockedThisDeviceOnly`. It is not in
WebView local storage and is not included in server backups or device migration.
Changing Server URL, logout, session revocation, password rotation, or a 401
removes or blocks reuse. iOS may retain same-device Keychain items across app
deletion, so sign out/revoke before uninstalling when a clean reinstall matters.
See [mobile-clients.md](mobile-clients.md) for build and simulator checks.

## Health, metrics, and logs

- `GET /healthz`: public process liveness, always `200 {"live":true}` while the
  HTTP loop responds. Use it for the container health check.
- `GET /readyz`: public opaque readiness, `200` or `503` with only
  `{"ready":true|false}`. It checks SQLite, content access, worker heartbeat,
  catalog state, and at least 1 GiB free on content/cache filesystems.
- `GET /api/admin/observability/readiness`: owner or service-admin component
  detail. Do not expose it anonymously.
- `GET /metrics`: owner or service-admin Prometheus text. Scrapers must use an
  authorized account/service path; do not put tokens in URLs or proxy logs.

View and rotate logs through the Docker logging driver:

```sh
docker compose --env-file .env -f compose.deploy.yaml logs -f --tail=200 dashboard
docker compose --env-file .env -f compose.deploy.yaml ps
docker stats
```

Configure Docker daemon log rotation. Nebula intentionally avoids logging
secrets, but infrastructure logs remain sensitive. Audit history is a bounded,
redacted database record, not a replacement for container logs. Low disk makes
readiness fail at 1 GiB free. Clear only stopped-server `data/delivery-cache`
artifacts; never delete SQLite/WAL files ad hoc. Media and backups can dominate
disk independently because backups exclude content.

## Backup, offline restore, and data ownership

Owners or a service admin can create and inspect online backup bundles through
the authenticated `/api/admin/backups` API (there is not yet a dedicated backup
UI). A bundle contains a consistent SQLite copy and catalog-referenced metadata
cache, with a versioned manifest, sizes, and SHA-256 hashes. It excludes content media,
resumable upload partials, delivery cache, Keychain credentials, and arbitrary
host paths. Protect the bundle as a secret because SQLite contains password
verifiers, hashed sessions, account metadata, audit history, and reversible
server settings such as the TMDB credential.

Back up media separately with a filesystem-aware tool while preventing writes,
and preserve ownership/modes. A usable disaster recovery set is the inspected
Nebula backup bundle plus a consistent copy/snapshot of content.

For a service-admin backup without putting the token in shell history or the
process argument list, place the configured `NEBULA_API_TOKEN` in an
owner-readable file and invoke:

```sh
install -m 0600 /dev/null "$HOME/.nebula-admin-token"
${EDITOR:-vi} "$HOME/.nebula-admin-token"
./scripts/nebula-server.sh backup \
  --token-file "$HOME/.nebula-admin-token" \
  --backup-id "before-upgrade-$(date -u +%Y%m%d)"
```

The CLI requires mode `0600`, uses a private temporary curl configuration, and
does not print the token. The resulting bundle still excludes content. Inspect
the API response and copy/snapshot content separately before maintenance. Remove
the token file when it is no longer needed. Account owners who do not enable a
service token should use the authenticated backup API described above.

### No-clobber restore runbook

There is intentionally no online restore API. The safe procedure never writes
over the current data root:

1. Inspect the chosen bundle through the owner/service-admin backup API before
   downtime.
2. Stop Nebula and verify no container remains: `docker compose --env-file .env
   -f compose.deploy.yaml down`.
3. Copy the current `.env` aside securely and snapshot both current data and
   content. Do not copy a live SQLite file without its WAL/SHM state.
4. Create a new empty sibling such as `/srv/nebula/data.restore-20260711`, owned
   by the configured UID/GID. Never choose the current data directory.
5. Run the repository's offline restore command through the image, overriding
   only the data bind to the empty staging root. It validates the manifest,
   hashes, SQLite integrity/foreign keys/schema, and referenced metadata cache
   before publishing any file:

   ```sh
   BACKUP_ID=<validated-backup-id>
   STAGE=/srv/nebula/data.restore-20260711
   sudo install -d -o "${NEBULA_UID:-1000}" -g "${NEBULA_GID:-1000}" -m 0750 "$STAGE"
   NEBULA_DATA_PATH="$STAGE" docker compose --env-file .env \
     -f compose.deploy.yaml run --rm --no-deps dashboard \
     node scripts/offline-restore.mjs /app/backups "$BACKUP_ID" /app/data
   ```

   Restore publication is no-clobber: an existing destination database/cache
   file is an error and files published by the failed attempt are removed.
6. Mount the staged root in a disposable Compose project on a free loopback port,
   with a copied deterministic/readonly content snapshot. Confirm `/readyz`,
   owner sign-in, account/member state, catalog, playback state, audit history,
   and backup listing. Do not point this rehearsal at the live content path.
7. Change only `NEBULA_DATA_PATH` to the staged root and start the normal project.
   Keep the old root untouched for rollback.

If validation fails, stop the rehearsal, delete only the new staged root, and
continue using the old root. Offline restore cannot reconstruct content because
the bundle explicitly omits it.

## Upgrade and rollback rehearsal

Pin deployments to a reviewed commit or tag. Before changing it, create and
inspect a backup, snapshot/copy content, record the current Git revision and
image ID, and rehearse against copies:

```sh
git rev-parse HEAD
docker compose --env-file .env -f compose.deploy.yaml images
./scripts/nebula-server.sh backup \
  --token-file "$HOME/.nebula-admin-token" \
  --backup-id "before-upgrade-$(date -u +%Y%m%d)"
git fetch --tags
git status --short
git switch --detach <reviewed-tag-or-commit>
./scripts/nebula-server.sh update
```

`update` validates the retained configuration, runs the deployment Compose
equivalent of `build --pull` and `up -d`, then waits for readiness. It deliberately
does not fetch, pull, switch, or otherwise mutate the checkout; revision choice
remains an explicit operator action. Do not switch revisions with a dirty tree.

Migrations run at startup and may make an upgraded data root unsuitable for an
older binary. Rollback means stopping the new version, restoring the pre-upgrade
backup into a **new** data root, switching the path, checking readiness, and
starting the previously recorded revision/image. Never run the old binary on a
database already migrated by a newer version. Rehearse fresh install, copied
volume upgrade, and rollback before the real maintenance window.

Graceful shutdown handles SIGTERM, stops the HTTP server/worker and playback
deliveries, clears generated delivery sessions, closes Vite, then closes
SQLite. Use `docker compose ... stop` or `down`; the example grants 45 seconds.
Do not kill the container or host during database/backup activity unless there
is no alternative.

## Environment reference

Values are strings. Blank means unset unless stated otherwise.

| Variable | Default | Secret | Meaning and security impact |
| --- | --- | --- | --- |
| `HOST` | `0.0.0.0` | No | Internal listen address. Deployment pins it; use port publishing for exposure. |
| `PORT` | `5173` | No | Internal HTTP port. Deployment pins it to match health checks and mapping. |
| `DASHBOARD_PORT` | `5173` | No | Development Compose host port only; not read by the app. |
| `NEBULA_BIND_ADDRESS` | `127.0.0.1` | No | Deployment example host bind. `0.0.0.0` exposes it to reachable interfaces. |
| `NEBULA_PORT` | `5173` | No | Deployment example host port. |
| `NEBULA_UID`, `NEBULA_GID` | `1000` | No | Runtime numeric identity; must own mounted directories. |
| `NEBULA_CONTENT_PATH` | required | Sensitive path | Host content bind. Media is not backed up by Nebula. |
| `NEBULA_DATA_PATH` | required | Sensitive path | Host state bind; protect as credentials. |
| `NEBULA_BACKUP_PATH` | required | Sensitive path | Backup bundle bind; protect like live data. |
| `NEBULA_DATA_ROOT` | repo `data/` | Sensitive path | Absolute server state root; deployment uses `/app/data`. |
| `NEBULA_BACKUP_ROOT` | `<data>/backups` | Sensitive path | Absolute backup bundle root; deployment separates it. |
| `NEBULA_RESTORE_STAGING_ROOT` | `<data>/restore-staging` | Sensitive path | Logged startup path reserved for offline staging; no online restore route. |
| `NEBULA_REQUIRE_AUTH` | `false` | No | Requires configured legacy service token for otherwise unauthenticated requests. Account auth remains active regardless. |
| `NEBULA_API_TOKEN` | blank | **Yes** | Legacy bearer with owner/server-admin power. Use a long random secret, never a normal user's token. Empty disables this credential. |
| `NEBULA_AUTH_ALLOW_LOCALHOST` | `true` in code/dev; `false` in deployment | No | Exempts socket-loopback callers from legacy service-token enforcement. Host/forwarded headers do not qualify. Disable for predictable admin checks. |
| `NEBULA_FIRST_RUN_GUEST_ENABLED` | `true` in code/dev; `false` in deployment | No | Enables only eligible, trusted-local, pre-owner guest entry. Reverse proxies can make clients appear local. |
| `NEBULA_GUEST_SESSION_TTL_MS` | `28800000` | No | Guest lifetime in milliseconds; numeric. Guests remain memory-only and capability-limited. |
| `NEBULA_CORS_ALLOWED_ORIGINS` | blank extras | No | Exact comma-separated additions to built-in API origins. Never use broad/untrusted origins. |
| `NEBULA_VITE_ALLOWED_HOSTS` | blank | No | Exact comma-separated hostnames Vite accepts in addition to defaults; needed behind some proxies. |
| `NEBULA_AUDIT_RETENTION_DAYS` | `90` | No | Audit age; invalid values fall back to 90, then clamp to 1-3650 days. |
| `NEBULA_AUDIT_MAX_EVENTS` | `10000` | No | Audit count; invalid values fall back to 10000, then clamp to 100-100000. |
| `TMDB_API_TOKEN` | blank | **Yes** | Fallback TMDB Read Access Token. Owner-saved database setting takes precedence and is also secret. Cinema works without it. |
| `TMDB_API_BASE_URL` | `https://api.themoviedb.org/3` | No | Code/test override for TMDB endpoint; omit in normal deployment to prevent credential redirection. |
| `GOOGLE_VISION_API_KEY` | blank | **Yes** | Optional visual-identification credential. Avoid unless that experimental flow is intentionally used. |
| `VITE_API_BASE_URL` | blank | Endpoint | Build-time client API URL, baked into web/iOS assets. Runtime Client Server URL overrides it. Do not embed tokens. |
| `NEBULA_IOS_DEV_SERVER_URL` | `http://127.0.0.1:${DASHBOARD_PORT}` | Endpoint | iOS dev-sync helper input; baked as `VITE_API_BASE_URL`. Real phones need a LAN/private URL. |
| `PLAYWRIGHT_BASE_URL` | `http://dashboard:5173` | No | E2E runner target only. |
| `CI` | unset | No | Playwright retry/worker/forbid-only behavior only. |
| `CHOKIDAR_USEPOLLING` | `true` in dev Compose | No | Development file watching only; absent from deployment. |

`COMPOSE_PROJECT_NAME` and `DASHBOARD_PORT` are Compose/test isolation controls,
not application security settings. Quote tokens and URLs in shell usage and use
an owner-readable env file or secret manager. Compose environment values are
visible to users who can inspect the container; Docker access is root-equivalent.

## Troubleshooting

- **Setup appears again:** you mounted an empty/wrong data path or lack write
  permission. Stop immediately and verify `NEBULA_DATA_PATH`; do not create a
  second owner if existing data was expected.
- **`readyz` is 503 while `healthz` is 200:** check owner/admin readiness detail
  and logs. Typical causes are unwritable content/data, less than 1 GiB free,
  stale worker, or a failed/stale catalog scan.
- **Container exits or bind directory is empty/root-owned:** pre-create it and
  make its numeric ownership match `NEBULA_UID:GID`; inspect SELinux labeling on
  enforcing hosts.
- **Media missing:** confirm the host content path, file read permissions, regular
  files rather than escaping symlinks, and supported extensions. Trigger a scan.
- **Probe/remux/transcode fails:** verify `docker compose ... exec dashboard
  ffprobe -version` and `ffmpeg -version`; inspect logs and free space. Hardware
  acceleration is optional, defaults to software-only, and is available only
  after a real container self-test. See `docs/hardware-transcoding.md`.
- **Subtitle missing:** only adjacent `.vtt`/`.srt` sidecars up to 10 MiB and
  probed embedded streams are discovered. Unsafe names/symlinks are ignored;
  no external subtitle download provider is shipped.
- **iPhone cannot connect:** use the server LAN IP, not phone localhost; confirm
  Wi-Fi client isolation/firewall, Server URL, exact CORS origin, and TLS trust.
- **401/403:** distinguish account bearer/cookie from the legacy API token.
  Cookie mutations also need the per-session CSRF header. Library grants can
  intentionally return non-disclosing denials.
- **Guest option absent:** it is disabled, an owner/owner marker already exists,
  the request socket is not trusted-local, or the eligibility window is closed.
- **TMDB unavailable:** configure the owner setting or token and outbound HTTPS;
  core library/manual metadata remain available offline.

## Release checklist

- Pin and record the source revision; review migrations and unsupported-mode
  statements. Validate both Compose files with `docker compose config`.
- Build in Docker; run `npm run check`, the complete Node tests, and
  `./scripts/test-e2e.sh`. Retain no Playwright artifacts in the commit.
- Run iOS web sync and simulator build on supported Xcode; test a notched
  simulator, Keychain persistence/revocation, and real-device LAN URL behavior.
- Exercise an isolated fresh install: guest disabled and enabled, owner setup,
  reload/session persistence, member creation, and guest-to-owner revocation.
- Exercise an isolated copied-volume upgrade and a rollback using a restored
  pre-upgrade backup in a new root.
- Create, inspect, tamper-check, and no-clobber restore a backup; separately
  restore deterministic media and confirm ownership/permissions.
- Check liveness, readiness failure modes, authenticated metrics/admin detail,
  logs, graceful restart persistence, and clean shutdown.
- Verify Files uploads, catalog scan/probe, direct media ranges, software
  remux/transcode path where supported, playback limits, and subtitle sidecars.
- Inspect tracked files and built/generated iOS assets for secrets, tokens,
  absolute paths, usernames, media names, SQLite/WAL, `content`, `data`, `dist`,
  `node_modules`, Playwright output, and `ios/App/App/public` leakage.
- Confirm hardware status claims are backed by a real in-container self-test;
  do not imply external subtitle acquisition, live TV, DVR, DLNA, casting,
  plugins, HA, or public internet hardening. Do not publish or push an image
  from this checklist.
