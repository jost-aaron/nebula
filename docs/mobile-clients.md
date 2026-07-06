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

Then create/sync the native project from a Mac with Xcode installed:

```sh
npx cap add ios
npx cap sync ios
npx cap open ios
```

Capacitor expects built web assets in `dist`. Generating release assets is a
separate packaging step from normal Docker development. Do not leave ad-hoc
host `dist/` output behind after local experiments.

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
