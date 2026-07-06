import type { DashboardApp } from "../apps";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

export function renderLibraryView(apps: DashboardApp[]) {
  return `
    <div class="library-view">
      <div class="library-summary">
        <strong>${apps.length} installed</strong>
        <span>All applications</span>
      </div>
      <div class="library-grid" aria-label="Installed applications">
        ${apps
          .map(
            (app, index) => `
              <button
                class="library-app"
                type="button"
                data-library-app="${escapeHtml(app.id)}"
                style="--accent: ${escapeHtml(app.accent)}; --delay: ${index * 34}ms"
              >
                <span class="library-icon">${escapeHtml(app.name.slice(0, 1))}</span>
                <span class="library-label">${escapeHtml(app.name)}</span>
              </button>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}
