# Roadmap

This is an early scaffold. The immediate goal is to create a strong foundation
for multiple dashboard apps and future native-style media playback.

## Near Term

- Continue moving app-surface rendering and feature bindings out of
  `src/main.ts`; typed shell state, persistence, commands, input gates, and
  gamepad lifecycle now live in `src/shell/`.
- Extend the current account-scoped shell focus persistence to app lifecycle
  state only where restoration is predictable and safe.
- Expand controller coverage from dashboard selection/launch/close into media
  transport and app-specific navigation.
- Make the WebGPU background respond to app focus.
- Keep broadening the Docker Playwright suite as new app workflows land; the
  account gate, shell navigation, responsive layout, and core media workflows
  now have browser coverage.
- Harden and package the single-host deployment CLI beyond its current
  no-clobber preview installer before recommending public-internet exposure.

## Media Sharding Direction

The next major media-platform expansion is a coordinator-and-shards cluster for
private Tailscale deployments. Clients should connect to one coordinator, see a
deduplicated Cinema and Studio catalog across every paired shard, and receive
media directly from the best authorized shard with exact-replica failover.

Start with session-level load balancing rather than splitting one playback
stream across servers. Multi-origin HLS remains a later measured experiment.
Read `docs/media-sharding-implementation-plan.md` before starting this work.

## App System

The current app registry is static data in `src/apps.ts`. A more capable system
will need:

- App manifest format.
- App lifecycle: install, launch, suspend, close.
- App permissions/capabilities.
- Deep links into app views.
- Background tasks.
- Notifications.

## Arcade Direction

Arcade should grow into a Moonlight/Sunshine-compatible game streaming client
surface. The recommended path is to build the Arcade frontend as the
host/session/control UI, then integrate Moonlight Core through a native sidecar,
plugin, or future native runtime. WebGPU should act as the presentation and
overlay compositor, not as a replacement for Moonlight transport or video
decode.

See:

- `docs/arcade-moonlight.md`
- `docs/arcade-sidecar-spike.md`

## Video Player Direction

The future video player should be treated as a first-class app and capability
testbed.

Likely concerns:

- Media library model.
- Playback queue.
- Subtitle and audio track controls.
- Hardware decode where available.
- Remote/controller transport controls.
- Picture, audio, and latency diagnostics.
- Native shell integration if this moves beyond browser-only runtime.

Browser prototype path:

- Start with HTML media primitives.
- Add custom UI and controller input.
- Add Media Session API.
- Investigate WebCodecs for advanced pipelines.

Native path:

- Keep the dashboard shell concepts portable.
- Evaluate Tauri, Electron, or a custom native shell later.
- For GPU portability, evaluate `wgpu` or Dawn if moving outside the browser.

## Rendering Direction

The renderer currently owns only the background. Future rendering work could add:

- Shared GPU effects surface.
- Transition animations between apps.
- App-specific shader themes.
- Diagnostics overlay.
- Device-lost recovery.

## Product Direction

This should feel like a modern console dashboard:

- Fast.
- Visually rich, but not decorative for decoration's sake.
- Controller-first.
- App-first.
- Media-capable.
- Calm enough for repeated daily use.
