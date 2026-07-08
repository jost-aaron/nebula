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

To compile the simulator app from the command line:

```sh
./scripts/ios-build-simulator.sh
```

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

## Next Steps

1. Add Capacitor dependencies through the containerized dependency workflow.
2. Generate and commit the `ios/` native project when ready.
3. Add device pairing/auth before exposing personal media APIs beyond localhost.
4. Split the Docker server into API, static client, and storage/database services.
