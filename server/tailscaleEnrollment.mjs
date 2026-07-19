import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { json, readBody } from "./http.mjs";

const LOGIN_URL_PATTERN = /^https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+$/;
const FQDN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/i;
const NETWORK_STATUS_MAX_BYTES = 262144;
const ZERO_TIME = "0001-01-01T00:00:00Z";

const safeRegularFile = async (filePath, maximumSize = 1024) => {
  try {
    const metadata = await lstat(filePath);
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= maximumSize;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EACCES") return false;
    throw error;
  }
};

const readStrictFile = async (filePath, pattern) => {
  if (!(await safeRegularFile(filePath))) return null;
  const value = (await readFile(filePath, "utf8")).trim();
  return pattern.test(value) ? value : null;
};

const readStrictFileSync = (filePath, pattern, maximumSize = 1024) => {
  try {
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumSize) return null;
    const value = readFileSync(filePath, "utf8").trim();
    return pattern.test(value) ? value : null;
  } catch {
    return null;
  }
};

const removeControlFile = async (filePath) => {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw Object.assign(new Error("Tailscale control marker is not a regular file."), { status: 409, expose: true });
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

const boundedText = (value, fallback, maximum = 80) => {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, maximum) : fallback;
};

const boundedBytes = (value) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;

const safeTimestamp = (value) => {
  if (typeof value !== "string" || value === ZERO_TIME) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const latestTimestamp = (...values) => values.map(safeTimestamp).filter(Boolean).sort().at(-1) ?? null;

const classifyPeer = (peer) => {
  if (!peer || typeof peer !== "object" || Array.isArray(peer)) return null;
  const online = peer.Online === true;
  const active = peer.Active === true;
  const peerRelay = boundedText(peer.PeerRelay, "", 64);
  const currentAddress = boundedText(peer.CurAddr, "", 128);
  const relayRegion = boundedText(peer.Relay, "", 24).toLowerCase().replace(/[^a-z0-9-]/g, "");
  const path = !online ? "idle"
    : peerRelay ? "peer-relay"
      : currentAddress ? "direct"
        : active && relayRegion ? "derp"
          : active ? "unknown" : "idle";
  return {
    active,
    device: boundedText(peer.HostName, "Unnamed device"),
    lastActivityAt: latestTimestamp(peer.LastWrite, peer.LastHandshake, peer.LastSeen),
    online,
    os: boundedText(peer.OS, "Unknown", 32),
    path,
    ...(path === "derp" ? { relayRegion } : {}),
    rxBytes: boundedBytes(peer.RxBytes),
    txBytes: boundedBytes(peer.TxBytes)
  };
};

const readNetworkPath = async (filePath) => {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > NETWORK_STATUS_MAX_BYTES) return null;
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const peerMap = parsed.Peer && typeof parsed.Peer === "object" && !Array.isArray(parsed.Peer) ? parsed.Peer : {};
    const peers = Object.values(peerMap).slice(0, 64).map(classifyPeer).filter(Boolean)
      .sort((left, right) => Number(right.active) - Number(left.active) || left.device.localeCompare(right.device));
    const summary = { direct: 0, peerRelay: 0, derp: 0, idle: 0, unknown: 0 };
    for (const peer of peers) {
      if (peer.path === "peer-relay") summary.peerRelay += 1;
      else summary[peer.path] += 1;
    }
    return { peers, summary, updatedAt: metadata.mtime.toISOString() };
  } catch {
    return null;
  }
};

export const createTailscaleEnrollmentService = ({
  available = process.env.NEBULA_TAILSCALE_UI_ENABLED === "true",
  controlDirectory = process.env.NEBULA_TAILSCALE_CONTROL_PATH ?? "/run/nebula-tailscale",
  configuredFqdn = process.env.NEBULA_TAILSCALE_FQDN ?? ""
} = {}) => {
  const enabledPath = path.join(controlDirectory, "enabled");
  const loginUrlPath = path.join(controlDirectory, "login-url");
  const connectedPath = path.join(controlDirectory, "connected");
  const fqdnPath = path.join(controlDirectory, "server-fqdn");
  const serveReadyPath = path.join(controlDirectory, "serve-ready");
  const serveErrorPath = path.join(controlDirectory, "serve-error");
  const networkStatusPath = path.join(controlDirectory, "network-status.json");

  const isEnabled = async () => available && (await readStrictFile(enabledPath, /^enabled$/)) === "enabled";
  const connected = async () => available && (await readStrictFile(connectedPath, /^connected$/)) === "connected";
  const serveReadySync = () => {
    if (!available) return false;
    try {
      const metadata = lstatSync(serveReadyPath);
      return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 32
        && readFileSync(serveReadyPath, "utf8").trim() === "ready";
    } catch {
      return false;
    }
  };

  return {
    currentFqdn() {
      const publishedFqdn = readStrictFileSync(fqdnPath, FQDN_PATTERN);
      return publishedFqdn?.toLowerCase() ?? (FQDN_PATTERN.test(configuredFqdn) ? configuredFqdn.toLowerCase() : null);
    },
    isExternalHttpsActive: serveReadySync,
    async status() {
      if (!available) return { available: false, enabled: false, state: "unavailable" };
      const enabled = await isEnabled();
      if (!enabled) return { available: true, enabled: false, loginUrl: null, serverUrl: null, state: "disabled" };

      const isConnected = await connected();
      const serveReady = (await readStrictFile(serveReadyPath, /^ready$/)) === "ready";
      const serveError = await readStrictFile(serveErrorPath, /^https-required$/);
      const loginUrl = isConnected ? null : await readStrictFile(loginUrlPath, LOGIN_URL_PATTERN);
      const fqdn = this.currentFqdn();
      const networkPath = isConnected ? await readNetworkPath(networkStatusPath) : null;
      return {
        available: true,
        enabled: true,
        loginUrl,
        serverUrl: serveReady && fqdn ? `https://${fqdn}` : null,
        ...(networkPath ? { networkPath } : {}),
        state: serveReady ? "connected"
          : isConnected && serveError ? "https-required"
            : loginUrl ? "awaiting-login" : "starting"
      };
    },
    async setEnabled(nextEnabled) {
      if (!available) throw Object.assign(new Error("Tailscale control is unavailable in this deployment."), { status: 409, expose: true });
      if (nextEnabled) {
        try {
          await writeFile(enabledPath, "enabled\n", { flag: "wx", mode: 0o640 });
        } catch (error) {
          if (error?.code !== "EEXIST") throw Object.assign(new Error("The Tailscale companion is not ready yet."), { status: 503, expose: true });
          if (!(await isEnabled())) throw Object.assign(new Error("Tailscale control marker is invalid."), { status: 409, expose: true });
        }
      } else {
        await removeControlFile(enabledPath);
      }
      return this.status();
    }
  };
};

export const createTailscaleEnrollmentRoutes = (service) => async (request, response, url) => {
  if (url.pathname !== "/api/admin/tailscale") return false;
  if (request.method === "GET") {
    json(response, 200, await service.status());
    return true;
  }
  if (request.method === "PUT") {
    const body = await readBody(request, { limit: 1024 });
    if (typeof body.enabled !== "boolean") throw Object.assign(new Error("enabled must be a boolean."), { status: 400, expose: true });
    json(response, 200, await service.setEnabled(body.enabled));
    return true;
  }
  return false;
};
