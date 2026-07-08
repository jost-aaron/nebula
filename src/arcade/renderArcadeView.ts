import { createElement, icons } from "lucide";
import {
  readArcadeInputDiagnostics,
  renderArcadeInputDiagnosticsPanel,
  type ArcadeInputDiagnosticsSnapshot
} from "./inputDiagnostics";

type ArcadeHostStatus = "add-host" | "pairing" | "paired" | "connecting" | "streaming" | "disconnected";

interface ArcadeHost {
  address: string;
  bitrate: string;
  codec: string;
  detail: string;
  fps: string;
  id: string;
  input: string;
  latency: string;
  name: string;
  resolution: string;
  status: ArcadeHostStatus;
}

interface ArcadeState {
  activeHostId: string;
  hosts: ArcadeHost[];
  inputDiagnostics: ArcadeInputDiagnosticsSnapshot;
}

const statusCopy: Record<ArcadeHostStatus, { label: string; tone: string }> = {
  "add-host": { label: "Add Host", tone: "Setup" },
  connecting: { label: "Connecting", tone: "Handshake" },
  disconnected: { label: "Disconnected", tone: "Offline" },
  paired: { label: "Paired", tone: "Ready" },
  pairing: { label: "Pairing", tone: "Code Pending" },
  streaming: { label: "Streaming", tone: "Live" }
};

const initialHosts: ArcadeHost[] = [
  {
    address: "192.168.4.28",
    bitrate: "45 Mbps",
    codec: "HEVC preferred",
    detail: "Sunshine host / Wake available",
    fps: "60 FPS",
    id: "den-rig",
    input: "Gamepad + keyboard",
    latency: "8 ms LAN",
    name: "Den Gaming Rig",
    resolution: "2560 x 1440",
    status: "paired"
  },
  {
    address: "10.0.0.42",
    bitrate: "30 Mbps",
    codec: "H.264 fallback",
    detail: "Desktop host / PIN entry",
    fps: "60 FPS",
    id: "studio-pc",
    input: "Controller only",
    latency: "Pairing required",
    name: "Studio PC",
    resolution: "1920 x 1080",
    status: "pairing"
  },
  {
    address: "moonlight.lan",
    bitrate: "20 Mbps",
    codec: "Auto",
    detail: "Remote profile / Last seen yesterday",
    fps: "30 FPS",
    id: "travel-box",
    input: "Touch + gamepad",
    latency: "Unavailable",
    name: "Travel Box",
    resolution: "1280 x 720",
    status: "disconnected"
  }
];

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const renderArcadeIcon = (iconName: keyof typeof icons, className = "arcade-ui-icon") => {
  const iconNode = icons[iconName] ?? icons.Circle;
  const node = createElement(iconNode);
  node.setAttribute("class", className);
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("focusable", "false");
  return node.outerHTML;
};

const renderHostCard = (host: ArcadeHost, activeHostId: string) => {
  const status = statusCopy[host.status];

  return `
    <button class="arcade-host-card ${host.id === activeHostId ? "active" : ""}" type="button" data-arcade-host="${escapeHtml(host.id)}">
      <span class="arcade-host-status ${host.status}"></span>
      <span class="arcade-host-icon">${renderArcadeIcon(host.status === "streaming" ? "RadioTower" : "MonitorPlay")}</span>
      <span class="arcade-host-copy">
        <small>${escapeHtml(status.tone)}</small>
        <strong>${escapeHtml(host.name)}</strong>
        <span>${escapeHtml(host.detail)}</span>
      </span>
      <span class="arcade-host-meta">
        <small>${escapeHtml(host.address)}</small>
        <strong>${escapeHtml(status.label)}</strong>
      </span>
    </button>
  `;
};

const renderSessionPreview = (host: ArcadeHost) => {
  const status = statusCopy[host.status];
  const isStreaming = host.status === "streaming";
  const isConnecting = host.status === "connecting" || host.status === "pairing";

  return `
    <section class="arcade-stream-preview" aria-label="Arcade stream preview">
      <div class="arcade-scanlines" aria-hidden="true"></div>
      <div class="arcade-preview-frame ${host.status}">
        <span class="arcade-reticle">${renderArcadeIcon(isStreaming ? "Gamepad2" : "CircleDot")}</span>
        <div>
          <p class="eyebrow">${escapeHtml(status.tone)}</p>
          <h2>${escapeHtml(host.name)}</h2>
          <p>${isStreaming ? "Mock stream surface active. WebGPU compositor hooks land here later." : "Choose a host action to walk through the future Moonlight session states."}</p>
        </div>
        <div class="arcade-preview-status">
          <span>${renderArcadeIcon(isConnecting ? "LoaderCircle" : "Activity")} ${escapeHtml(status.label)}</span>
          <span>${escapeHtml(host.latency)}</span>
        </div>
      </div>
    </section>
  `;
};

const renderSettingsPanel = (host: ArcadeHost, inputDiagnostics: ArcadeInputDiagnosticsSnapshot) => `
  <aside class="arcade-settings-panel" aria-label="Stream settings">
    <header>
      <p class="eyebrow">Stream Settings</p>
      <h3>Moonlight Profile</h3>
    </header>
    <div class="arcade-setting-grid">
      <span>
        <small>Resolution</small>
        <strong>${escapeHtml(host.resolution)}</strong>
      </span>
      <span>
        <small>Frame Rate</small>
        <strong>${escapeHtml(host.fps)}</strong>
      </span>
      <span>
        <small>Bitrate</small>
        <strong>${escapeHtml(host.bitrate)}</strong>
      </span>
      <span>
        <small>Codec</small>
        <strong>${escapeHtml(host.codec)}</strong>
      </span>
      <span>
        <small>Input</small>
        <strong>${escapeHtml(host.input)}</strong>
      </span>
      <span>
        <small>Transport</small>
        <strong>Native bridge later</strong>
      </span>
    </div>
    ${renderArcadeInputDiagnosticsPanel(inputDiagnostics)}
  </aside>
`;

const renderTimeline = (activeStatus: ArcadeHostStatus) => {
  const steps: Array<{ id: ArcadeHostStatus; label: string }> = [
    { id: "add-host", label: "Add host" },
    { id: "pairing", label: "Pair" },
    { id: "connecting", label: "Connect" },
    { id: "streaming", label: "Stream" },
    { id: "disconnected", label: "Disconnect" }
  ];

  return `
    <section class="arcade-session-timeline" aria-label="Mock session states">
      ${steps
        .map(
          (step) => `
            <button class="${step.id === activeStatus ? "active" : ""}" type="button" data-arcade-action="${step.id}">
              <span>${statusCopy[step.id].tone}</span>
              <strong>${step.label}</strong>
            </button>
          `
        )
        .join("")}
    </section>
  `;
};

const renderActions = (host: ArcadeHost) => `
  <div class="arcade-actions" aria-label="Arcade actions">
    <button type="button" data-arcade-action="add-host">${renderArcadeIcon("Plus")} Add Host</button>
    <button type="button" data-arcade-action="pairing">${renderArcadeIcon("KeyRound")} Pair</button>
    <button type="button" data-arcade-action="connecting">${renderArcadeIcon("Cable")} Connect</button>
    <button type="button" data-arcade-action="streaming">${renderArcadeIcon("Play")} Stream</button>
    <button type="button" data-arcade-action="disconnected">${renderArcadeIcon("Power")} Disconnect</button>
    <span>${escapeHtml(statusCopy[host.status].label)} / ${escapeHtml(host.address)}</span>
  </div>
`;

const renderArcadeBody = (state: ArcadeState) => {
  const activeHost = state.hosts.find((host) => host.id === state.activeHostId) ?? state.hosts[0];

  return `
    <main class="arcade-layout">
      <section class="arcade-hosts" aria-label="Moonlight hosts">
        <header>
          <p class="eyebrow">Arcade Hosts</p>
          <h2>Moonlight Clients</h2>
        </header>
        <div class="arcade-host-list">
          ${state.hosts.map((host) => renderHostCard(host, activeHost.id)).join("")}
        </div>
      </section>
      <section class="arcade-session">
        ${renderSessionPreview(activeHost)}
        ${renderTimeline(activeHost.status)}
        ${renderActions(activeHost)}
      </section>
      ${renderSettingsPanel(activeHost, state.inputDiagnostics)}
    </main>
  `;
};

export const renderArcadeView = () => `
  <section class="arcade-shell" data-arcade-root>
    <header class="arcade-topbar">
      <button class="arcade-brand" type="button" data-arcade-action="paired" aria-label="Arcade home">
        <span class="arcade-brand-mark">${renderArcadeIcon("Gamepad2")}</span>
        <span>
          <small>Nebula Arcade</small>
          <strong>Moonlight Shell</strong>
        </span>
      </button>
      <div class="arcade-dashboard-actions">
        <button class="arcade-dashboard-command" type="button" data-arcade-close>
          ${renderArcadeIcon("ArrowLeft")} Dashboard
        </button>
        <button class="arcade-icon-command" type="button" data-arcade-close aria-label="Close Arcade" title="Close">
          ${renderArcadeIcon("X")}
        </button>
      </div>
    </header>
    <div data-arcade-content></div>
  </section>
`;

export const bindArcadeView = (container: ParentNode, onClose: () => void) => {
  const root = container.querySelector<HTMLElement>("[data-arcade-root]");
  const content = container.querySelector<HTMLElement>("[data-arcade-content]");

  if (!root || !content) {
    return;
  }

  const state: ArcadeState = {
    activeHostId: initialHosts[0].id,
    hosts: initialHosts.map((host) => ({ ...host })),
    inputDiagnostics: readArcadeInputDiagnostics()
  };

  const render = () => {
    state.inputDiagnostics = readArcadeInputDiagnostics();
    content.innerHTML = renderArcadeBody(state);
  };

  const updateActiveHostStatus = (status: ArcadeHostStatus) => {
    const activeHost = state.hosts.find((host) => host.id === state.activeHostId);

    if (!activeHost) {
      return;
    }

    activeHost.status = status;

    if (status === "add-host") {
      const newHostNumber = state.hosts.filter((host) => host.id.startsWith("new-host")).length + 1;
      const id = `new-host-${newHostNumber}`;
      state.hosts = [
        ...state.hosts,
        {
          address: `192.168.4.${80 + newHostNumber}`,
          bitrate: "25 Mbps",
          codec: "Auto",
          detail: "New Sunshine host / Awaiting pair",
          fps: "60 FPS",
          id,
          input: "Gamepad + touch",
          latency: "Not tested",
          name: `New Host ${newHostNumber}`,
          resolution: "1920 x 1080",
          status: "pairing"
        }
      ];
      state.activeHostId = id;
    }

    render();
  };

  root.addEventListener("click", (event) => {
    const closeButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-arcade-close]");

    if (closeButton) {
      onClose();
      return;
    }

    const hostButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-arcade-host]");

    if (hostButton?.dataset.arcadeHost) {
      state.activeHostId = hostButton.dataset.arcadeHost;
      render();
      return;
    }

    const actionButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-arcade-action]");
    const action = actionButton?.dataset.arcadeAction as ArcadeHostStatus | undefined;

    if (action && action in statusCopy) {
      updateActiveHostStatus(action);
    }
  });

  root.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Enter") {
      return;
    }

    event.stopPropagation();
  });

  render();
};
