import { getLibraryPermissionsAdministration, saveMemberLibraryPermissions } from "../api/accountApi";
import type { LibraryPermissionsAdministration, MemberLibraryAccess } from "../shared/libraryPermissionTypes";

const escapeHtml = (value: string) => value
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export const renderLibraryPermissionsPanel = () => `
  <section class="account-library-permissions-panel">
    <p class="eyebrow">Media access</p>
    <h4>Library permissions</h4>
    <p>Choose the media libraries each member may browse and play. Files access is managed separately and does not change here.</p>
    <div data-library-permissions><p>Loading library permissions...</p></div>
  </section>`;

const renderMember = (member: MemberLibraryAccess, administration: LibraryPermissionsAdministration) => {
  const selected = new Set(member.libraryIds);
  return `<form class="account-library-permission-card" data-library-member="${member.id}">
    <header><div><strong>${escapeHtml(member.displayName)}</strong><span>@${escapeHtml(member.username)}${member.disabled ? " · disabled" : ""}</span></div><span data-library-save-status></span></header>
    <fieldset>
      <legend>Access policy</legend>
      <label><input type="radio" name="mode" value="all" ${member.mode === "all" ? "checked" : ""} /> All current and future libraries</label>
      <label><input type="radio" name="mode" value="selected" ${member.mode === "selected" ? "checked" : ""} /> Only selected libraries</label>
    </fieldset>
    <div class="account-library-options">
      ${administration.libraries.map((library) => `<label><input type="checkbox" name="libraryId" value="${library.id}" ${selected.has(library.id) ? "checked" : ""} ${member.mode === "all" ? "disabled" : ""} /><span><strong>${escapeHtml(library.name)}</strong><small>${escapeHtml(library.mediaKind)} media</small></span></label>`).join("") || "<p>No media libraries are configured.</p>"}
    </div>
    <button type="submit">Save media access</button>
  </form>`;
};

export const bindLibraryPermissionsPanel = (container: ParentNode) => {
  const root = container.querySelector<HTMLElement>("[data-library-permissions]");
  if (!root) return;
  let administration: LibraryPermissionsAdministration | null = null;

  const render = () => {
    if (!administration) return;
    root.innerHTML = administration.members.map((member) => renderMember(member, administration!)).join("")
      || "<p>Add a member account to configure media access.</p>";
  };

  const load = async () => {
    try {
      administration = await getLibraryPermissionsAdministration();
      render();
    } catch (error) {
      root.textContent = error instanceof Error ? error.message : "Unable to load library permissions.";
    }
  };

  root.addEventListener("change", (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('input[name="mode"]');
    if (!input) return;
    const form = input.closest<HTMLFormElement>("[data-library-member]");
    form?.querySelectorAll<HTMLInputElement>('input[name="libraryId"]').forEach((library) => {
      library.disabled = input.value === "all";
    });
  });

  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = (event.target as HTMLElement).closest<HTMLFormElement>("[data-library-member]");
    if (!form || !administration) return;
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const status = form.querySelector<HTMLElement>("[data-library-save-status]");
    const data = new FormData(form);
    const mode = data.get("mode") === "selected" ? "selected" : "all";
    const libraryIds = mode === "selected" ? data.getAll("libraryId").map(String) : [];
    if (button) button.disabled = true;
    if (status) status.textContent = "Saving...";
    try {
      const { member } = await saveMemberLibraryPermissions(form.dataset.libraryMember ?? "", { libraryIds, mode });
      administration.members = administration.members.map((entry) => entry.id === member.id ? member : entry);
      render();
      const updated = root.querySelector<HTMLElement>(`[data-library-member="${member.id}"] [data-library-save-status]`);
      if (updated) updated.textContent = "Saved";
    } catch (error) {
      if (status) status.textContent = error instanceof Error ? error.message : "Unable to save media access.";
      if (button) button.disabled = false;
    }
  });

  container.addEventListener("nebula:members-changed", () => void load());

  void load();
};
