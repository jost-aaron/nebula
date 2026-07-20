import type { CatalogId, IsoDateTime, MediaItemKind, MediaSourceKind } from "./catalogTypes";
import type { PlaybackClientCapabilities, PlaybackDecision } from "./playbackPlanTypes";
import type { PlaybackDeliveryCreateResponse, PlaybackDeliverySession } from "./playbackDeliveryTypes";
import type { RenditionProfileId } from "./renditionTypes";

export const CLUSTER_PROTOCOL_VERSION = 1 as const;
export type ClusterProtocolVersion = typeof CLUSTER_PROTOCOL_VERSION;
export type ClusterNodeRole = "coordinator" | "shard" | "hybrid";
export type ClusterNodeState = "online" | "stale" | "offline" | "draining" | "revoked";
export type ClusterFingerprintAlgorithm = "sha256" | "blake3";
export type ClusterFingerprintState = "pending" | "ready" | "failed";

export interface ClusterNodeControls {
  maintenanceDrain: boolean;
  maxConcurrentStreams: number | null;
  maxConcurrentTranscodes: number | null;
  priority: number;
  updatedAt: IsoDateTime | null;
}

export interface ClusterAdminNode {
  advertisedName: string;
  capabilities: ClusterNodeCapabilities;
  controls: ClusterNodeControls;
  endpoint: string;
  lastSeenAt: IsoDateTime | null;
  load: { activeStreams: number; activeTranscodes: number };
  local: boolean;
  name: string;
  nodeId: string;
  pairedAt: IsoDateTime;
  revokedAt: IsoDateTime | null;
  role: ClusterNodeRole;
  state: ClusterNodeState;
}

export interface ClusterAdminSnapshot {
  identity: { clusterId: string; descriptor: ClusterNodeDescriptor; keyVersion: number };
  nodes: ClusterAdminNode[];
}

export interface ClusterNodeCapabilities {
  directPlay: boolean;
  hls: boolean;
  remux: boolean;
  renditionProfiles: RenditionProfileId[];
  transcode: boolean;
}

export interface ClusterNodeDescriptor {
  capabilities: ClusterNodeCapabilities;
  endpoint: string;
  name: string;
  nodeId: string;
  protocolVersion: ClusterProtocolVersion;
  publicKey: string;
  role: ClusterNodeRole;
}

export interface ClusterPairingRequest {
  clusterId: string;
  pairingCode: string;
  requester: ClusterNodeDescriptor;
}

export interface ClusterPairingResponse {
  clusterId: string;
  node: ClusterNodeDescriptor;
}

export interface ClusterExternalIdentity {
  mediaType: string;
  provider: string;
  providerItemId: string;
}

export interface ClusterSourceFingerprint {
  algorithm: ClusterFingerprintAlgorithm;
  digest: string | null;
  sourceRevision: number;
  state: ClusterFingerprintState;
}

export interface ClusterManifestSubtitle {
  default: boolean;
  forced: boolean;
  format: "webvtt" | "srt";
  id: string;
  kind: "sidecar";
  label: string;
  language: string | null;
}

export interface ClusterManifestRendition {
  profileId: RenditionProfileId;
  revision: number;
  state: "pending" | "ready" | "failed";
}

export interface ClusterManifestSource {
  availability: "available" | "tombstone";
  bitrate: number | null;
  durationSeconds: number | null;
  externalIds: ClusterExternalIdentity[];
  fingerprint: ClusterSourceFingerprint;
  height: number | null;
  itemKind: MediaItemKind;
  localItemId: CatalogId;
  localSourceId: CatalogId;
  mediaKind: MediaSourceKind;
  removedAt: IsoDateTime | null;
  renditions: ClusterManifestRendition[];
  sizeBytes: number;
  sourceRevision: number;
  subtitles: ClusterManifestSubtitle[];
  title: string;
  width: number | null;
  year: number | null;
}

export interface ClusterManifestPage {
  complete: boolean;
  cursor: string | null;
  manifestRevision: number;
  nodeId: string;
  protocolVersion: ClusterProtocolVersion;
  sources: ClusterManifestSource[];
}

export interface ClusterSignedRequestEnvelope {
  bodyDigest: string;
  method: "GET" | "HEAD" | "POST" | "PATCH" | "DELETE";
  nodeId: string;
  nonce: string;
  path: string;
  protocolVersion: ClusterProtocolVersion;
  signature: string;
  timestamp: string;
}

export interface ClusterDelegatedMediaGrant {
  accountId: string;
  assetPrefix: string;
  clientOrigin: string;
  clusterId: string;
  deviceId: string;
  deliveryId: string | null;
  deliveryProtocol: "file" | "hls";
  expiresAt: string;
  federatedItemId: string;
  grantId: string;
  issuedAt: string;
  localSourceId: CatalogId;
  methods: Array<"GET" | "HEAD">;
  nodeId: string;
  nonce: string;
  profileId: RenditionProfileId | "auto" | "original";
  protocolVersion: ClusterProtocolVersion;
  sessionId: string;
  sourceRevision: number;
  subtitleId: string | null;
}

export interface ClusterPlaybackCandidate {
  decision: PlaybackDecision;
  local?: boolean;
  mode?: "live-transcode" | "original" | "prebuilt-rendition" | "remux";
  nodeName?: string;
  nodeId: string;
  reasons?: Array<{ code: string; score: number }>;
  score: number;
  sourceId: CatalogId;
}

export interface ClusterPlaybackRequest {
  capabilities: PlaybackClientCapabilities;
  federatedItemId: string;
  preferredProfileId?: RenditionProfileId | "auto" | "original";
  startPositionSeconds?: number | null;
  subtitleId?: string | null;
}

export interface ClusterPlaybackSession extends PlaybackDeliverySession {
  candidate: ClusterPlaybackCandidate;
  federatedItemId: string;
  grantExpiresAt?: string;
}

export interface ClusterPlaybackCreateResponse extends Omit<PlaybackDeliveryCreateResponse, "session"> {
  session: ClusterPlaybackSession;
}
