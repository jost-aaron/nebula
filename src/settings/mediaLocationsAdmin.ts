import { addMediaLocation, listMediaLocations, reindexMediaLibrary, removeMediaLocation } from "../api/mediaLocationsApi";
import type { MediaLocation, MediaLocationCategory } from "../shared/mediaLocationTypes";
import "./mediaLocationsAdmin.css";

const categories: Array<{ id: MediaLocationCategory; label: string; placeholder: string }> = [
  { id: "movies", label: "Movies", placeholder: "Movies" },
  { id: "tv", label: "TV Shows", placeholder: "TV Shows" },
  { id: "music", label: "Music", placeholder: "Music" }
];
const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export const renderMediaLocationsAdmin = () => `
  <section class="media-locations-admin diagnostic-section" data-diagnostic-section="media-locations" aria-live="polite">
    <div class="media-locations-heading"><div><h3>Media Locations</h3><p>Choose one or more folders beneath <code>/app/content</code>. Nebula merges every folder into Movies, TV Shows, or Music. With no explicit folders, the complete content root is scanned for backward compatibility.</p></div><button type="button" data-media-locations-refresh>Refresh</button></div>
    <div data-media-locations-content><p>Loading media locations...</p></div>
    <div class="media-library-reindex"><div><strong>Re-index entire library</strong><p>Rescan every configured folder and repair Movies, TV Shows, and Music classification. Accounts, playback history, settings, and media files are not changed.</p></div><button type="button" data-media-library-reindex>Re-index library</button></div>
    <span class="media-locations-message" data-media-locations-message></span>
  </section>`;

const renderLocations = (locations: MediaLocation[]) => `<div class="media-location-groups">${categories.map((category) => {
  const matching = locations.filter((location) => location.category === category.id);
  return `<section class="media-location-group"><header><div><span>${category.label.slice(0, 1)}</span><h4>${category.label}</h4></div><small>${matching.length} ${matching.length === 1 ? "folder" : "folders"}</small></header>
    <div class="media-location-list">${matching.length ? matching.map((location) => `<div class="media-location-row"><code>/app/content/${escapeHtml(location.contentPath)}</code><button type="button" data-media-location-remove="${location.id}">Remove</button></div>`).join("") : `<p>${locations.length === 0 ? "No explicit folders yet; the complete content root is currently scanned." : `No ${category.label.toLowerCase()} folders are configured.`}</p>`}</div>
    <form data-media-location-form="${category.id}"><label><span>Add ${category.label} folder</span><div><span>/app/content/</span><input name="contentPath" required autocomplete="off" placeholder="${category.placeholder}"></div></label><button type="submit">Add folder</button></form>
  </section>`;
}).join("")}</div>`;

export const bindMediaLocationsAdmin = (container: ParentNode) => {
  const root = container.querySelector<HTMLElement>(".media-locations-admin");
  const content = root?.querySelector<HTMLElement>("[data-media-locations-content]");
  const message = root?.querySelector<HTMLElement>("[data-media-locations-message]");
  if (!root || !content || !message) return () => {};
  let disposed = false;
  const show = (value: string) => { message.textContent = value; };
  const load = async () => {
    try {
      const { locations } = await listMediaLocations();
      if (disposed) return;
      content.innerHTML = renderLocations(locations);
      content.querySelectorAll<HTMLFormElement>("[data-media-location-form]").forEach((form) => form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const category = form.dataset.mediaLocationForm as MediaLocationCategory;
        const input = form.elements.namedItem("contentPath") as HTMLInputElement;
        const button = form.querySelector<HTMLButtonElement>("button[type='submit']");
        if (!input.value.trim() || !button) return;
        button.disabled = true; show("Adding folder and scheduling a library scan...");
        try { await addMediaLocation(category, input.value); await load(); show("Folder added. A low-priority scan has been scheduled."); }
        catch (error) { show(error instanceof Error ? error.message : "Folder could not be added."); button.disabled = false; }
      }));
      content.querySelectorAll<HTMLButtonElement>("[data-media-location-remove]").forEach((button) => button.addEventListener("click", async () => {
        if (button.dataset.confirm !== "true") { button.dataset.confirm = "true"; button.textContent = "Confirm"; show("Confirm removal. Media files will not be deleted."); return; }
        button.disabled = true; show("Removing folder configuration...");
        try { await removeMediaLocation(button.dataset.mediaLocationRemove!); await load(); show("Folder removed. Media files were untouched and a scan was scheduled."); }
        catch (error) { show(error instanceof Error ? error.message : "Folder could not be removed."); button.disabled = false; }
      }));
    } catch (error) { show(error instanceof Error ? error.message : "Media locations could not be loaded."); }
  };
  root.querySelector("[data-media-locations-refresh]")?.addEventListener("click", () => void load());
  root.querySelector<HTMLButtonElement>("[data-media-library-reindex]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    if (button.dataset.confirm !== "true") {
      button.dataset.confirm = "true";
      button.textContent = "Confirm re-index";
      show("Confirm a full library re-index. Account data and media files will be preserved.");
      return;
    }
    button.disabled = true;
    show("Scheduling a full library re-index...");
    try {
      const result = await reindexMediaLibrary();
      show(result.scanQueued ? "Full library re-index queued. You can follow progress under Jobs." : "A library re-index is already queued or running.");
      button.textContent = "Re-index scheduled";
    } catch (error) {
      show(error instanceof Error ? error.message : "Library re-index could not be scheduled.");
      button.disabled = false;
    }
  });
  void load();
  return () => { disposed = true; };
};
