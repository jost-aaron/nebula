# Mobile Clients

Nebula should treat mobile apps as clients, not as embedded media servers.

The recommended first native target is Capacitor:

- The existing Vite frontend is bundled into a native iOS shell.
- The iOS app talks to a Nebula server through a configurable Server URL.
- The media server, metadata store, and file APIs continue to run in Docker on
  the server machine.

## Current Scaffold

The repository now includes:

```text
capacitor.config.json
ios/
scripts/ios-sync.sh
scripts/ios-sync-dev-server.sh
scripts/ios-build-simulator.sh
src/api/http.ts
src/shared/cinemaTypes.ts
```

`capacitor.config.json` defines the native app identity:

```json
{
  "appId": "com.nebula.dashboard",
  "appName": "Nebula",
  "webDir": "dist"
}
```

`src/api/http.ts` supports both:

- `VITE_API_BASE_URL` for build-time API targeting.
- `localStorage["nebula.apiBaseUrl"]` for runtime client configuration.

The Settings app exposes this as:

```text
Settings -> Client -> Server URL
```

It also exposes:

```text
Settings -> Client -> API Token
```

That token is sent as a bearer token by frontend API clients when configured.

This remains the legacy administrator/service token. Normal Capacitor sign-in
uses a separate revocable account bearer session stored by the first-party
`NativeSessionKeychain` iOS bridge, never WebView local storage. The service
token setting is intentionally separate and should be left blank for account
sign-in.

For localhost development, leave it blank. For a mobile client, set it to a
reachable server address such as:

```text
http://10.44.0.1:5173
https://nebula-server.example.internal
```

## iOS Packaging Path

Do not install Capacitor on the host during normal dashboard development. The
current project remains Docker-first.

When intentionally creating the iOS target, use a dependency update workflow
that also updates `package-lock.json`:

```sh
docker run --rm \
  -v "$PWD":/app \
  -v nebula_npm_tmp:/app/node_modules \
  -w /app \
  node:25-alpine \
  npm install @capacitor/core @capacitor/cli @capacitor/ios
```

Then create/sync the native project from a Mac with Xcode installed. For the
normal update path, use the helper script so the web build and Capacitor sync
still run through containerized Node:

```sh
./scripts/ios-sync.sh
```

The script creates `dist/` only long enough for Capacitor to copy the web bundle
into `ios/App/App/public/`, then removes the root `dist/` directory.

For simulator or local-device development, the iOS bundle can also be synced
with a default Server URL baked into the web assets:

```sh
./scripts/ios-sync-dev-server.sh
```

By default this points the iOS app at:

```text
http://127.0.0.1:5173
```

That is useful for the iOS simulator because simulator localhost reaches the
Mac. For a real iPhone on the same network, pass a reachable Mac LAN address:

```sh
NEBULA_IOS_DEV_SERVER_URL=http://192.168.1.20:5173 ./scripts/ios-sync-dev-server.sh
```

The in-app Settings -> Client -> Server URL still overrides the baked default.

To compile the simulator app from the command line:

```sh
./scripts/ios-build-simulator.sh
```

`ios/App/App/NativeSessionKeychainPlugin.swift` is tracked native source. Sync
may regenerate `ios/App/App/public/`; never commit that directory. After changing
the bridge, run both sync and simulator build. No additional host npm install is
required.

### Manual Keychain simulator verification

1. Start an isolated Docker server, sync with its URL, build, install, and launch
   on a booted simulator using the commands in `docs/testing.md`.
2. Sign in, quit the app, relaunch, and confirm the account is restored.
3. In Safari Web Inspector, confirm no local-storage key beginning with
   `nebula.accountSessionToken:` exists and no bearer value appears in rendered
   HTML or console output.
4. Change Settings -> Client -> Server URL. Confirm the app returns to the account
   gate and does not authenticate the new server with the old credential.
5. Sign in again, then Sign out (and separately revoke the current device from
   another session). Relaunch and confirm sign-in is required.
6. Test an upgrade by installing a newer build without uninstalling; the session
   should remain. Test reinstall separately: iOS can preserve same-device
   Keychain data after deletion, so revoke/sign out before uninstall when a clean
   state is required. `xcrun simctl erase <UDID>` provides a deterministic clean
   simulator.
7. To exercise unavailable storage, boot the simulator but do not unlock it after
   restart; the client must show sign-in instead of falling back to local storage.
   A malformed Keychain item is deleted by the bridge and also fails closed.

For command-line simulator checks, use Xcode's developer directory explicitly if
plain `xcrun` cannot find `simctl`:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl list devices available
```

Nebula's web bundle includes `viewport-fit=cover`, and the shared CSS maps iOS
safe-area insets into `--safe-area-*` variables. The dashboard and Cinema
surfaces should be verified on a notched simulator or device after layout
changes to make sure content clears the Dynamic Island/status bar and home
indicator.

If Xcode is installed but the command-line tools still point at
`/Library/Developer/CommandLineTools`, either set `DEVELOPER_DIR` for the
command:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer ./scripts/ios-build-simulator.sh
```

or select Xcode globally:

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

If no iOS simulator runtime is installed, download it from Xcode Settings ->
Components or use:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -downloadPlatform iOS
```

To open the project in Xcode:

```sh
open ios/App/App.xcodeproj
```

Capacitor expects built web assets in `dist` during sync. Generating release
assets is a separate packaging step from normal Docker development. Do not leave
ad-hoc host `dist/` output behind after local experiments.

## Networking Model

Mobile clients should not require the Nebula server to be public on the
internet. Supported access patterns should be:

- Same LAN.
- WireGuard/Tailscale/Headscale private network.
- Future relay/broker if needed.

The app should only need a Server URL and auth/device pairing. It should not
care which private network implementation makes that URL reachable.

The iOS wrapper allows local HTTP networking for web content so simulator and
same-LAN development URLs can be used from Settings -> Client -> Server URL, for
example:

```text
http://127.0.0.1:5173
http://10.44.0.1:5173
```

Production deployments should prefer HTTPS when the server is reachable through
a stable private DNS name or tunnel.

Nebula's dormant deployment companion can expose private HTTPS through Tailscale
Serve without a public port or router forwarding. An owner enables it under
Settings / Remote Access. Install the official Tailscale
app on the iPhone, join the authorized tailnet, and set Client / Server URL to:

```text
https://nebula.<tailnet-name>.ts.net
```

The server must use the current Compose deployment and conservative account
settings documented in `deployment.md`. The existing `capacitor://localhost`
API origin remains valid. Native account tokens stay in the Keychain and Nebula
accounts remain required; Tailscale identity headers do not create or
authenticate Nebula users. Changing from a LAN URL to the Tailscale URL
intentionally removes the old URL-scoped Keychain session and requires sign-in.
This feature does not embed Tailscale or an Apple Network Extension in the
Capacitor application.

Server owners may complete the server node's initial enrollment from the web
dashboard under Settings / Remote Access. This does not enroll an iPhone or
replace the Tailscale iOS app: each client device must separately join the
authorized tailnet before its browser or Nebula client can reach the private
Serve URL.

Cross-origin `/api/*` requests from the iOS web view are supported through
minimal API-only CORS handling. The default explicit origin allowlist is
`capacitor://localhost`, `http://localhost:5173`, and
`http://127.0.0.1:5173`. It includes `PATCH` for Cinema metadata and watchlist
updates. Arbitrary origins are not reflected. The allowlist advertises
credentials and `X-Nebula-CSRF`; native bearer requests do not depend on
cross-origin cookies. Cinema and Studio receive expiring, path-bound media
tickets so HTML media elements retain byte-range playback without putting a
session token in the URL.

Add a trusted non-default browser or native origin as a comma-separated value
when starting Compose:

```sh
NEBULA_CORS_ALLOWED_ORIGINS='https://nebula-client.example.internal' \
docker compose up --build
```

If `NEBULA_REQUIRE_AUTH=true`, configure the same token in Settings -> Client
-> API Token. For an authentication check that cannot be bypassed by a local
connection, start the server with:

```sh
NEBULA_REQUIRE_AUTH=true \
NEBULA_API_TOKEN='<long-random-token>' \
NEBULA_AUTH_ALLOW_LOCALHOST=false \
docker compose up --build
```

## Next Steps

1. Add native device pairing on top of the Keychain-backed account session.
2. Add an automated iOS smoke path that launches the simulator and verifies
   Settings -> Client plus Files listing against a local server.
3. Split the Docker server into API, static client, and storage/database
   services when the product needs a more durable deployment shape.
4. Prefer HTTPS for non-local production deployments, even when the server is
   only reachable over a private network.
