import { icons, createElement } from "lucide";
import { dashboardApps, type DashboardApp } from "./apps";
import { collectDiagnostics } from "./diagnostics/collectDiagnostics";
import { createPerformanceMonitor } from "./diagnostics/performanceMonitor";
import type { RendererRuntimeState } from "./diagnostics/types";
import { renderLibraryView } from "./library/renderLibraryView";
import { filterApps, renderSearchResults, renderSearchView } from "./search/renderSearchView";
import { renderSettingsPanel } from "./settings/renderSettingsPanel";
import { startRenderer } from "./webgpuRenderer";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#app");
const canvas = document.querySelector<HTMLCanvasElement>("#gpu-scene");

if (!root || !canvas) {
  throw new Error("Dashboard root or render canvas is missing.");
}

let focusedIndex = 0;
let launchedApp: DashboardApp | null = null;
let activeApp: DashboardApp | null = null;
let activeRail = "home";
let rendererState: RendererRuntimeState = {
  adapterName: "Checking GPU",
  mode: "checking"
};

const performanceMonitor = createPerformanceMonitor();

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
  <section id="app-surface" class="app-surface" aria-live="polite" hidden></section>
`;

const grid = document.querySelector<HTMLDivElement>("#app-grid");
const featuredTitle = document.querySelector<HTMLHeadingElement>("#featured-title");
const featuredDescription = document.querySelector<HTMLParagraphElement>("#featured-description");
const launchButton = document.querySelector<HTMLButtonElement>("#launch-button");
const detailsButton = document.querySelector<HTMLButtonElement>("#details-button");
const detailPanel = document.querySelector<HTMLElement>("#detail-panel");
const appSurface = document.querySelector<HTMLElement>("#app-surface");
const gpuStatus = document.querySelector<HTMLSpanElement>("#gpu-status");
const clock = document.querySelector<HTMLTimeElement>("#clock");

if (!grid || !featuredTitle || !featuredDescription || !launchButton || !detailsButton || !detailPanel || !appSurface || !gpuStatus || !clock) {
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

const closeShellPanel = () => {
  activeRail = "home";
  renderRailState();
  launchedApp = null;
  detailPanel.classList.remove("system-panel", "search-panel", "library-panel");
  renderPanel();
};

const bindClosePanel = () => {
  document.querySelector<HTMLButtonElement>("#close-panel")?.addEventListener("click", closeShellPanel);
};

const closeActiveApp = () => {
  if (!activeApp) {
    return;
  }

  appSurface.classList.remove("open");
  appSurface.classList.add("closing");

  window.setTimeout(() => {
    activeApp = null;
    appSurface.hidden = true;
    appSurface.className = "app-surface";
    appSurface.innerHTML = "";
  }, 240);
};

const bindSettingsTabs = () => {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-diagnostic-tab]"));
  const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-diagnostic-section]"));

  const sectionGroups: Record<string, string[]> = {
    all: [],
    apps: ["apps"],
    display: ["display"],
    performance: ["performance"],
    renderer: ["renderer", "gpu-limits"],
    runtime: ["runtime"]
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const selected = tab.dataset.diagnosticTab ?? "all";
      const visibleSections = sectionGroups[selected] ?? [];

      tabs.forEach((candidate) => {
        candidate.classList.toggle("active", candidate === tab);
      });

      sections.forEach((section) => {
        const sectionName = section.dataset.diagnosticSection ?? "";
        section.hidden = visibleSections.length > 0 && !visibleSections.includes(sectionName);
      });
    });
  });
};

const bindLibraryControls = (container: ParentNode) => {
  container.querySelectorAll<HTMLButtonElement>("[data-library-app]").forEach((button) => {
    button.addEventListener("click", () => {
      const app = dashboardApps.find((candidate) => candidate.id === button.dataset.libraryApp);

      if (app) {
        void launchApp(app);
      }
    });
  });
};

const createSettingsContent = async () =>
  renderSettingsPanel(
    await collectDiagnostics({
      activeRail,
      apps: dashboardApps,
      focusedIndex,
      launchedApp,
      performance: performanceMonitor.snapshot(),
      renderer: rendererState
    })
  );

const launchApp = async (app: DashboardApp) => {
  const isSearchApp = app.id === "search";
  const isSettingsApp = app.id === "settings";

  activeApp = app;
  launchedApp = null;
  activeRail = isSettingsApp ? "settings" : "home";
  renderRailState();
  detailPanel.classList.remove("system-panel", "search-panel", "library-panel");
  renderPanel();

  const body = isSearchApp
    ? renderSearchView(dashboardApps, "app")
    : isSettingsApp
      ? await createSettingsContent()
    : `
      <section class="app-window-body">
        <div>
          <p class="eyebrow">${app.status}</p>
          <h3>${app.name}</h3>
          <p>${app.description}</p>
        </div>
        <div class="app-window-grid">
          <span>App ID <strong>${app.id}</strong></span>
          <span>Status <strong>${app.status}</strong></span>
          <span>Renderer <strong>${gpuStatus.textContent ?? "Unknown"}</strong></span>
          <span>Surface <strong>Full screen</strong></span>
        </div>
      </section>
    `;

  appSurface.hidden = false;
  appSurface.className = `app-surface launching ${isSearchApp ? "search-app-surface" : ""} ${isSettingsApp ? "settings-app-surface" : ""}`;
  appSurface.style.setProperty("--accent", app.accent);
  appSurface.innerHTML = `
    <article class="app-window ${isSearchApp ? "search-window" : ""} ${isSettingsApp ? "settings-window" : ""}">
      ${
        isSettingsApp
          ? body
          : `
            <header class="app-window-header">
              <span class="app-window-mark">${app.name.slice(0, 1)}</span>
              <div>
                <p class="eyebrow">${app.kind}</p>
                <h2>${app.name}</h2>
              </div>
              <button id="close-active-app" class="icon-command" type="button" aria-label="Close app" title="Close">×</button>
            </header>
            ${body}
          `
      }
    </article>
  `;

  document.querySelector<HTMLButtonElement>("#close-active-app")?.addEventListener("click", closeActiveApp);

  if (isSearchApp) {
    bindSearchControls(appSurface);
  }

  if (isSettingsApp) {
    document.querySelector<HTMLButtonElement>("#close-panel")?.addEventListener("click", closeActiveApp);
    bindSettingsTabs();
  }

  requestAnimationFrame(() => {
    appSurface.classList.add("open");
  });
};

const bindSearchControls = (container: ParentNode) => {
  const input = container.querySelector<HTMLInputElement>("[data-search-input]");
  const results = container.querySelector<HTMLElement>("[data-search-results]");
  const summary = container.querySelector<HTMLElement>("[data-search-summary]");

  if (!input || !results || !summary) {
    return;
  }

  let visibleApps = [...dashboardApps];
  let activeIndex = 0;

  const renderResults = () => {
    visibleApps = filterApps(dashboardApps, input.value);
    activeIndex = Math.min(activeIndex, Math.max(visibleApps.length - 1, 0));
    results.innerHTML = renderSearchResults(visibleApps);
    summary.textContent =
      visibleApps.length === 1 ? "1 app found" : `${visibleApps.length} apps found`;
  };

  const updateActiveResult = () => {
    const buttons = Array.from(results.querySelectorAll<HTMLButtonElement>("[data-search-result]"));
    buttons.forEach((button, index) => {
      button.classList.toggle("active", index === activeIndex);
    });
  };

  const openActiveResult = () => {
    const app = visibleApps[activeIndex];

    if (app) {
      void launchApp(app);
    }
  };

  input.addEventListener("input", () => {
    activeIndex = 0;
    renderResults();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      activeIndex = Math.min(activeIndex + 1, Math.max(visibleApps.length - 1, 0));
      updateActiveResult();
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActiveResult();
    }

    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      openActiveResult();
    }
  });

  results.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-search-result]");

    if (!button) {
      return;
    }

    const app = dashboardApps.find((candidate) => candidate.id === button.dataset.searchResult);

    if (app) {
      void launchApp(app);
    }
  });

  renderResults();
  window.setTimeout(() => input.focus(), 0);
};

const renderSettingsDiagnostics = async () => {
  const snapshot = await collectDiagnostics({
    activeRail,
    apps: dashboardApps,
    focusedIndex,
    launchedApp,
    performance: performanceMonitor.snapshot(),
    renderer: rendererState
  });

  if (activeRail !== "settings") {
    return;
  }

  detailPanel.hidden = false;
  detailPanel.classList.add("system-panel");
  detailPanel.classList.remove("search-panel", "library-panel");
  detailPanel.innerHTML = renderSettingsPanel(snapshot);
  bindClosePanel();
  bindSettingsTabs();
};

const openShellPanel = async (nav: string) => {
  closeActiveApp();
  activeRail = nav;
  renderRailState();

  if (nav === "home") {
    closeShellPanel();
    return;
  }

  if (nav === "settings") {
    launchedApp = null;
    detailPanel.hidden = false;
    detailPanel.classList.add("system-panel");
    detailPanel.classList.remove("search-panel", "library-panel");
    detailPanel.innerHTML = `
      <div class="panel-header">
        <span class="panel-mark">S</span>
        <div>
          <p class="eyebrow">System</p>
          <h2>Settings</h2>
        </div>
      </div>
      <p class="panel-intro">Collecting diagnostics...</p>
    `;
    await renderSettingsDiagnostics();
    return;
  }

  if (nav === "search") {
    launchedApp = null;
    detailPanel.hidden = false;
    detailPanel.classList.add("system-panel", "search-panel");
    detailPanel.classList.remove("library-panel");
    detailPanel.innerHTML = `
      <div class="panel-header">
        <span class="panel-mark">S</span>
        <div>
          <p class="eyebrow">System</p>
          <h2>Search</h2>
        </div>
        <button id="close-panel" class="icon-command" type="button" aria-label="Close panel" title="Close">×</button>
      </div>
      ${renderSearchView(dashboardApps, "panel")}
    `;
    bindClosePanel();
    bindSearchControls(detailPanel);
    return;
  }

  if (nav === "library") {
    launchedApp = null;
    detailPanel.hidden = false;
    detailPanel.classList.add("system-panel", "library-panel");
    detailPanel.classList.remove("search-panel");
    detailPanel.innerHTML = `
      <div class="panel-header">
        <span class="panel-mark">L</span>
        <div>
          <p class="eyebrow">Collection</p>
          <h2>Library</h2>
        </div>
        <button id="close-panel" class="icon-command" type="button" aria-label="Close panel" title="Close">×</button>
      </div>
      ${renderLibraryView(dashboardApps)}
    `;
    bindClosePanel();
    bindLibraryControls(detailPanel);
    return;
  }

};

const openFocusedApp = () => {
  activeRail = "home";
  renderRailState();
  detailPanel.classList.remove("system-panel", "search-panel", "library-panel");
  launchedApp = dashboardApps[focusedIndex];
  renderPanel();
};

const launchFocusedApp = () => {
  const app = dashboardApps[focusedIndex];
  void launchApp(app);
};

grid.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".app-tile");

  if (!button) {
    return;
  }

  focusedIndex = Number(button.dataset.index);
  renderFocus();
});

grid.addEventListener("dblclick", launchFocusedApp);
launchButton.addEventListener("click", launchFocusedApp);
detailsButton.addEventListener("click", openFocusedApp);

document.querySelectorAll<HTMLButtonElement>(".rail-button").forEach((button) => {
  button.addEventListener("click", () => {
    void openShellPanel(button.dataset.nav ?? "home");
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
    launchFocusedApp();
  }

  if (event.key === "Escape") {
    if (activeApp) {
      closeActiveApp();
      return;
    }

    closeShellPanel();
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
performanceMonitor.start();
renderRailIcons();
renderFocus();

startRenderer(canvas)
  .then((renderer) => {
    rendererState = {
      adapterName: renderer.adapterName,
      mode: renderer.mode,
      preferredFormat: "gpu" in navigator ? navigator.gpu.getPreferredCanvasFormat() : undefined
    };
    gpuStatus.textContent = renderer.mode === "webgpu" ? `WebGPU · ${renderer.adapterName}` : "Canvas fallback";
    gpuStatus.classList.toggle("fallback", renderer.mode === "fallback");
    if (activeRail === "settings") {
      void renderSettingsDiagnostics();
    }
  })
  .catch((error: unknown) => {
    console.error(error);
    rendererState = {
      adapterName: "Renderer error",
      mode: "error"
    };
    gpuStatus.textContent = "Canvas fallback";
    gpuStatus.classList.add("fallback");
  });
