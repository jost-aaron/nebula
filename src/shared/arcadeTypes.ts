export type ArcadeHostProvider = "sunshine" | "gamestream";

export type ArcadeHostStatus =
  | "unknown"
  | "online"
  | "offline"
  | "paired"
  | "unpaired"
  | "connecting"
  | "streaming"
  | "poor-connection"
  | "disconnected";

export type ArcadeAppType = "desktop" | "game" | "application";

export type ArcadeStreamCodec = "auto" | "h264" | "hevc" | "av1";

export type ArcadeStreamFps = 30 | 60 | 90 | 120;

export type ArcadeStreamHdrMode = "auto" | "off" | "on";

export type ArcadeStreamAudioMode = "stereo" | "5.1" | "7.1";

export type ArcadeBridgeMode = "mock" | "sidecar" | "plugin" | "unavailable";

export type ArcadeSessionStatus =
  | "mock-ready"
  | "pairing"
  | "connecting"
  | "streaming"
  | "poor-connection"
  | "disconnected"
  | "stopped"
  | "failed";

export type ArcadePairingStatus =
  | "not-implemented"
  | "pending"
  | "paired"
  | "failed";

export interface ArcadeResolution {
  height: number;
  width: number;
}

export interface ArcadeStreamSettings {
  audio: ArcadeStreamAudioMode;
  bitrateMbps: number;
  codec: ArcadeStreamCodec;
  fps: ArcadeStreamFps;
  hdr: ArcadeStreamHdrMode;
  height: number;
  width: number;
}

export interface ArcadeHostCapabilities {
  codecs: ArcadeStreamCodec[];
  hdr: boolean;
  maxBitrateMbps: number;
  maxFps: ArcadeStreamFps | number;
  maxResolution: ArcadeResolution | null;
}

export interface ArcadeApp {
  id: string;
  name: string;
  type: ArcadeAppType;
  artworkUrl?: string | null;
  lastPlayedAt?: string | null;
}

export interface ArcadeHost {
  address: string;
  apps: ArcadeApp[];
  capabilities: ArcadeHostCapabilities;
  createdAt: string;
  id: string;
  lastSeenAt: string | null;
  name: string;
  paired: boolean;
  provider: ArcadeHostProvider;
  settings: ArcadeStreamSettings;
  status: ArcadeHostStatus;
  updatedAt: string;
}

export interface ArcadeSessionDiagnostics {
  bitrateMbps: number;
  codec: ArcadeStreamCodec;
  droppedFrames: number;
  latencyMs: number | null;
  packetsLost: number;
}

export interface ArcadeSession {
  appId: string;
  bridgeMode: ArcadeBridgeMode;
  createdAt: string;
  diagnostics: ArcadeSessionDiagnostics;
  hostId: string;
  id: string;
  settings: ArcadeStreamSettings;
  startedAt: string | null;
  status: ArcadeSessionStatus;
  streamUrl: string | null;
  updatedAt: string;
}

export interface ArcadeBridgeCapabilities {
  available: boolean;
  mode: ArcadeBridgeMode;
  moonlightCore: boolean;
  sidecar: boolean;
}

export interface ArcadeCodecCapabilities {
  recommendedFirstPass: ArcadeStreamCodec;
  requested: ArcadeStreamCodec[];
}

export interface ArcadeInputCapabilities {
  controller: "available" | "planned" | "unavailable";
  keyboard: "available" | "planned" | "unavailable";
  mouse: "available" | "planned" | "unavailable";
  touch: "available" | "planned" | "unavailable";
}

export interface ArcadeRendererCapabilities {
  fallback: "canvas" | "none";
  frontendCompositor: "webgpu" | "canvas" | "native";
  webCodecs: "available" | "planned" | "unavailable";
}

export interface ArcadeStreamingCapabilities {
  actualMoonlightSession: boolean;
  recommendedBackend: "native-moonlight-core-sidecar" | "capacitor-plugin" | "webrtc-bridge";
  statusEvents: "available" | "planned" | "unavailable";
}

export interface ArcadeCapabilitiesResponse {
  bridge: ArcadeBridgeCapabilities;
  codecs: ArcadeCodecCapabilities;
  input: ArcadeInputCapabilities;
  renderer: ArcadeRendererCapabilities;
  routes: string[];
  streaming: ArcadeStreamingCapabilities;
}

export interface ArcadeHostsResponse {
  hosts: ArcadeHost[];
  mock: boolean;
}

export interface ArcadeHostResponse {
  host: ArcadeHost;
}

export interface ArcadeAppsResponse {
  apps: ArcadeApp[];
  hostId: string;
  mock?: boolean;
}

export interface ArcadeSessionsResponse {
  mock: boolean;
  sessions: ArcadeSession[];
}

export interface ArcadeSessionResponse {
  session: ArcadeSession;
}

export interface ArcadeDeleteSessionResponse {
  ok: boolean;
}

export interface CreateArcadeHostRequest {
  address: string;
  name: string;
  provider?: ArcadeHostProvider;
  settings?: Partial<ArcadeStreamSettings>;
}

export interface CreateArcadeSessionRequest {
  appId?: string;
  hostId: string;
  settings?: Partial<ArcadeStreamSettings>;
}

export interface ArcadePairingStartRequest {
  pin?: string;
}

export interface ArcadePairingConfirmRequest {
  pin: string;
}

export interface ArcadePairingResponse {
  expiresAt?: string | null;
  host?: ArcadeHost;
  hostId: string;
  message?: string;
  pairingId?: string;
  status: ArcadePairingStatus;
}

export type ArcadeEventType =
  | "bridge"
  | "host"
  | "pairing"
  | "session"
  | "stream"
  | "input";

export interface ArcadeEvent {
  createdAt: string;
  id: string;
  message: string;
  sessionId?: string;
  hostId?: string;
  type: ArcadeEventType;
}

export interface ArcadeEventsResponse {
  events: ArcadeEvent[];
  mock?: boolean;
}
