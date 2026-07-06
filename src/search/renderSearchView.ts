import type { DashboardApp } from "../apps";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

export function filterApps(apps: DashboardApp[], query: string): DashboardApp[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return apps;
  }

  return apps.filter((app) => app.name.toLowerCase().includes(normalizedQuery));
}

export function renderSearchResults(apps: DashboardApp[]): string {
  if (apps.length === 0) {
    return `
      <div class="search-empty">
        <strong>No apps found</strong>
        <span>Try a different app name.</span>
      </div>
    `;
  }

  return apps
    .map(
      (app, index) => `
        <button
          class="search-result ${index === 0 ? "active" : ""}"
          type="button"
          data-search-result="${escapeHtml(app.id)}"
          style="--accent: ${escapeHtml(app.accent)}"
        >
          <span class="search-result-mark">${escapeHtml(app.name.slice(0, 1))}</span>
          <span class="search-result-copy">
            <strong>${escapeHtml(app.name)}</strong>
            <small>${escapeHtml(app.kind)} · ${escapeHtml(app.status)}</small>
          </span>
          <span class="search-result-action">Open</span>
        </button>
      `
    )
    .join("");
}

export function renderSearchView(apps: DashboardApp[], variant: "panel" | "app") {
  const heading = variant === "app" ? "Search" : "Spotlight";

  return `
    <div class="search-view" data-search-view>
      <label class="search-box">
        <span>${heading}</span>
        <input
          type="search"
          placeholder="Search apps by name"
          autocomplete="off"
          spellcheck="false"
          data-search-input
        />
      </label>
      <div class="search-summary" data-search-summary>${apps.length} apps available</div>
      <div class="search-results" data-search-results>
        ${renderSearchResults(apps)}
      </div>
    </div>
  `;
}
