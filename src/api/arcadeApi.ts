import { apiJson } from "./http";
import type {
  ArcadeAppsResponse,
  ArcadeCapabilitiesResponse,
  ArcadeDeleteSessionResponse,
  ArcadeEventsResponse,
  ArcadeHostResponse,
  ArcadeHostsResponse,
  ArcadePairingConfirmRequest,
  ArcadePairingResponse,
  ArcadePairingStartRequest,
  ArcadeSessionResponse,
  ArcadeSessionsResponse,
  CreateArcadeHostRequest,
  CreateArcadeSessionRequest
} from "../shared/arcadeTypes";

const arcadeHostPath = (hostId: string) => `/api/arcade/hosts/${encodeURIComponent(hostId)}`;
const arcadeSessionPath = (sessionId: string) => `/api/arcade/sessions/${encodeURIComponent(sessionId)}`;

export const listArcadeHosts = () => apiJson<ArcadeHostsResponse>("/api/arcade/hosts");

export const createArcadeHost = (body: CreateArcadeHostRequest) =>
  apiJson<ArcadeHostResponse>("/api/arcade/hosts", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

export const getArcadeCapabilities = () => apiJson<ArcadeCapabilitiesResponse>("/api/arcade/capabilities");

export const listArcadeHostApps = (hostId: string) =>
  apiJson<ArcadeAppsResponse>(`${arcadeHostPath(hostId)}/apps`);

export const startArcadeHostPairing = (hostId: string, body: ArcadePairingStartRequest = {}) =>
  apiJson<ArcadePairingResponse>(`${arcadeHostPath(hostId)}/pair/start`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

export const confirmArcadeHostPairing = (hostId: string, body: ArcadePairingConfirmRequest) =>
  apiJson<ArcadePairingResponse>(`${arcadeHostPath(hostId)}/pair/confirm`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

export const listArcadeSessions = () => apiJson<ArcadeSessionsResponse>("/api/arcade/sessions");

export const createArcadeSession = (body: CreateArcadeSessionRequest) =>
  apiJson<ArcadeSessionResponse>("/api/arcade/sessions", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

export const getArcadeSession = (sessionId: string) =>
  apiJson<ArcadeSessionResponse>(arcadeSessionPath(sessionId));

export const deleteArcadeSession = (sessionId: string) =>
  apiJson<ArcadeDeleteSessionResponse>(arcadeSessionPath(sessionId), {
    method: "DELETE"
  });

export const listArcadeEvents = () => apiJson<ArcadeEventsResponse>("/api/arcade/events");
