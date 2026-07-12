import { renderAppIcon } from "../appIcons";
import { getApiBaseUrl, getApiConnectionMode, getAppOrigin, getEffectiveApiBaseUrl, getApiToken } from "../api/http";
import { dashboardApps } from "../apps";
import type { DiagnosticsSnapshot } from "../diagnostics/types";
import type { AccountSessionState } from "../shared/accountTypes";
import { renderAccountSettings } from "../account/accountUi";
import { renderJobsAdmin } from "../jobs-admin/renderJobsAdmin";

const formatNumber = (value: number, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : "0.0");

const statusText = (value: boolean) => (value ? "Available" : "Unavailable");

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const renderMetric = (label: string, value: string) => `
  <span class="diagnostic-metric">
    <small>${label}</small>
    <strong>${value}</strong>
  </span>
`;

const renderSection = (title: string, body: string) => `
  <section class="diagnostic-section" data-diagnostic-section="${title.toLowerCase().replaceAll(" ", "-")}">
    <h3>${title}</h3>
    <div class="diagnostic-grid">
      ${body}
    </div>
  </section>
`;

export function renderSettingsPanel(snapshot: DiagnosticsSnapshot, accountSession: AccountSessionState): string {
  const settingsApp = dashboardApps.find((app) => app.id === "settings");
  const showJobsAdmin = accountSession.user.role === "owner";
  const configuredApiBaseUrl = getApiBaseUrl();
  const effectiveApiBaseUrl = getEffectiveApiBaseUrl();
  const apiToken = getApiToken();
  const serverTarget = effectiveApiBaseUrl || "Not configured";
  const serverMode = getApiConnectionMode();
  const rendererFeatures =
    snapshot.renderer.features.length > 0 ? snapshot.renderer.features.slice(0, 6).join(", ") : "No optional features reported";

  const rendererLimits =
    snapshot.renderer.limits.length > 0
      ? snapshot.renderer.limits.map(([label, value]) => renderMetric(label, value)).join("")
      : renderMetric("Limits", "Unavailable");

  const appRows = snapshot.apps.apps
    .map(
      (app) => `
        <span class="app-diagnostic-row" style="--accent: ${app.accent}">
          <i></i>
          <strong>${app.name}</strong>
          <small>${app.id} · ${app.status}</small>
        </span>
      `
    )
    .join("");

  return `
    <div class="panel-header">
      <span class="panel-mark">${settingsApp ? renderAppIcon(settingsApp, "panel-icon") : ""}</span>
      <div>
        <p class="eyebrow">System</p>
        <h2>Settings</h2>
      </div>
      <button id="close-panel" class="icon-command" type="button" aria-label="Close panel" title="Close">×</button>
    </div>
    <p class="panel-intro">Runtime settings and diagnostics for the dashboard shell.</p>

    <div class="settings-categories" aria-label="Settings categories">
      <button class="active" type="button" data-diagnostic-tab="all">Overview</button>
      <button type="button" data-diagnostic-tab="account">Account</button>
      ${showJobsAdmin ? `<button type="button" data-diagnostic-tab="jobs">Jobs</button>` : ""}
      <button type="button" data-diagnostic-tab="renderer">Renderer</button>
      <button type="button" data-diagnostic-tab="display">Display</button>
      <button type="button" data-diagnostic-tab="performance">Performance</button>
      <button type="button" data-diagnostic-tab="apps">Apps</button>
      <button type="button" data-diagnostic-tab="client">Client</button>
      <button type="button" data-diagnostic-tab="runtime">Runtime</button>
    </div>

    <div class="diagnostics-board">
      ${renderAccountSettings(accountSession)}
      ${showJobsAdmin ? renderJobsAdmin() : ""}
      ${renderSection(
        "Renderer",
        [
          renderMetric("Mode", snapshot.renderer.mode),
          renderMetric("Adapter", snapshot.renderer.adapterName),
          renderMetric("WebGPU", statusText(snapshot.renderer.webgpuAvailable)),
          renderMetric("Canvas format", snapshot.renderer.preferredFormat),
          renderMetric("Features", rendererFeatures)
        ].join("")
      )}

      ${renderSection(
        "Display",
        [
          renderMetric("Viewport", snapshot.display.viewport),
          renderMetric("Screen", snapshot.display.screen),
          renderMetric("Pixel ratio", formatNumber(snapshot.display.devicePixelRatio, 2)),
          renderMetric("Orientation", snapshot.display.orientation),
          renderMetric("Color scheme", snapshot.display.colorScheme),
          renderMetric("Reduced motion", snapshot.display.reducedMotion ? "Reduce" : "No preference")
        ].join("")
      )}

      ${renderSection(
        "Performance",
        [
          renderMetric("FPS", formatNumber(snapshot.performance.fps)),
          renderMetric("Frame time", `${formatNumber(snapshot.performance.averageFrameMs, 2)} ms`),
          renderMetric("Samples", String(snapshot.performance.samples)),
          renderMetric("Uptime", `${formatNumber(snapshot.performance.uptimeSeconds)} s`)
        ].join("")
      )}

      ${renderSection(
        "Apps",
        [
          renderMetric("Installed", String(snapshot.apps.appCount)),
          renderMetric("Focused", snapshot.apps.focusedApp.name),
          renderMetric("Navigation", snapshot.apps.activeNavigation),
          renderMetric("Open panel", snapshot.apps.openPanel),
          `<div class="app-diagnostic-list">${appRows}</div>`
        ].join("")
      )}

      <section class="diagnostic-section client-settings-section" data-diagnostic-section="client">
        <h3>Client & Server</h3>
        <div class="client-settings-form">
          <div class="server-info-grid">
            ${renderMetric("App origin", getAppOrigin())}
            ${renderMetric("API target", serverTarget)}
            ${renderMetric("Connection", serverMode)}
            ${renderMetric("Auth token", apiToken ? "Configured" : "Not set")}
          </div>
          <p class="server-info-note">
            iOS clients need a reachable Nebula server URL, such as a LAN or WireGuard address.
          </p>
          <label>
            <small>Server URL</small>
            <input
              type="url"
              data-api-base-input
              placeholder="Same origin"
              value="${escapeHtml(configuredApiBaseUrl)}"
            />
          </label>
          <label>
            <small>API Token</small>
            <input
              type="password"
              data-api-token-input
              placeholder="Optional bearer token"
              value="${escapeHtml(apiToken)}"
            />
          </label>
          <div class="client-settings-actions">
            <button type="button" data-api-base-save>Save</button>
            <button type="button" data-api-base-clear>Use Same Origin</button>
            <button type="button" data-server-test>Test Server</button>
            <span data-api-base-status></span>
          </div>
        </div>
      </section>

      ${renderSection("GPU Limits", rendererLimits)}

      ${renderSection(
        "Runtime",
        [
          renderMetric("Platform", snapshot.runtime.platform),
          renderMetric("Language", snapshot.runtime.language),
          renderMetric("Network", snapshot.runtime.online ? "Online" : "Offline"),
          renderMetric("Updated", new Date(snapshot.timestamp).toLocaleTimeString()),
          renderMetric("User agent", snapshot.runtime.userAgent)
        ].join("")
      )}
    </div>
  `;
}
