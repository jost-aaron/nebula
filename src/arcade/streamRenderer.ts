export type ArcadeStreamRendererSupportState = "available" | "unavailable" | "unknown";

export type ArcadeStreamRendererPath =
  | "webgpu-webcodecs"
  | "webgpu-video-element"
  | "webcodecs-canvas"
  | "browser-video"
  | "setup-only";

export type ArcadeStreamRendererCodec = "h264" | "hevc" | "av1";

export interface ArcadeStreamRendererCapability {
  detail: string;
  label: string;
  state: ArcadeStreamRendererSupportState;
}

export interface ArcadeStreamRendererCapabilities {
  capabilities: ArcadeStreamRendererCapability[];
  externalTextureImport: ArcadeStreamRendererSupportState;
  htmlVideoElement: boolean;
  mockOnly: true;
  preferredPath: ArcadeStreamRendererPath;
  videoDecoder: boolean;
  videoFrame: boolean;
  webCodecs: boolean;
  webGpu: boolean;
  blockers: string[];
  notes: string[];
}

export interface ArcadeMockStreamDiagnosticsOptions {
  codec?: ArcadeStreamRendererCodec;
  fps?: number;
  height?: number;
  width?: number;
}

export interface ArcadeMockStreamDiagnostics {
  audioPath: "sidecar-later";
  codec: ArcadeStreamRendererCodec;
  decodePath: ArcadeStreamRendererPath;
  droppedFrames: number;
  externalTextureImport: ArcadeStreamRendererSupportState;
  frameSource: "mock";
  frameTransport: "none";
  fps: number;
  height: number;
  inputBridge: "planned";
  latencyMs: null;
  mockOnly: true;
  presentedFrames: number;
  renderer: "webgpu" | "browser" | "setup-only";
  status: "ready-for-prototype" | "capability-limited";
  width: number;
}

type BrowserGlobal = typeof globalThis & {
  GPUDevice?: {
    prototype?: {
      importExternalTexture?: unknown;
    };
  };
  HTMLVideoElement?: unknown;
  VideoDecoder?: unknown;
  VideoFrame?: unknown;
};

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = 60;
const DEFAULT_CODEC: ArcadeStreamRendererCodec = "h264";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const getBrowserGlobal = (): BrowserGlobal | null => {
  if (typeof globalThis === "undefined") {
    return null;
  }

  return globalThis as BrowserGlobal;
};

const getExternalTextureImportSupport = (browserGlobal: BrowserGlobal | null): ArcadeStreamRendererSupportState => {
  if (!browserGlobal) {
    return "unavailable";
  }

  if (!browserGlobal.navigator?.gpu) {
    return "unavailable";
  }

  const importExternalTexture = browserGlobal.GPUDevice?.prototype?.importExternalTexture;

  if (typeof importExternalTexture === "function") {
    return "available";
  }

  return "unknown";
};

const getPreferredPath = (
  webGpu: boolean,
  videoDecoder: boolean,
  videoFrame: boolean,
  htmlVideoElement: boolean,
  externalTextureImport: ArcadeStreamRendererSupportState
): ArcadeStreamRendererPath => {
  if (webGpu && videoDecoder && videoFrame && externalTextureImport !== "unavailable") {
    return "webgpu-webcodecs";
  }

  if (webGpu && htmlVideoElement && externalTextureImport !== "unavailable") {
    return "webgpu-video-element";
  }

  if (videoDecoder && videoFrame) {
    return "webcodecs-canvas";
  }

  if (htmlVideoElement) {
    return "browser-video";
  }

  return "setup-only";
};

const describePath = (path: ArcadeStreamRendererPath): string => {
  switch (path) {
    case "browser-video":
      return "Use a regular browser video surface until a GPU compositor is available.";
    case "setup-only":
      return "Keep Arcade usable as host/session setup without local stream presentation.";
    case "webcodecs-canvas":
      return "Decode with WebCodecs, then present through a non-WebGPU fallback path.";
    case "webgpu-video-element":
      return "Sample a browser video source with WebGPU for scaling and overlays.";
    case "webgpu-webcodecs":
      return "Decode VideoFrame objects with WebCodecs and import them into WebGPU.";
  }
};

export function readArcadeStreamRendererCapabilities(
  browserGlobal: BrowserGlobal | null = getBrowserGlobal()
): ArcadeStreamRendererCapabilities {
  const webGpu = Boolean(browserGlobal?.navigator?.gpu);
  const videoDecoder = typeof browserGlobal?.VideoDecoder === "function";
  const videoFrame = typeof browserGlobal?.VideoFrame === "function";
  const htmlVideoElement = typeof browserGlobal?.HTMLVideoElement === "function";
  const webCodecs = videoDecoder && videoFrame;
  const externalTextureImport = getExternalTextureImportSupport(browserGlobal);
  const preferredPath = getPreferredPath(webGpu, videoDecoder, videoFrame, htmlVideoElement, externalTextureImport);

  const blockers: string[] = [];
  const notes: string[] = [
    "This is a frontend capability probe only; no Moonlight transport or media stream is opened.",
    describePath(preferredPath)
  ];

  if (!webGpu) {
    blockers.push("WebGPU is unavailable, so Arcade cannot use the planned GPU compositor in this browser.");
  }

  if (!webCodecs) {
    blockers.push("WebCodecs VideoDecoder and VideoFrame are not both available for encoded-frame experiments.");
  }

  if (externalTextureImport === "unavailable") {
    blockers.push("WebGPU external texture import is unavailable without WebGPU support.");
  } else if (externalTextureImport === "unknown") {
    notes.push("GPUDevice.importExternalTexture could not be confirmed without an active GPU device constructor.");
  }

  const capabilities: ArcadeStreamRendererCapability[] = [
    {
      detail: webGpu ? "navigator.gpu is present." : "navigator.gpu is missing.",
      label: "WebGPU compositor",
      state: webGpu ? "available" : "unavailable"
    },
    {
      detail: videoDecoder ? "VideoDecoder constructor is present." : "VideoDecoder constructor is missing.",
      label: "WebCodecs decoder",
      state: videoDecoder ? "available" : "unavailable"
    },
    {
      detail: videoFrame ? "VideoFrame constructor is present." : "VideoFrame constructor is missing.",
      label: "VideoFrame source",
      state: videoFrame ? "available" : "unavailable"
    },
    {
      detail:
        externalTextureImport === "available"
          ? "GPUDevice.importExternalTexture is present."
          : externalTextureImport === "unknown"
            ? "WebGPU exists, but external texture import could not be confirmed yet."
            : "External texture import is unavailable.",
      label: "External texture import",
      state: externalTextureImport
    }
  ];

  return {
    capabilities,
    externalTextureImport,
    htmlVideoElement,
    mockOnly: true,
    preferredPath,
    videoDecoder,
    videoFrame,
    webCodecs,
    webGpu,
    blockers,
    notes
  };
}

export function createArcadeMockStreamDiagnostics(
  options: ArcadeMockStreamDiagnosticsOptions = {},
  capabilities: ArcadeStreamRendererCapabilities = readArcadeStreamRendererCapabilities()
): ArcadeMockStreamDiagnostics {
  const renderer =
    capabilities.preferredPath === "webgpu-webcodecs" || capabilities.preferredPath === "webgpu-video-element"
      ? "webgpu"
      : capabilities.preferredPath === "setup-only"
        ? "setup-only"
        : "browser";

  return {
    audioPath: "sidecar-later",
    codec: options.codec ?? DEFAULT_CODEC,
    decodePath: capabilities.preferredPath,
    droppedFrames: 0,
    externalTextureImport: capabilities.externalTextureImport,
    frameSource: "mock",
    frameTransport: "none",
    fps: options.fps ?? DEFAULT_FPS,
    height: options.height ?? DEFAULT_HEIGHT,
    inputBridge: "planned",
    latencyMs: null,
    mockOnly: true,
    presentedFrames: 0,
    renderer,
    status: capabilities.blockers.length > 0 ? "capability-limited" : "ready-for-prototype",
    width: options.width ?? DEFAULT_WIDTH
  };
}

export function renderArcadeStreamRendererCapabilitySummary(capabilities: ArcadeStreamRendererCapabilities): string {
  const capabilityRows = capabilities.capabilities
    .map(
      (capability) => `
        <li data-stream-capability="${escapeHtml(capability.state)}">
          <strong>${escapeHtml(capability.label)}</strong>
          <span>${escapeHtml(capability.state)}</span>
          <small>${escapeHtml(capability.detail)}</small>
        </li>
      `
    )
    .join("");

  const blockerRows =
    capabilities.blockers.length > 0
      ? capabilities.blockers.map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join("")
      : "<li>No frontend capability blockers detected for a mock renderer spike.</li>";

  const noteRows = capabilities.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");

  return `
    <section class="arcade-stream-renderer-diagnostics" data-arcade-stream-renderer>
      <header>
        <p class="eyebrow">Stream Renderer</p>
        <h3>${escapeHtml(capabilities.preferredPath)}</h3>
      </header>
      <ul class="arcade-stream-renderer-diagnostics__capabilities">
        ${capabilityRows}
      </ul>
      <div class="arcade-stream-renderer-diagnostics__notes">
        <strong>Blockers</strong>
        <ul>${blockerRows}</ul>
        <strong>Notes</strong>
        <ul>${noteRows}</ul>
      </div>
    </section>
  `;
}

export function renderArcadeMockStreamDiagnostics(diagnostics: ArcadeMockStreamDiagnostics): string {
  const resolution = `${diagnostics.width} x ${diagnostics.height}`;
  const latency = diagnostics.latencyMs === null ? "not measured" : `${diagnostics.latencyMs} ms`;

  return `
    <section class="arcade-stream-renderer-diagnostics" data-arcade-mock-stream>
      <header>
        <p class="eyebrow">Mock Stream</p>
        <h3>${escapeHtml(diagnostics.renderer)}</h3>
      </header>
      <dl class="arcade-stream-renderer-diagnostics__metrics">
        <div>
          <dt>Path</dt>
          <dd>${escapeHtml(diagnostics.decodePath)}</dd>
        </div>
        <div>
          <dt>Format</dt>
          <dd>${escapeHtml(resolution)} / ${diagnostics.fps} FPS / ${escapeHtml(diagnostics.codec.toUpperCase())}</dd>
        </div>
        <div>
          <dt>Frames</dt>
          <dd>${diagnostics.presentedFrames} presented / ${diagnostics.droppedFrames} dropped</dd>
        </div>
        <div>
          <dt>Latency</dt>
          <dd>${escapeHtml(latency)}</dd>
        </div>
        <div>
          <dt>Transport</dt>
          <dd>${escapeHtml(diagnostics.frameTransport)} / ${escapeHtml(diagnostics.audioPath)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>${escapeHtml(diagnostics.status)}</dd>
        </div>
      </dl>
    </section>
  `;
}

// This module intentionally performs no GPU/device work at import time. A later
// Arcade stream surface can use these probes before attempting WebCodecs decode
// or WebGPU external-texture presentation.
