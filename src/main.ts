import { renderAppIcon } from "./appIcons";
import { apiJson, getApiConnectionMode, getEffectiveApiBaseUrl, getApiToken, setApiBaseUrl, setApiToken } from "./api/http";
import { dashboardApps, type DashboardApp } from "./apps";
import { bindCinemaView, renderCinemaView } from "./cinema/renderCinemaView";
import { collectDiagnostics } from "./diagnostics/collectDiagnostics";
import { createPerformanceMonitor } from "./diagnostics/performanceMonitor";
import type { RendererRuntimeState } from "./diagnostics/types";
import { bindFileBrowser, renderFileBrowserShell } from "./files/fileBrowser";
import { filterApps, renderSearchResults, renderSearchView } from "./search/renderSearchView";
import { renderSettingsPanel } from "./settings/renderSettingsPanel";
import { bindStudioView, renderStudioView } from "./studio/renderStudioView";
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
let rendererState: RendererRuntimeState = {
  adapterName: "Checking GPU",
  mode: "checking"
};

const performanceMonitor = createPerformanceMonitor();

root.innerHTML = `
  <main class="shell" aria-label="Nebula dashboard">
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
          <span class="tile-art">${renderAppIcon(app, "tile-icon")}</span>
          <span class="tile-meta">
            <strong>${app.name}</strong>
            <small>${app.kind} · ${app.status}</small>
          </span>
        </button>
      `;
    })
    .join("");
};

const renderGridFocus = () => {
  grid.querySelectorAll<HTMLButtonElement>(".app-tile").forEach((button) => {
    const isFocused = Number(button.dataset.index) === focusedIndex;
    button.classList.toggle("focused", isFocused);
    button.setAttribute("aria-pressed", String(isFocused));
  });
};

const scrollFocusedTileIntoView = () => {
  grid
    .querySelector<HTMLButtonElement>(`.app-tile[data-index="${focusedIndex}"]`)
    ?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
};

const renderFocus = ({ scroll = true }: { scroll?: boolean } = {}) => {
  const app = dashboardApps[focusedIndex];
  document.documentElement.dataset.focusIndex = String(focusedIndex);
  featuredTitle.textContent = app.name;
  featuredDescription.textContent = app.description;
  launchButton.textContent = app.status === "planned" ? "Preview" : "Open";
  renderGridFocus();

  if (scroll) {
    scrollFocusedTileIntoView();
  }
};

const selectAppIndex = (index: number, options?: { scroll?: boolean }) => {
  const nextIndex = Math.max(0, Math.min(index, dashboardApps.length - 1));

  if (nextIndex === focusedIndex) {
    return false;
  }

  focusedIndex = nextIndex;
  renderFocus(options);
  return true;
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
      <span class="panel-mark" style="--accent: ${launchedApp.accent}">${renderAppIcon(launchedApp, "panel-icon")}</span>
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

const closeShellPanel = () => {
  launchedApp = null;
  detailPanel.classList.remove("system-panel", "search-panel", "library-panel");
  renderPanel();
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
    client: ["client"],
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

const bindClientSettings = (container: ParentNode) => {
  const input = container.querySelector<HTMLInputElement>("[data-api-base-input]");
  const tokenInput = container.querySelector<HTMLInputElement>("[data-api-token-input]");
  const save = container.querySelector<HTMLButtonElement>("[data-api-base-save]");
  const clear = container.querySelector<HTMLButtonElement>("[data-api-base-clear]");
  const test = container.querySelector<HTMLButtonElement>("[data-server-test]");
  const status = container.querySelector<HTMLElement>("[data-api-base-status]");

  if (!input || !tokenInput || !save || !clear || !test || !status) {
    return;
  }

  save.addEventListener("click", () => {
    setApiBaseUrl(input.value);
    setApiToken(tokenInput.value);
    status.textContent = `Saved · ${getApiConnectionMode()}`;
  });

  clear.addEventListener("click", () => {
    input.value = "";
    tokenInput.value = "";
    setApiBaseUrl("");
    setApiToken("");
    status.textContent = `Using ${getApiConnectionMode().toLowerCase()}`;
  });

  test.addEventListener("click", async () => {
    if (!getEffectiveApiBaseUrl()) {
      status.textContent = "Add a server URL first";
      return;
    }

    status.textContent = "Testing server...";

    try {
      const info = await apiJson<{ name: string; serverTime: string }>("/api/server/info");
      status.textContent = `${info.name} online · ${new Date(info.serverTime).toLocaleTimeString()}`;
    } catch {
      status.textContent = getApiToken() ? "Server test failed" : "Server test failed · token may be required";
    }
  });
};

const createSettingsContent = async () =>
  renderSettingsPanel(
    await collectDiagnostics({
      activeNavigation: "Applications",
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
  const isFilesApp = app.id === "files";
  const isCinemaApp = app.id === "cinema";
  const isStudioApp = app.id === "studio";

  activeApp = app;
  launchedApp = null;
  detailPanel.classList.remove("system-panel", "search-panel", "library-panel");
  renderPanel();

  const body = isSearchApp
    ? renderSearchView(dashboardApps, "app")
    : isSettingsApp
      ? await createSettingsContent()
      : isFilesApp
        ? renderFileBrowserShell()
        : isCinemaApp
          ? renderCinemaView()
          : isStudioApp
            ? renderStudioView()
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
  appSurface.className = `app-surface launching ${isSearchApp ? "search-app-surface" : ""} ${isSettingsApp ? "settings-app-surface" : ""} ${isFilesApp ? "files-app-surface" : ""} ${isCinemaApp ? "cinema-app-surface" : ""} ${isStudioApp ? "studio-app-surface" : ""}`;
  appSurface.style.setProperty("--accent", app.accent);
  appSurface.innerHTML = isCinemaApp || isStudioApp
    ? body
    : `
      <article class="app-window ${isSearchApp ? "search-window" : ""} ${isSettingsApp ? "settings-window" : ""} ${isFilesApp ? "files-window" : ""}">
        ${
          isSettingsApp || isFilesApp
            ? body
            : `
            <header class="app-window-header">
              <span class="app-window-mark">${renderAppIcon(app, "window-icon")}</span>
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
    bindClientSettings(appSurface);
  }

  if (isFilesApp) {
    bindFileBrowser(appSurface, {
      onOpenSettings: () => {
        const settingsApp = dashboardApps.find((candidate) => candidate.id === "settings");

        if (settingsApp) {
          void launchApp(settingsApp);
        }
      }
    });
    document.querySelector<HTMLButtonElement>("[data-file-close]")?.addEventListener("click", closeActiveApp);
  }

  if (isCinemaApp) {
    bindCinemaView(appSurface, closeActiveApp);
  }

  if (isStudioApp) {
    bindStudioView(appSurface, closeActiveApp);
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

const openFocusedApp = () => {
  detailPanel.classList.remove("system-panel", "search-panel", "library-panel");
  launchedApp = dashboardApps[focusedIndex];
  renderPanel();
};

const launchFocusedApp = () => {
  const app = dashboardApps[focusedIndex];
  void launchApp(app);
};

let isDraggingGrid = false;
let gridDragStartX = 0;
let gridDragStartScrollLeft = 0;
let didDragGrid = false;
let wheelSelectionAccumulator = 0;
let wheelSelectionDirection = 0;
let lastWheelSelectionAt = 0;
let wheelSelectionReset = 0;
let wheelSelectionLocked = false;
let wheelSelectionLockedUntil = 0;
let pointerSelectionSuppressedUntil = 0;

const wheelSelectionThreshold = 140;
const wheelSelectionCooldownMs = 720;
const pointerSelectionSuppressMs = 1500;

const resetWheelSelectionGate = () => {
  wheelSelectionAccumulator = 0;
  wheelSelectionDirection = 0;
  wheelSelectionLocked = false;
  window.clearTimeout(wheelSelectionReset);
};

grid.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || grid.scrollWidth <= grid.clientWidth) {
    return;
  }

  isDraggingGrid = true;
  didDragGrid = false;
  gridDragStartX = event.clientX;
  gridDragStartScrollLeft = grid.scrollLeft;
  grid.classList.add("dragging");
  grid.setPointerCapture(event.pointerId);
});

grid.addEventListener("pointermove", (event) => {
  if (!isDraggingGrid) {
    return;
  }

  const deltaX = event.clientX - gridDragStartX;

  if (Math.abs(deltaX) > 4) {
    didDragGrid = true;
  }

  grid.scrollLeft = gridDragStartScrollLeft - deltaX;
});

const stopGridDrag = (event: PointerEvent) => {
  if (!isDraggingGrid) {
    return;
  }

  isDraggingGrid = false;
  grid.classList.remove("dragging");

  if (grid.hasPointerCapture(event.pointerId)) {
    grid.releasePointerCapture(event.pointerId);
  }
};

grid.addEventListener("pointerup", stopGridDrag);
grid.addEventListener("pointercancel", stopGridDrag);
grid.addEventListener("lostpointercapture", () => {
  isDraggingGrid = false;
  grid.classList.remove("dragging");
});

const selectGridTileFromPointer = (event: PointerEvent) => {
  if (isDraggingGrid || didDragGrid || window.performance.now() < pointerSelectionSuppressedUntil) {
    return;
  }

  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".app-tile");

  if (!button || !grid.contains(button)) {
    return;
  }

  selectAppIndex(Number(button.dataset.index), { scroll: false });
};

grid.addEventListener("pointerover", selectGridTileFromPointer);
grid.addEventListener("pointermove", selectGridTileFromPointer);

grid.addEventListener("click", (event) => {
  if (didDragGrid) {
    didDragGrid = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".app-tile");

  if (!button) {
    return;
  }

  selectAppIndex(Number(button.dataset.index), { scroll: false });
});

grid.addEventListener(
  "wheel",
  (event) => {
    const dominantDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const direction = Math.sign(dominantDelta);

    if (direction === 0) {
      return;
    }

    event.preventDefault();
    window.clearTimeout(wheelSelectionReset);
    wheelSelectionReset = window.setTimeout(resetWheelSelectionGate, wheelSelectionCooldownMs);

    const now = window.performance.now();

    if (wheelSelectionLocked || now < wheelSelectionLockedUntil) {
      return;
    }

    if (direction !== wheelSelectionDirection) {
      wheelSelectionAccumulator = 0;
      wheelSelectionDirection = direction;
    }

    wheelSelectionAccumulator += Math.abs(dominantDelta);

    if (
      wheelSelectionAccumulator < wheelSelectionThreshold ||
      now - lastWheelSelectionAt < wheelSelectionCooldownMs
    ) {
      return;
    }

    lastWheelSelectionAt = now;
    wheelSelectionAccumulator = 0;
    wheelSelectionLocked = true;
    wheelSelectionLockedUntil = now + wheelSelectionCooldownMs;
    pointerSelectionSuppressedUntil = now + pointerSelectionSuppressMs;
    selectAppIndex(focusedIndex + direction, { scroll: true });
  },
  { passive: false }
);

grid.addEventListener("dblclick", launchFocusedApp);
launchButton.addEventListener("click", launchFocusedApp);
detailsButton.addEventListener("click", openFocusedApp);

window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    pointerSelectionSuppressedUntil = window.performance.now() + pointerSelectionSuppressMs;
    selectAppIndex(focusedIndex + 1, { scroll: true });
  }

  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    pointerSelectionSuppressedUntil = window.performance.now() + pointerSelectionSuppressMs;
    selectAppIndex(focusedIndex - 1, { scroll: true });
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
renderGrid();
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
