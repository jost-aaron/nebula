# Arcade Moonlight Feasibility

This note captures the current plan for turning the planned Arcade app into a
Moonlight/Sunshine client surface later. The short version is:

```text
Arcade frontend and WebGPU compositor: feasible.
Moonlight Core directly inside the normal browser page: not the first path.
Moonlight Core in a native sidecar/plugin/runtime: the recommended path.
```

## Product Intent

Arcade should feel like a console game tile, not like a web link to another
application. The user should be able to:

- Add one or more gaming hosts.
- Pair with a Sunshine or GameStream-compatible host.
- See host status, stream capability, and connection diagnostics.
- Pick a desktop or game.
- Press Open and fade into a full-screen stream.
- Use controller, keyboard, mouse, and touch input where supported.
- Return to the Nebula dashboard through the same app surface close path.

This fits the current dashboard direction: app-first navigation, controller-
friendly flows, and dense native-console surfaces.

## Relevant Moonlight Pieces

The primary reusable library is:

- `moonlight-common-c`: https://github.com/moonlight-stream/moonlight-common-c

That library contains the shared GameStream client code used by Moonlight
clients. Its public header exposes the useful integration boundary for Nebula:

- `LiStartConnection(...)` starts a stream.
- `STREAM_CONFIGURATION` describes requested width, height, FPS, bitrate,
  packet size, audio configuration, codec formats, color space, color range,
  and encryption flags.
- `DECODER_RENDERER_CALLBACKS` lets the client provide setup/start/stop/cleanup
  hooks and a `submitDecodeUnit` callback.
- `DECODE_UNIT` carries assembled Annex B elementary stream data for video
  frames, along with timing, frame type, HDR, color space, and RTP timestamp
  metadata.
- `AUDIO_RENDERER_CALLBACKS` provides Opus audio samples.
- Connection listener callbacks expose initialization stages, connection
  status, termination errors, HDR state, rumble, controller LEDs, motion events,
  and adaptive trigger changes.
- Input APIs send mouse, keyboard, touch, pen, and controller events back to the
  host.

Moonlight PC is also useful as a reference implementation:

- `moonlight-qt`: https://github.com/moonlight-stream/moonlight-qt

The Moonlight Qt implementation shows that the reusable core is only one layer.
The client still needs platform networking, decoder selection, hardware decode,
audio output, renderer backends, input capture, controller rumble, overlays, and
failure handling.

Sunshine is the likely host side for non-NVIDIA-only setups:

- Sunshine docs: https://docs.lizardbyte.dev/projects/sunshine/latest/

## Feasibility Summary

| Approach | Feasibility | Notes |
| --- | --- | --- |
| Pure Vite/browser app plus Moonlight Core compiled to WASM | Low | Browser pages do not expose the raw TCP/UDP sockets Moonlight Core expects. |
| Browser Arcade UI plus native Moonlight sidecar | High | Best first serious architecture. Keeps Nebula web UI and gives Moonlight Core native networking/decode access. |
| Capacitor plugin using Moonlight Core | High conceptually | Good mobile path, but frame handoff into a web surface needs careful native design. |
| WebTransport/WebRTC bridge into WebCodecs/WebGPU | Medium | Possible if a sidecar translates Moonlight traffic into browser-compatible media/control channels. Adds custom bridge work and latency risk. |
| Chrome Isolated Web App with Direct Sockets | Medium-low | Interesting Chrome-only experiment; not portable to normal browsers or iOS. |
| Full native Nebula runtime with Moonlight Core plus wgpu/Dawn | High long term | Cleanest console-style endgame if Nebula moves beyond browser-first runtime. |

## Why A Normal Browser Page Is The Wrong First Target

Moonlight Core is native C code that uses platform sockets, threading, timing,
and UDP/TCP behavior. Compiling it to WebAssembly does not automatically provide
the missing network capabilities.

Normal web pages are limited to browser-approved transports such as HTTP,
WebSocket, WebRTC, and WebTransport. WebSocket does not provide raw access to the
underlying network, and WebTransport is HTTP/3 over QUIC with streams and
datagrams, not arbitrary raw UDP to an existing GameStream host.

Useful references:

- WebSocket standard: https://websockets.spec.whatwg.org/
- MDN WebTransport API: https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API
- Chrome Direct Sockets for Isolated Web Apps: https://developer.chrome.com/docs/iwa/direct-sockets
- Emscripten networking notes: https://emscripten.org/docs/porting/networking.html

Direct Sockets may eventually matter for a Chrome-only packaged experiment, but
that should not drive the main product architecture.

## Why WebGPU Still Matters

WebGPU is not the video decoder. It is the presentation and compositor layer.

A browser-compatible Arcade stream renderer could eventually look like this:

```text
Moonlight sidecar/plugin
  -> encoded H.264/HEVC/AV1 frames
  -> browser transport bridge
  -> WebCodecs VideoDecoder
  -> VideoFrame
  -> GPUDevice.importExternalTexture(VideoFrame)
  -> WebGPU compositor
  -> Arcade full-screen surface
```

This is a plausible rendering path because WebCodecs exposes decoded
`VideoFrame` objects, and WebGPU can import an `HTMLVideoElement` or `VideoFrame`
as a `GPUExternalTexture`.

Useful references:

- MDN WebCodecs API: https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API
- MDN VideoDecoder: https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder
- MDN `GPUDevice.importExternalTexture()`: https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/importExternalTexture
- Chrome WebGPU/WebCodecs integration: https://developer.chrome.com/blog/new-in-webgpu-116

The practical constraints are codec support, platform support, frame pacing,
audio synchronization, latency, and whether the sidecar can deliver frames to
the web layer without excessive copies.

## Recommended Architecture

The best near-term design is a layered Arcade system:

```text
src/arcade/
  renderArcadeView.ts       Browser UI for hosts, pairing, sessions, settings.
  arcadeClient.ts           HTTP/WebSocket client for Arcade backend state.
  streamRenderer.ts         Later WebGPU/WebCodecs stream compositor.

server/arcade.mjs
  Host CRUD and pairing/session API facade.
  Talks to native sidecar or plugin when available.
  Provides mock/dev state when no bridge exists.

native sidecar/plugin
  moonlight-common-c
  Sunshine/GameStream pairing and session control.
  Native socket transport.
  Decoder or encoded-frame forwarding.
  Audio output or audio-frame forwarding.
  Input forwarding and controller feedback.
```

Frontend responsibilities:

- Render host library and connection state.
- Store user-facing preferences such as resolution, FPS, bitrate, HDR,
  controller mode, and preferred codec.
- Show pairing, launch, reconnect, and failure states.
- Capture controller-friendly commands.
- Render overlays: latency, bitrate, dropped frames, codec, host processing
  latency, transport state, and input mode.
- Own the Nebula transition into and out of the stream.

Moonlight bridge responsibilities:

- Discover or connect to hosts.
- Pair and persist host credentials securely.
- Start, resume, and stop Moonlight sessions.
- Call Moonlight Core APIs and translate callbacks into Nebula session events.
- Handle native sockets, packet pacing, stream timing, decode, audio, and input
  forwarding.
- Report errors using Moonlight stage names and termination codes.

## API Sketch

The backend API should remain small and product-shaped:

```text
GET    /api/arcade/hosts
POST   /api/arcade/hosts
PATCH  /api/arcade/hosts/:id
DELETE /api/arcade/hosts/:id

POST   /api/arcade/hosts/:id/pair/start
POST   /api/arcade/hosts/:id/pair/confirm

GET    /api/arcade/hosts/:id/apps
POST   /api/arcade/sessions
GET    /api/arcade/sessions/:id
DELETE /api/arcade/sessions/:id

GET    /api/arcade/capabilities
GET    /api/arcade/events
```

`/api/arcade/events` could begin as server-sent events for lifecycle/status. A
future stream transport should be a separate concern from status events.

Example host shape:

```ts
interface ArcadeHost {
  id: string;
  name: string;
  address: string;
  status: "unknown" | "online" | "offline" | "paired" | "streaming";
  provider: "sunshine" | "gamestream";
  lastSeenAt?: string;
  capabilities?: ArcadeHostCapabilities;
}
```

Example stream settings:

```ts
interface ArcadeStreamSettings {
  width: number;
  height: number;
  fps: 30 | 60 | 90 | 120;
  bitrateMbps: number;
  codec: "auto" | "h264" | "hevc" | "av1";
  hdr: "auto" | "off" | "on";
  audio: "stereo" | "5.1" | "7.1";
}
```

## Prototype Plan

### Phase 1: Arcade Frontend Shell

Build the Arcade app surface without streaming:

- Add `src/arcade/renderArcadeView.ts`.
- Add a full-screen Arcade surface in `src/main.ts`.
- Render host cards, Add Host, Pair, Test Connection, and Stream Settings.
- Add a controller diagnostics panel using browser Gamepad API where available.
- Add mock session states: pairing, connecting, streaming, poor connection,
  disconnected.
- Add documentation and manual browser checks.

This phase should be possible entirely inside the current Docker/Vite workflow.

### Phase 2: Sidecar Spike

Create a separate native proof of concept outside the browser page:

- Link `moonlight-common-c`.
- Connect to a known Sunshine host.
- Exercise pairing and session launch.
- Register video/audio/connection callbacks.
- Confirm decode units arrive.
- Forward a minimal input event.
- Stop cleanly and report Moonlight stages/errors.

This phase can live outside the normal dashboard container at first. Do not add
host dependencies to the project tree or violate the Docker-first frontend
workflow.

See `docs/arcade-sidecar-spike.md` for the concrete future spike plan,
including process model, IPC messages, pairing-secret questions, callback
translation, dependency inventory, proof-of-life milestones, risks, and
non-goals.

### Phase 3: Backend Facade

Add `server/arcade.mjs` as a facade:

- Persist host records under ignored or local development state.
- Expose host/session APIs.
- Talk to the sidecar over a local control channel.
- Provide mock state when the sidecar is unavailable.

This mirrors the current Files and Cinema split: browser app surface plus local
API.

### Phase 4: Stream Rendering Spike

Try the lowest-risk render path first:

1. Native sidecar decodes or translates the stream.
2. Browser receives a browser-friendly stream.
3. Arcade presents it in a dedicated stream surface.
4. WebGPU samples from `HTMLVideoElement` or `VideoFrame` for overlays and
   scaling.

After that works, evaluate a lower-level encoded-frame path:

```text
sidecar -> encoded chunks -> WebCodecs -> VideoFrame -> WebGPU
```

## Open Questions

- Should the bridge decode natively, or should the frontend decode with
  WebCodecs?
- How much extra latency does each bridge strategy add?
- Can audio stay native in the sidecar while video is composited in WebGPU, or
  does that make sync too hard?
- Which target comes first: desktop browser with sidecar, Capacitor iOS, or a
  future native desktop shell?
- Where should pairing secrets live, and how are they protected?
- How should controller rumble, LEDs, gyro, and adaptive triggers map through
  browser, native, and sidecar APIs?
- What is the fallback when WebGPU or WebCodecs is unavailable?
- How should Arcade handle HDR and color space negotiation?
- How do we keep the streaming session alive when the dashboard loses focus or
  a mobile OS backgrounds the app?

## Licensing Note

Moonlight clients and common components are GPL-3.0 licensed. If Nebula links or
distributes Moonlight Core directly, distribution and source obligations need to
be handled intentionally. This is probably fine for a personal/open-source
direction, but it should be treated as an architectural constraint before any
packaged release.

Relevant project pages:

- Moonlight: https://moonlight-stream.org/
- Moonlight GitHub organization: https://github.com/moonlight-stream
- Moonlight Qt: https://github.com/moonlight-stream/moonlight-qt
- Moonlight common C: https://github.com/moonlight-stream/moonlight-common-c

## Current Recommendation

Design Arcade now as the host/session/control surface. Do not block the UI on
the streaming engine.

When implementation starts, build the app shell and mocked lifecycle first, then
spike a native Moonlight Core bridge. Treat WebGPU as the final presentation
layer for stream frames, overlays, scaling, and transition effects rather than
as a replacement for decode or transport.
