import { renderAppIcon } from "./appIcons";
import { getAuthStatus, getCurrentAccount } from "./api/accountApi";
import { apiJson, getApiConnectionMode, getEffectiveApiBaseUrl, getApiToken, initializeAccountSession, setAccountSessionToken, setApiBaseUrl, setApiToken } from "./api/http";
import { bindAccountGate, bindAccountIdentity, bindAccountSettings, bindServerConnection, renderAccountGate, renderAccountIdentity, renderAccountLoading, renderGuestIdentity, renderServerConnection } from "./account/accountUi";
import { dashboardApps, type DashboardApp } from "./apps";
import { bindCinemaView, renderCinemaView } from "./cinema/renderCinemaView";
import { collectDiagnostics } from "./diagnostics/collectDiagnostics";
import { createPerformanceMonitor } from "./diagnostics/performanceMonitor";
import type { RendererRuntimeState } from "./diagnostics/types";
import { bindFileBrowser, renderFileBrowserShell } from "./files/fileBrowser";
import { bindJobsAdmin } from "./jobs-admin/renderJobsAdmin";
import { bindActivityAdmin } from "./activity-admin/renderActivityAdmin";
import { filterApps, renderSearchResults, renderSearchView } from "./search/renderSearchView";
import { renderSettingsPanel } from "./settings/renderSettingsPanel";
import { bindPlaybackPolicyAdmin } from "./settings/playbackPolicyAdmin";
import { bindTranscodeAccelerationAdmin } from "./settings/transcodeAccelerationAdmin";
import { bindRenditionStorageAdmin } from "./settings/renditionStorageAdmin";
import { bindStudioView, renderStudioView } from "./studio/renderStudioView";
import { commandFromKey, type ShellCommand } from "./shell/commands";
import { bindGamepadCommands } from "./shell/gamepad";
import { WheelCommandGate } from "./shell/inputGates";
import { loadFocusedAppId, saveFocusedAppId } from "./shell/persistence";
import { createShellState, transitionShellState } from "./shell/state";
import { startRenderer } from "./webgpuRenderer";
import type { AccountSessionState, CurrentSessionState } from "./shared/accountTypes";
import "./styles.css";
import "./cinema/tmdb.css";

const root = document.querySelector<HTMLDivElement>("#app");
const canvas = document.querySelector<HTMLCanvasElement>("#gpu-scene");

if (!root || !canvas) {
  throw new Error("Dashboard root or render canvas is missing.");
}

root.innerHTML = renderAccountLoading();

const startDashboard = (accountSession: CurrentSessionState) => {
const isGuest = accountSession.principal === "guest" || !accountSession.user;
const availableApps = isGuest ? dashboardApps.filter((app) => ["cinema", "studio", "search"].includes(app.id)) : dashboardApps;
const appIds = availableApps.map((app) => app.id);
const principalId = accountSession.user?.id ?? "guest";
let shellState = createShellState(appIds, loadFocusedAppId(window.localStorage, principalId, appIds));
let rendererState: RendererRuntimeState = {
  adapterName: "Checking GPU",
  mode: "checking"
};
let disposeActiveApp: (() => void) | null = null;

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
          <span id="controller-status" class="system-pill">Controller Ready</span>
          ${isGuest ? renderGuestIdentity() : renderAccountIdentity(accountSession.user!)}
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
          <span>${availableApps.length} available</span>
        </div>
        <div id="app-grid" class="app-grid" role="toolbar" aria-label="Applications"></div>
      </section>

      <section id="detail-panel" class="detail-panel" hidden></section>
    </section>
  </main>
  <section id="app-surface" class="app-surface" role="dialog" aria-modal="true" aria-live="polite" tabindex="-1" hidden></section>
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
const controllerStatus = document.querySelector<HTMLSpanElement>("#controller-status");
const shellRoot = document.querySelector<HTMLElement>(".shell");

if (!grid || !featuredTitle || !featuredDescription || !launchButton || !detailsButton || !detailPanel || !appSurface || !gpuStatus || !clock || !controllerStatus || !shellRoot) {
  throw new Error("Dashboard controls failed to initialize.");
}

const focusedIndex = () => Math.max(0, appIds.indexOf(shellState.focusedAppId));
const focusedApp = () => availableApps[focusedIndex()];
const detailApp = () => availableApps.find((app) => app.id === shellState.detailAppId) ?? null;
let restoreFocusTo: HTMLElement | null = null;

const rememberFocus = (fallback: HTMLElement) => {
  restoreFocusTo = document.activeElement instanceof HTMLElement && root.contains(document.activeElement)
    ? document.activeElement
    : fallback;
};

const restoreShellFocus = () => {
  const target = restoreFocusTo?.isConnected ? restoreFocusTo : grid.querySelector<HTMLButtonElement>(`.app-tile[data-app-id="${shellState.focusedAppId}"]`);
  restoreFocusTo = null;
  window.setTimeout(() => target?.focus(), 0);
};

const renderGrid = () => {
  grid.innerHTML = availableApps
    .map((app, index) => {
      const isFocused = app.id === shellState.focusedAppId;
      return `
        <button
          class="app-tile ${isFocused ? "focused" : ""}"
          type="button"
          data-index="${index}"
          data-app-id="${app.id}"
          style="--accent: ${app.accent}"
          aria-label="${app.name}, ${app.kind}, ${app.status}"
          aria-current="${isFocused ? "true" : "false"}"
          tabindex="${isFocused ? "0" : "-1"}"
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
    const isFocused = button.dataset.appId === shellState.focusedAppId;
    button.classList.toggle("focused", isFocused);
    button.setAttribute("aria-current", isFocused ? "true" : "false");
    button.tabIndex = isFocused ? 0 : -1;
  });
};

const scrollFocusedTileIntoView = () => {
  grid
    .querySelector<HTMLButtonElement>(`.app-tile[data-app-id="${shellState.focusedAppId}"]`)
    ?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
};

const renderFocus = ({ scroll = true }: { scroll?: boolean } = {}) => {
  const app = focusedApp();
  document.documentElement.dataset.focusIndex = String(focusedIndex());
  featuredTitle.textContent = app.name;
  featuredDescription.textContent = app.description;
  launchButton.textContent = app.status === "planned" ? "Preview" : "Open";
  renderGridFocus();

  if (scroll) {
    scrollFocusedTileIntoView();
  }
};

const selectAppId = (appId: string, options?: { scroll?: boolean; focus?: boolean }) => {
  const nextState = transitionShellState(shellState, { type: "select", appId }, appIds);
  if (nextState === shellState || nextState.focusedAppId === shellState.focusedAppId) {
    return false;
  }

  shellState = nextState;
  saveFocusedAppId(window.localStorage, principalId, shellState.focusedAppId);
  renderFocus(options);
  if (options?.focus) {
    grid.querySelector<HTMLButtonElement>(`.app-tile[data-app-id="${shellState.focusedAppId}"]`)?.focus();
  }
  return true;
};

const renderPanel = () => {
  const launchedApp = detailApp();
  if (!launchedApp) {
    detailPanel.hidden = true;
    detailPanel.innerHTML = "";
    return;
  }

  detailPanel.hidden = false;
  detailPanel.setAttribute("role", "dialog");
  detailPanel.setAttribute("aria-modal", "false");
  detailPanel.setAttribute("aria-labelledby", "shell-detail-title");
  detailPanel.innerHTML = `
    <div class="panel-header">
      <span class="panel-mark" style="--accent: ${launchedApp.accent}">${renderAppIcon(launchedApp, "panel-icon")}</span>
      <div>
        <p class="eyebrow">${launchedApp.kind}</p>
        <h2 id="shell-detail-title">${launchedApp.name}</h2>
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
    closeShellPanel();
  });
  window.setTimeout(() => detailPanel.querySelector<HTMLButtonElement>("#close-panel")?.focus(), 0);
};

const closeShellPanel = () => {
  if (!shellState.detailAppId) return;
  shellState = transitionShellState(shellState, { type: "close-detail" }, appIds);
  detailPanel.classList.remove("system-panel", "search-panel", "library-panel");
  renderPanel();
  restoreShellFocus();
};

const closeActiveApp = () => {
  if (!shellState.activeAppId) {
    return;
  }

  shellState = transitionShellState(shellState, { type: "close-active" }, appIds);
  disposeActiveApp?.();
  disposeActiveApp = null;
  appSurface.classList.remove("open");
  appSurface.classList.add("closing");

  window.setTimeout(() => {
    if (shellState.activeAppId) return;
    shellRoot.inert = false;
    appSurface.hidden = true;
    appSurface.className = "app-surface";
    appSurface.innerHTML = "";
    restoreShellFocus();
  }, 240);
};

const bindSettingsTabs = (container: ParentNode) => {
  const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-diagnostic-tab]"));
  const sections = Array.from(container.querySelectorAll<HTMLElement>("[data-diagnostic-section]"));

  const sectionGroups: Record<string, string[]> = {
    all: [],
    account: ["account"],
    jobs: ["jobs"],
    "playback-policy": ["playback-policy"],
    "transcode-acceleration": ["transcode-acceleration"],
    "rendition-storage": ["rendition-storage"],
    activity: ["activity"],
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

  save.addEventListener("click", async () => {
    await setApiBaseUrl(input.value);
    setApiToken(tokenInput.value);
    status.textContent = `Saved · ${getApiConnectionMode()}`;
  });

  clear.addEventListener("click", async () => {
    input.value = "";
    tokenInput.value = "";
    await setApiBaseUrl("");
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
      apps: availableApps,
      focusedIndex: focusedIndex(),
      launchedApp: detailApp(),
      performance: performanceMonitor.snapshot(),
      renderer: rendererState
    }),
    accountSession as AccountSessionState
  );

const launchApp = async (app: DashboardApp) => {
  const isSearchApp = app.id === "search";
  const isSettingsApp = app.id === "settings";
  const isFilesApp = app.id === "files";
  const isCinemaApp = app.id === "cinema";
  const isStudioApp = app.id === "studio";

  disposeActiveApp?.();
  disposeActiveApp = null;
  shellState = transitionShellState(
    transitionShellState(shellState, { type: "select", appId: app.id }, appIds),
    { type: "activate" },
    appIds
  );
  saveFocusedAppId(window.localStorage, principalId, shellState.focusedAppId);
  renderFocus();
  detailPanel.classList.remove("system-panel", "search-panel", "library-panel");
  renderPanel();

  const body = isSearchApp
    ? renderSearchView(availableApps, "app")
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
  shellRoot.inert = true;
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

  document.querySelector<HTMLButtonElement>("#close-active-app")?.addEventListener("click", () => dispatchShellCommand({ type: "back", source: "pointer" }));

  if (isSearchApp) {
    bindSearchControls(appSurface);
  }

  if (isSettingsApp) {
    appSurface.querySelector<HTMLButtonElement>("#close-panel")?.addEventListener("click", () => dispatchShellCommand({ type: "back", source: "pointer" }));
    bindSettingsTabs(appSurface);
    bindClientSettings(appSurface);
    bindAccountSettings(appSurface);
    if (accountSession.user?.role === "owner") {
      const disposeJobs = bindJobsAdmin(appSurface);
      const disposePlaybackPolicy = bindPlaybackPolicyAdmin(appSurface);
      const disposeAcceleration = bindTranscodeAccelerationAdmin(appSurface);
      const disposeRenditionStorage = bindRenditionStorageAdmin(appSurface);
      const disposeActivity = bindActivityAdmin(appSurface);
      disposeActiveApp = () => { disposeJobs(); disposePlaybackPolicy(); disposeAcceleration(); disposeRenditionStorage(); disposeActivity(); };
    }
  }

  if (isFilesApp) {
    bindFileBrowser(appSurface, {
      onOpenSettings: () => {
        const settingsApp = availableApps.find((candidate) => candidate.id === "settings");

        if (settingsApp) {
          void launchApp(settingsApp);
        }
      }
    });
    document.querySelector<HTMLButtonElement>("[data-file-close]")?.addEventListener("click", closeActiveApp);
  }

  if (isCinemaApp) {
    bindCinemaView(appSurface, closeActiveApp, { canManageRenditions: accountSession.user?.role === "owner", personalPlayback: !isGuest });
  }

  if (isStudioApp) {
    bindStudioView(appSurface, closeActiveApp, { personalPlayback: !isGuest });
  }

  requestAnimationFrame(() => {
    appSurface.classList.add("open");
    if (!appSurface.contains(document.activeElement)) {
      appSurface.focus();
    }
  });
};

const bindSearchControls = (container: ParentNode) => {
  const input = container.querySelector<HTMLInputElement>("[data-search-input]");
  const results = container.querySelector<HTMLElement>("[data-search-results]");
  const summary = container.querySelector<HTMLElement>("[data-search-summary]");

  if (!input || !results || !summary) {
    return;
  }

  let visibleApps = [...availableApps];
  let activeIndex = 0;

  const renderResults = () => {
    visibleApps = filterApps(availableApps, input.value);
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

    const app = availableApps.find((candidate) => candidate.id === button.dataset.searchResult);

    if (app) {
      void launchApp(app);
    }
  });

  renderResults();
  window.setTimeout(() => input.focus({ preventScroll: true }), 0);
};

const openFocusedApp = () => {
  rememberFocus(detailsButton);
  detailPanel.classList.remove("system-panel", "search-panel", "library-panel");
  shellState = transitionShellState(shellState, { type: "show-details" }, appIds);
  renderPanel();
};

const launchFocusedApp = () => {
  rememberFocus(launchButton);
  const app = focusedApp();
  void launchApp(app);
};

let closeAccountMenu: (() => boolean) | undefined;

let isDraggingGrid = false;
let gridDragStartX = 0;
let gridDragStartScrollLeft = 0;
let didDragGrid = false;
let wheelSelectionReset = 0;
let pointerSelectionSuppressedUntil = 0;

const wheelSelectionCooldownMs = 720;
const pointerSelectionSuppressMs = 1500;
const wheelCommandGate = new WheelCommandGate(140, wheelSelectionCooldownMs);

const resetWheelSelectionGate = () => {
  wheelCommandGate.reset();
  window.clearTimeout(wheelSelectionReset);
};

const dispatchShellCommand = (command: ShellCommand) => {
  if (command.type === "back") {
    if (closeAccountMenu?.()) return;
    if (shellState.activeAppId) {
      closeActiveApp();
      return;
    }
    closeShellPanel();
    return;
  }

  if (shellState.activeAppId || shellState.detailAppId) return;

  if (command.type === "move") {
    const nextState = transitionShellState(shellState, { type: "move", delta: command.delta }, appIds);
    if (nextState.focusedAppId === shellState.focusedAppId) return;
    shellState = nextState;
    saveFocusedAppId(window.localStorage, principalId, shellState.focusedAppId);
    pointerSelectionSuppressedUntil = window.performance.now() + pointerSelectionSuppressMs;
    renderFocus({ scroll: true });
    if (command.source !== "wheel") {
      grid.querySelector<HTMLButtonElement>(`.app-tile[data-app-id="${shellState.focusedAppId}"]`)?.focus();
    }
    return;
  }

  if (command.type === "select") {
    selectAppId(command.appId, { scroll: false });
    return;
  }

  if (command.type === "details") {
    openFocusedApp();
    return;
  }

  launchFocusedApp();
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

  if (button.dataset.appId) dispatchShellCommand({ type: "select", appId: button.dataset.appId, source: "pointer" });
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

  if (button.dataset.appId) dispatchShellCommand({ type: "select", appId: button.dataset.appId, source: "pointer" });
});

grid.addEventListener(
  "wheel",
  (event) => {
    const dominantDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (dominantDelta === 0) {
      return;
    }

    event.preventDefault();
    window.clearTimeout(wheelSelectionReset);
    wheelSelectionReset = window.setTimeout(resetWheelSelectionGate, wheelSelectionCooldownMs);

    const direction = wheelCommandGate.push(dominantDelta, window.performance.now());
    if (direction) dispatchShellCommand({ type: "move", delta: direction, source: "wheel" });
  },
  { passive: false }
);

grid.addEventListener("dblclick", () => dispatchShellCommand({ type: "open", source: "pointer" }));
launchButton.addEventListener("click", () => dispatchShellCommand({ type: "open", source: "pointer" }));
detailsButton.addEventListener("click", () => dispatchShellCommand({ type: "details", source: "pointer" }));
closeAccountMenu = bindAccountIdentity(root, {
  onOpenSettings: () => {
    const settingsApp = availableApps.find((candidate) => candidate.id === "settings");
    if (settingsApp) {
      void launchApp(settingsApp).then(() => {
        appSurface.querySelector<HTMLButtonElement>("[data-diagnostic-tab='account']")?.click();
      });
    }
  }
});

window.addEventListener("keydown", (event) => {
  const command = commandFromKey(event.key);
  if (!command) return;
  const target = event.target as HTMLElement | null;
  const isTile = Boolean(target?.closest(".app-tile"));
  if (command.type !== "back" && target?.closest("input, textarea, select, button") && !isTile) return;
  event.preventDefault();
  dispatchShellCommand(command);
});

window.addEventListener("gamepadconnected", () => { controllerStatus.textContent = "Controller Connected"; });
window.addEventListener("gamepaddisconnected", (event) => {
  const hasRemainingGamepad = navigator.getGamepads().some((candidate, index) =>
    candidate !== null && index !== event.gamepad.index
  );
  controllerStatus.textContent = hasRemainingGamepad ? "Controller Connected" : "Controller Ready";
});
bindGamepadCommands(window as unknown as import("./shell/gamepad").GamepadHost, dispatchShellCommand);

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
};

const bootAccount = async () => {
  root.innerHTML = renderAccountLoading();
  await initializeAccountSession();
  if (!getEffectiveApiBaseUrl()) {
    root.innerHTML = renderServerConnection();
    bindServerConnection(root);
    return;
  }

  try {
    const status = await getAuthStatus();
    if (status.authenticated && (status.user || status.principal === "guest")) {
      startDashboard(await getCurrentAccount());
      return;
    }
    if (status.setupRequired) {
      root.innerHTML = renderAccountGate(true, "", status.guestAvailable);
      bindAccountGate(root);
      return;
    }
    root.innerHTML = renderAccountGate(false);
    bindAccountGate(root);
  } catch {
    root.innerHTML = renderServerConnection("The configured server could not be reached. Check its address and try again.");
    bindServerConnection(root);
  }
};

window.addEventListener("nebula:session-expired", () => {
  void setAccountSessionToken("").finally(() => window.location.reload());
}, { once: true });

void bootAccount();
