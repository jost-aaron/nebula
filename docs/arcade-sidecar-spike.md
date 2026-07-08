# Arcade Moonlight Sidecar Spike

This note turns the sidecar idea from `docs/arcade-moonlight.md` into a
concrete future spike plan. It is deliberately documentation-only for the big
Arcade/Moonlight PR: no native dependencies, vendored Moonlight code, build
scripts, or host-installed tools should be added here.

## Goal

Prove that Nebula can drive a native process that embeds `moonlight-common-c`
while the dashboard remains a browser/Vite app.

The proof should answer four questions:

- Can the sidecar pair with a known Sunshine or GameStream-compatible host?
- Can it start a Moonlight session and receive video/audio callbacks?
- Can Nebula control that lifecycle through a small local IPC API?
- Can session state, errors, and input events be translated into product-shaped
  Arcade UI states?

The first spike does not need to render a playable stream inside Nebula.
Receiving decode units, reporting callback activity, and stopping cleanly are
enough for proof of life.

## Process Model

The recommended first implementation is a separate local native sidecar process:

```text
Nebula browser UI
  -> server/arcade.mjs
    -> local sidecar control channel
      -> moonlight-common-c
        -> Sunshine/GameStream host
```

Responsibilities stay split:

- The Arcade frontend renders host/session state and captures user intent.
- `server/arcade.mjs` owns HTTP endpoints, validation, mock fallback state, and
  sidecar supervision.
- The sidecar owns native networking, Moonlight Core callbacks, pairing/session
  calls, native decode experiments, and low-level input forwarding.

Start with one sidecar process for all Arcade work. It should idle when no
session is active and accept control messages for host discovery, pairing, app
listing, session start, input, and stop. Later, if lifecycle isolation becomes
important, session streaming could move into a child worker process while the
main sidecar remains the supervisor.

## Control Channel

Use a local IPC channel that is easy to inspect during development. The first
candidate should be newline-delimited JSON over a loopback TCP socket or Unix
domain socket:

```text
server/arcade.mjs <-> sidecar
```

Keep stream media separate from control. The control channel reports status and
accepts commands; it should not carry high-volume video frames in the first
spike.

Message envelope:

```ts
interface ArcadeSidecarMessage<T = unknown> {
  id?: string;
  type: string;
  sessionId?: string;
  hostId?: string;
  time: string;
  payload?: T;
}
```

Command examples:

```text
sidecar.capabilities
host.discover
host.add
host.pair.start
host.pair.confirm
host.apps.list
session.start
session.stop
input.keyboard
input.mouse
input.gamepad
sidecar.shutdown
```

Event examples:

```text
sidecar.ready
sidecar.error
host.discovered
host.status
pairing.started
pairing.failed
pairing.succeeded
session.stage
session.started
session.stats
session.decode_unit
session.audio_packet
session.terminated
input.feedback
```

`session.decode_unit` and `session.audio_packet` should be counters/metadata in
the first spike, not raw payloads. Example:

```json
{
  "type": "session.decode_unit",
  "sessionId": "sess_123",
  "time": "2026-07-08T00:00:00.000Z",
  "payload": {
    "frameNumber": 42,
    "frameType": "idr",
    "byteLength": 184320,
    "rtpTimestamp": 12345678,
    "hdr": false
  }
}
```

This lets Arcade prove that Moonlight Core is alive before choosing a video
handoff path.

## Backend API Mapping

`server/arcade.mjs` should translate browser-facing API requests into sidecar
commands:

```text
GET  /api/arcade/capabilities
  -> sidecar.capabilities

POST /api/arcade/hosts/:id/pair/start
  -> host.pair.start

POST /api/arcade/hosts/:id/pair/confirm
  -> host.pair.confirm

GET  /api/arcade/hosts/:id/apps
  -> host.apps.list

POST /api/arcade/sessions
  -> session.start

DELETE /api/arcade/sessions/:id
  -> session.stop

POST /api/arcade/sessions/:id/input
  -> input.keyboard | input.mouse | input.gamepad

GET /api/arcade/events
  <- sidecar event stream
```

The browser should continue using HTTP and server-sent events or WebSocket for
status. It should not talk directly to the native sidecar in the initial design.
That keeps auth, API base URL behavior, and native-client routing centralized.

## Pairing And Secret Storage Questions

The first research pass must identify what Moonlight Core and Sunshine require
for persistent pairing material. Do not invent a permanent storage model until
the sidecar can pair and reconnect.

Questions to answer:

- Which certificate, key, PIN, UUID, and host metadata are required to reconnect
  without re-pairing?
- Does `moonlight-common-c` expect the embedding client to generate and persist
  client certificates?
- Which values are secrets versus ordinary host metadata?
- Where should secrets live for Docker development, desktop native shells, and
  Capacitor/mobile clients?
- Should the sidecar use the OS keychain/keyring when available?
- What is the local development fallback when no keychain exists?
- How should exports/backups work, if at all?
- How are stale or compromised pairings removed?

Until those answers exist, use an ignored development store for any spike-only
pairing state and document its path. Do not commit real host certificates,
tokens, PINs, or pairing artifacts.

## Callback Translation

Moonlight Core callbacks should be translated into stable sidecar events before
they reach `server/arcade.mjs`.

Connection callbacks:

- Map Moonlight stage names into `session.stage` events.
- Preserve raw stage/error details in a diagnostic field.
- Also provide product states like `connecting`, `paired`, `streaming`,
  `degraded`, `terminating`, and `failed`.

Video callbacks:

- Count submitted decode units.
- Report codec, frame type, byte length, RTP timestamp, color space, HDR state,
  and timing metadata when available.
- Do not forward full frame payloads over the control channel.

Audio callbacks:

- Count audio packets/samples.
- Report format, channel layout, sample rate, and underrun/late indicators when
  available.

Input and feedback callbacks:

- Translate browser keyboard/mouse/gamepad messages into Moonlight input APIs.
- Report rumble, LED, motion, and adaptive-trigger feedback as
  `input.feedback` events even if the browser cannot yet act on every feature.

Errors:

- Preserve native error codes and Moonlight termination reasons.
- Add user-facing categories such as `host_unreachable`, `pairing_failed`,
  `auth_failed`, `codec_unsupported`, `network_timeout`, and `sidecar_crashed`.

## Native Dependencies To Investigate

The spike should create an inventory before adding dependencies to the project:

- C compiler and build system needed for `moonlight-common-c`.
- TLS/crypto requirements used by pairing and session setup.
- Platform socket behavior for TCP/UDP and packet pacing.
- Threading/timer requirements.
- Opus audio decode/output needs.
- Video decode path options: native hardware decode, software decode for
  diagnostics, or encoded-frame forwarding.
- Controller/input libraries needed for rumble, LEDs, gyro, and adaptive
  triggers outside the browser.
- Packaging model for macOS first, then Linux/Windows if this becomes a desktop
  app path.
- Whether Docker can build the sidecar repeatably for development without
  installing tools on the host.

The inventory should include license notes for every native dependency. Moonlight
Core licensing already affects distribution; transitive native libraries may add
their own obligations.

## Proof-Of-Life Milestones

1. Build a tiny sidecar outside the dashboard runtime that starts, logs
   `sidecar.ready`, and exits on command.
2. Link `moonlight-common-c` in an isolated spike environment.
3. Load one manually configured Sunshine host from ignored local state.
4. Start pairing, surface the PIN flow, and persist only spike-local pairing
   material.
5. Reconnect to the paired host without entering a new PIN.
6. List launchable host apps or desktop entries if the host exposes them.
7. Start a session with conservative H.264/1080p/60 settings.
8. Emit connection stage events.
9. Count video decode units and audio callbacks.
10. Forward one minimal input event, such as a key press or gamepad button.
11. Stop the session cleanly and report the final termination reason.
12. Crash or kill the sidecar intentionally and verify `server/arcade.mjs`
    reports a recoverable sidecar-unavailable state.

Only after these pass should a later spike choose a frame handoff strategy for
WebCodecs/WebGPU or native decode/presentation.

## Risks

- Browser Arcade UI may be ready before any native runtime exists to ship the
  sidecar cleanly.
- Pairing secret storage may differ sharply between Docker development,
  desktop packaging, and mobile clients.
- A sidecar-to-browser video bridge can add latency or copies that make gameplay
  feel worse than launching Moonlight directly.
- Codec support varies by platform, especially HEVC, AV1, HDR, 10-bit, and
  high-frame-rate modes.
- Audio/video sync may become difficult if audio is native while video is
  browser-composited.
- Controller feedback features may not round-trip through browser APIs.
- Sidecar crashes must not take down the dashboard server.
- GPL obligations must be understood before distributing a linked Moonlight Core
  build.

## Non-Goals For This PR

- No real Moonlight Core integration.
- No vendored Moonlight repositories or source archives.
- No native sidecar build scripts.
- No host dependency installation.
- No production pairing secret store.
- No real Sunshine pairing UI beyond mock/control-surface planning.
- No video frame transport, WebCodecs decoder, or WebGPU stream compositor.
- No claim that Arcade can stream games yet.

## Next Documentation Update

When the sidecar spike is actually attempted, update this document with:

- The exact `moonlight-common-c` revision tested.
- Build environment and dependency inventory.
- Pairing artifacts required for reconnect.
- Callback fields observed in real sessions.
- Latency/copy notes for any attempted video handoff.
- A recommendation for the first production-quality sidecar architecture.
