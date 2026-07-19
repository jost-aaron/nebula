import { apiJson } from "./http";

export type TailscalePeerPath = {
  active: boolean;
  device: string;
  lastActivityAt: string | null;
  online: boolean;
  os: string;
  path: "direct" | "peer-relay" | "derp" | "idle" | "unknown";
  relayRegion?: string;
  rxBytes: number;
  txBytes: number;
};

export type TailscaleNetworkPath = {
  peers: TailscalePeerPath[];
  summary: { direct: number; peerRelay: number; derp: number; idle: number; unknown: number };
  updatedAt: string;
};

export type TailscaleEnrollmentStatus = {
  available: boolean;
  enabled: boolean;
  state: "unavailable" | "disabled" | "starting" | "awaiting-login" | "https-required" | "connected";
  loginUrl?: string | null;
  networkPath?: TailscaleNetworkPath;
  serverUrl?: string | null;
};

export const getTailscaleEnrollmentStatus = () =>
  apiJson<TailscaleEnrollmentStatus>("/api/admin/tailscale");

export const setTailscaleEnabled = (enabled: boolean) =>
  apiJson<TailscaleEnrollmentStatus>("/api/admin/tailscale", {
    method: "PUT",
    body: JSON.stringify({ enabled })
  });
