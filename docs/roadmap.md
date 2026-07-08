# Roadmap

This is an early scaffold. The immediate goal is to create a strong foundation
for multiple dashboard apps and future native-style media playback.

## Near Term

- Split `src/main.ts` into smaller modules.
- Add persistent shell state.
- Add real focus management for accessibility and controller navigation.
- Add a command/input abstraction that can support keyboard, controller, and
  remote control inputs.
- Make the WebGPU background respond to app focus.
- Add Playwright smoke tests in Docker.

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
