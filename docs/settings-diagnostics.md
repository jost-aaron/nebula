# Settings And Diagnostics

Settings is the first system app with real runtime data. It uses the shared
renderer and diagnostics collectors.

## Current Scope

Launching the Settings app opens diagnostics sections inside the full-screen app
surface.

- Renderer
- Display
- Performance
- Apps
- GPU Limits
- Runtime
- Account
- Client

Account supports profile editing, password rotation, active-session
listing/revocation, sign out, and owner-only member creation/disable. Password
rotation revokes other sessions. Client remains the device-local Server URL and
optional legacy service-token configuration.

The panel is rendered by `src/settings/renderSettingsPanel.ts`.

Diagnostics are collected by `src/diagnostics/collectDiagnostics.ts`.

Frame timing is sampled by `src/diagnostics/performanceMonitor.ts`.

Shared types live in `src/diagnostics/types.ts`.

## Data Sources

Renderer:

- Current renderer mode from shell state.
- Adapter name from `startRenderer()`.
- Preferred canvas format from `navigator.gpu.getPreferredCanvasFormat()`.
- Optional WebGPU features from `GPUAdapter.features`.
- Selected WebGPU limits from `GPUAdapter.limits`.

Display:

- `window.innerWidth` / `window.innerHeight`
- `screen.width` / `screen.height`
- `window.devicePixelRatio`
- `screen.orientation`
- color scheme and reduced motion media queries

Performance:

- Rolling `requestAnimationFrame` samples.
- Estimated FPS.
- Average frame time.
- Runtime uptime.

Apps:

- App registry from `src/apps.ts`.
- Focused app index from shell state.
- Current navigation mode.
- Open panel/app state.

Runtime:

- Browser language.
- Platform.
- Network online state.
- User agent.

## Refresh Behavior

The panel is a snapshot when opened. It also refreshes once if the renderer
finishes initializing while Settings is open.

Do not replace the full Settings panel on a timer without preserving scroll
position and focus. Full rerenders can make diagnostics panels feel broken while
the user is scrolling or reading.

## Extension Ideas

- Add category navigation inside Settings.
- Add input/gamepad diagnostics.
- Add WebGPU device-lost status.
- Add a copy diagnostics button.
- Add warnings for unsupported or degraded capabilities.
- Add richer account preferences now that per-user persistence exists.
