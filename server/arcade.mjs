import { randomUUID } from "node:crypto";
import { json, readBody } from "./http.mjs";

const nowIso = () => new Date().toISOString();

const defaultStreamSettings = {
  audio: "stereo",
  bitrateMbps: 40,
  codec: "auto",
  fps: 60,
  hdr: "auto",
  height: 1080,
  width: 1920
};

const createMockHost = () => {
  const timestamp = nowIso();

  return {
    address: "192.168.1.42",
    apps: [
      {
        id: "desktop",
        name: "Desktop",
        type: "desktop"
      },
      {
        id: "steam-big-picture",
        name: "Steam Big Picture",
        type: "game"
      }
    ],
    capabilities: {
      codecs: ["h264", "hevc"],
      hdr: false,
      maxBitrateMbps: 100,
      maxFps: 120,
      maxResolution: {
        height: 2160,
        width: 3840
      }
    },
    createdAt: timestamp,
    id: randomUUID(),
    lastSeenAt: timestamp,
    name: "Gaming Desktop",
    paired: true,
    provider: "sunshine",
    settings: { ...defaultStreamSettings },
    status: "paired",
    updatedAt: timestamp
  };
};

const hostState = {
  hosts: [createMockHost()],
  sessions: []
};

const sanitizeProvider = (value) => {
  if (value === "sunshine" || value === "gamestream") {
    return value;
  }

  return "sunshine";
};

const sanitizeStreamSettings = (value = {}) => {
  const settings = value && typeof value === "object" ? value : {};

  return {
    ...defaultStreamSettings,
    audio: ["stereo", "5.1", "7.1"].includes(settings.audio) ? settings.audio : defaultStreamSettings.audio,
    bitrateMbps: Number.isFinite(Number(settings.bitrateMbps))
      ? Math.min(Math.max(Math.round(Number(settings.bitrateMbps)), 5), 150)
      : defaultStreamSettings.bitrateMbps,
    codec: ["auto", "h264", "hevc", "av1"].includes(settings.codec) ? settings.codec : defaultStreamSettings.codec,
    fps: [30, 60, 90, 120].includes(Number(settings.fps)) ? Number(settings.fps) : defaultStreamSettings.fps,
    hdr: ["auto", "off", "on"].includes(settings.hdr) ? settings.hdr : defaultStreamSettings.hdr,
    height: Number.isSafeInteger(Number(settings.height)) ? Math.min(Math.max(Number(settings.height), 480), 4320) : defaultStreamSettings.height,
    width: Number.isSafeInteger(Number(settings.width)) ? Math.min(Math.max(Number(settings.width), 640), 7680) : defaultStreamSettings.width
  };
};

const findHost = (id) => hostState.hosts.find((host) => host.id === id);

const findSession = (id) => hostState.sessions.find((session) => session.id === id);

const createHost = async (request, response) => {
  const body = await readBody(request);
  const name = String(body.name ?? "").trim();
  const address = String(body.address ?? "").trim();

  if (!name || !address) {
    json(response, 400, { error: "Host name and address are required." });
    return;
  }

  const timestamp = nowIso();
  const host = {
    address,
    apps: [],
    capabilities: {
      codecs: [],
      hdr: false,
      maxBitrateMbps: 0,
      maxFps: 0,
      maxResolution: null
    },
    createdAt: timestamp,
    id: randomUUID(),
    lastSeenAt: null,
    name,
    paired: false,
    provider: sanitizeProvider(body.provider),
    settings: sanitizeStreamSettings(body.settings),
    status: "unknown",
    updatedAt: timestamp
  };

  hostState.hosts.push(host);
  json(response, 201, { host });
};

const listHosts = async (request, response) => {
  json(response, 200, {
    hosts: hostState.hosts,
    mock: true
  });
};

const listCapabilities = async (request, response) => {
  json(response, 200, {
    bridge: {
      available: false,
      mode: "mock",
      moonlightCore: false,
      sidecar: false
    },
    codecs: {
      requested: ["h264", "hevc", "av1"],
      recommendedFirstPass: "h264"
    },
    input: {
      controller: "planned",
      keyboard: "planned",
      mouse: "planned",
      touch: "planned"
    },
    renderer: {
      frontendCompositor: "webgpu",
      fallback: "canvas",
      webCodecs: "planned"
    },
    routes: [
      "GET /api/arcade/hosts",
      "POST /api/arcade/hosts",
      "GET /api/arcade/capabilities",
      "GET /api/arcade/sessions",
      "POST /api/arcade/sessions",
      "GET /api/arcade/sessions/:id",
      "DELETE /api/arcade/sessions/:id"
    ],
    streaming: {
      actualMoonlightSession: false,
      recommendedBackend: "native-moonlight-core-sidecar",
      statusEvents: "planned"
    }
  });
};

const listSessions = async (request, response) => {
  json(response, 200, {
    mock: true,
    sessions: hostState.sessions
  });
};

const createSession = async (request, response) => {
  const body = await readBody(request);
  const hostId = String(body.hostId ?? "").trim();
  const host = findHost(hostId);

  if (!host) {
    json(response, 404, { error: "Arcade host not found." });
    return;
  }

  const timestamp = nowIso();
  const session = {
    appId: String(body.appId ?? "desktop").trim() || "desktop",
    bridgeMode: "mock",
    createdAt: timestamp,
    diagnostics: {
      bitrateMbps: 0,
      codec: sanitizeStreamSettings(body.settings ?? host.settings).codec,
      droppedFrames: 0,
      latencyMs: null,
      packetsLost: 0
    },
    hostId: host.id,
    id: randomUUID(),
    settings: sanitizeStreamSettings(body.settings ?? host.settings),
    startedAt: null,
    status: "mock-ready",
    streamUrl: null,
    updatedAt: timestamp
  };

  hostState.sessions.unshift(session);
  json(response, 201, { session });
};

const getSession = async (request, response, id) => {
  const session = findSession(id);

  if (!session) {
    json(response, 404, { error: "Arcade session not found." });
    return;
  }

  json(response, 200, { session });
};

const deleteSession = async (request, response, id) => {
  const index = hostState.sessions.findIndex((session) => session.id === id);

  if (index === -1) {
    json(response, 404, { error: "Arcade session not found." });
    return;
  }

  hostState.sessions.splice(index, 1);
  json(response, 200, { ok: true });
};

export const createArcadeRoutes = () => async (request, response, url) => {
  if (request.method === "GET" && url.pathname === "/api/arcade/hosts") {
    await listHosts(request, response);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/arcade/hosts") {
    await createHost(request, response);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/arcade/capabilities") {
    await listCapabilities(request, response);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/arcade/sessions") {
    await listSessions(request, response);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/arcade/sessions") {
    await createSession(request, response);
    return true;
  }

  const sessionMatch = url.pathname.match(/^\/api\/arcade\/sessions\/([^/]+)$/);

  if (sessionMatch) {
    const [, id] = sessionMatch;

    if (request.method === "GET") {
      await getSession(request, response, id);
      return true;
    }

    if (request.method === "DELETE") {
      await deleteSession(request, response, id);
      return true;
    }
  }

  return false;
};
