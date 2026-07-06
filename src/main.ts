import { icons, createElement } from "lucide";
import { dashboardApps, type DashboardApp } from "./apps";
import { startRenderer } from "./webgpuRenderer";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#app");
const canvas = document.querySelector<HTMLCanvasElement>("#gpu-scene");

if (!root || !canvas) {
  throw new Error("Dashboard root or render canvas is missing.");
}

let focusedIndex = 0;
let launchedApp: DashboardApp | null = null;
let activeRail = "home";

root.innerHTML = `
  <main class="shell" aria-label="Nebula dashboard">
    <aside class="rail" aria-label="System navigation">
      <button class="rail-button active" aria-label="Home" title="Home" data-nav="home" data-icon="House"></button>
      <button class="rail-button" aria-label="Search" title="Search" data-nav="search" data-icon="Search"></button>
      <button class="rail-button" aria-label="Library" title="Library" data-nav="library" data-icon="Library"></button>
      <button class="rail-button" aria-label="Settings" title="Settings" data-nav="settings" data-icon="Settings"></button>
    </aside>

    <section class="home" aria-live="polite">
      <header class="topbar">
        <div>
          <p class="eyebrow">Nebula OS</p>
          <h1>Dashboard</h1>
        </div>
        <div class="status-cluster">
          <span id="gpu-status" class="system-pill">Checking GPU</span>
          <span class="system-pill">Controller Ready</span>
          <time id="clock" class="clock"></time>
        </div>
      </header>

      <section class="hero-stage">
        <div class="hero-copy">
          <p class="eyebrow">Now Featured</p>
          <h2 id="featured-title"></h2>
          <p id="featured-description"></p>
          <div class="command-row">
            <button id="launch-button" class="primary-command" type="button">Open</button>
            <button id="details-button" class="icon-command" type="button" aria-label="View details" title="View details">⋯</button>
          </div>
        </div>
      </section>

      <section class="app-strip" aria-label="Applications">
        <div class="section-heading">
          <h2>Applications</h2>
          <span>${dashboardApps.length} installed</span>
        </div>
        <div id="app-grid" class="app-grid"></div>
      </section>

      <section id="detail-panel" class="detail-panel" hidden></section>
    </section>
  </main>
`;

const grid = document.querySelector<HTMLDivElement>("#app-grid");
const featuredTitle = document.querySelector<HTMLHeadingElement>("#featured-title");
const featuredDescription = document.querySelector<HTMLParagraphElement>("#featured-description");
const launchButton = document.querySelector<HTMLButtonElement>("#launch-button");
const detailsButton = document.querySelector<HTMLButtonElement>("#details-button");
const detailPanel = document.querySelector<HTMLElement>("#detail-panel");
const gpuStatus = document.querySelector<HTMLSpanElement>("#gpu-status");
const clock = document.querySelector<HTMLTimeElement>("#clock");

if (!grid || !featuredTitle || !featuredDescription || !launchButton || !detailsButton || !detailPanel || !gpuStatus || !clock) {
  throw new Error("Dashboard controls failed to initialize.");
}

const renderRailIcons = () => {
  document.querySelectorAll<HTMLButtonElement>("[data-icon]").forEach((button) => {
    const iconName = button.dataset.icon as keyof typeof icons;
    const iconNode = icons[iconName];

    if (iconNode) {
      button.replaceChildren(createElement(iconNode));
    }
  });
};

const renderGrid = () => {
  grid.innerHTML = dashboardApps
    .map((app, index) => {
      const isFocused = index === focusedIndex;
      return `
        <button
          class="app-tile ${isFocused ? "focused" : ""}"
          type="button"
          data-index="${index}"
          style="--accent: ${app.accent}"
          aria-pressed="${isFocused}"
        >
          <span class="tile-art">${app.name.slice(0, 1)}</span>
          <span class="tile-meta">
            <strong>${app.name}</strong>
            <small>${app.kind} · ${app.status}</small>
          </span>
        </button>
      `;
    })
    .join("");
};

const renderFocus = () => {
  const app = dashboardApps[focusedIndex];
  document.documentElement.dataset.focusIndex = String(focusedIndex);
  featuredTitle.textContent = app.name;
  featuredDescription.textContent = app.description;
  launchButton.textContent = app.status === "planned" ? "Preview" : "Open";
  renderGrid();
};

const renderPanel = () => {
  if (!launchedApp) {
    detailPanel.hidden = true;
    detailPanel.innerHTML = "";
    return;
  }

  detailPanel.hidden = false;
  detailPanel.innerHTML = `
    <div class="panel-header">
      <span class="panel-mark" style="--accent: ${launchedApp.accent}">${launchedApp.name.slice(0, 1)}</span>
      <div>
        <p class="eyebrow">${launchedApp.kind}</p>
        <h2>${launchedApp.name}</h2>
      </div>
      <button id="close-panel" class="icon-command" type="button" aria-label="Close app" title="Close">×</button>
    </div>
    <p>${launchedApp.description}</p>
    <div class="capability-grid">
      <span>App ID <strong>${launchedApp.id}</strong></span>
      <span>Status <strong>${launchedApp.status}</strong></span>
      <span>Renderer <strong>${gpuStatus.textContent ?? "Unknown"}</strong></span>
    </div>
  `;

  document.querySelector<HTMLButtonElement>("#close-panel")?.addEventListener("click", () => {
    launchedApp = null;
    renderPanel();
  });
};

const renderRailState = () => {
  document.querySelectorAll<HTMLButtonElement>(".rail-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.nav === activeRail);
  });
};

const openShellPanel = (nav: string) => {
  activeRail = nav;
  renderRailState();

  if (nav === "home") {
    launchedApp = null;
    renderPanel();
    return;
  }

  const panelContent: Record<string, { title: string; eyebrow: string; body: string; rows: Array<[string, string]> }> = {
    search: {
      title: "Search",
      eyebrow: "System",
      body: "Unified app, media, and game search will live here.",
      rows: [
        ["Indexed apps", "5"],
        ["Media providers", "0"],
        ["Recent queries", "0"]
      ]
    },
    library: {
      title: "Library",
      eyebrow: "Collection",
      body: "Installed apps and owned content will be organized from this surface.",
      rows: [
        ["Installed", "5"],
        ["Pinned", "0"],
        ["Updates", "0"]
      ]
    },
    settings: {
      title: "Settings",
      eyebrow: "System",
      body: "Shell preferences, renderer diagnostics, and device capabilities belong here.",
      rows: [
        ["Renderer", gpuStatus.textContent ?? "Unknown"],
        ["Input", "Controller Ready"],
        ["Profile", "Local"]
      ]
    }
  };

  const content = panelContent[nav];

  if (!content) {
    return;
  }

  launchedApp = null;
  detailPanel.hidden = false;
  detailPanel.innerHTML = `
    <div class="panel-header">
      <span class="panel-mark">${content.title.slice(0, 1)}</span>
      <div>
        <p class="eyebrow">${content.eyebrow}</p>
        <h2>${content.title}</h2>
      </div>
      <button id="close-panel" class="icon-command" type="button" aria-label="Close panel" title="Close">×</button>
    </div>
    <p>${content.body}</p>
    <div class="capability-grid">
      ${content.rows
        .map(([label, value]) => `<span>${label} <strong>${value}</strong></span>`)
        .join("")}
    </div>
  `;

  document.querySelector<HTMLButtonElement>("#close-panel")?.addEventListener("click", () => {
    activeRail = "home";
    renderRailState();
    launchedApp = null;
    renderPanel();
  });
};

const openFocusedApp = () => {
  activeRail = "home";
  renderRailState();
  launchedApp = dashboardApps[focusedIndex];
  renderPanel();
};

grid.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".app-tile");

  if (!button) {
    return;
  }

  focusedIndex = Number(button.dataset.index);
  renderFocus();
});

grid.addEventListener("dblclick", openFocusedApp);
launchButton.addEventListener("click", openFocusedApp);
detailsButton.addEventListener("click", openFocusedApp);

document.querySelectorAll<HTMLButtonElement>(".rail-button").forEach((button) => {
  button.addEventListener("click", () => {
    openShellPanel(button.dataset.nav ?? "home");
  });
});

window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    focusedIndex = (focusedIndex + 1) % dashboardApps.length;
    renderFocus();
  }

  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    focusedIndex = (focusedIndex - 1 + dashboardApps.length) % dashboardApps.length;
    renderFocus();
  }

  if (event.key === "Enter") {
    openFocusedApp();
  }

  if (event.key === "Escape") {
    activeRail = "home";
    renderRailState();
    launchedApp = null;
    renderPanel();
  }
});

const updateClock = () => {
  clock.dateTime = new Date().toISOString();
  clock.textContent = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date());
};

updateClock();
setInterval(updateClock, 1000);
renderRailIcons();
renderFocus();

startRenderer(canvas)
  .then((renderer) => {
    gpuStatus.textContent = renderer.mode === "webgpu" ? `WebGPU · ${renderer.adapterName}` : "Canvas fallback";
    gpuStatus.classList.toggle("fallback", renderer.mode === "fallback");
  })
  .catch((error: unknown) => {
    console.error(error);
    gpuStatus.textContent = "Canvas fallback";
    gpuStatus.classList.add("fallback");
  });
