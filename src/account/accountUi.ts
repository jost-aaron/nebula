import { changePassword, createMemberAccount, listAccountSessions, listAccounts, login, logout, revokeAccountSession, setMemberDisabled, setupOwner, updateProfile } from "../api/accountApi";
import { getApiBaseUrl, setApiBaseUrl } from "../api/http";
import type { AccountSessionState, AccountUser } from "../shared/accountTypes";

const escapeHtml = (value: string) => value
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export const renderAccountLoading = () => `
  <main class="account-stage" aria-busy="true">
    <section class="account-intro"><p class="eyebrow">Nebula OS</p><h1>Opening your dashboard</h1><p>Checking this server and restoring your session.</p></section>
    <div class="account-orbit" aria-hidden="true"><i></i><i></i><i></i></div>
  </main>`;

export const renderServerConnection = (message = "Connect this client to your Nebula server.") => `
  <main class="account-stage">
    <section class="account-intro"><p class="eyebrow">Nebula OS</p><h1>Find your server</h1><p>${escapeHtml(message)}</p></section>
    <form class="account-card" data-server-connect-form>
      <p class="eyebrow">Client connection</p><h2>Server URL</h2>
      <label><span>Reachable address</span><input type="url" required data-server-url value="${escapeHtml(getApiBaseUrl())}" placeholder="http://192.168.1.20:5173" /></label>
      <button class="primary-command" type="submit">Connect</button>
      <p class="account-message" data-account-message></p>
    </form>
  </main>`;

export const bindServerConnection = (container: ParentNode) => {
  const form = container.querySelector<HTMLFormElement>("[data-server-connect-form]");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = form.querySelector<HTMLInputElement>("[data-server-url]");
    if (!input) return;
    setApiBaseUrl(input.value);
    window.location.reload();
  });
};

export const renderAccountGate = (setupRequired: boolean, notice = "") => `
  <main class="account-stage">
    <section class="account-intro">
      <p class="eyebrow">Nebula OS · Local accounts</p>
      <h1>${setupRequired ? "Make this server yours" : "Welcome back"}</h1>
      <p>${setupRequired ? "Create the first owner account. Your media stays on this server and remains shared." : "Sign in to open your dashboard, personal watchlist, and devices."}</p>
      <ol><li><span>01</span>Identity</li><li><span>02</span>Secure session</li><li><span>03</span>Enter dashboard</li></ol>
    </section>
    <form class="account-card" data-account-form data-account-mode="${setupRequired ? "setup" : "login"}">
      <p class="eyebrow">${setupRequired ? "First-run owner setup" : "Account access"}</p>
      <h2>${setupRequired ? "Create owner" : "Enter Nebula"}</h2>
      <label><span>Account name</span><input name="username" required minlength="3" maxlength="32" autocomplete="username" /></label>
      ${setupRequired ? `<label><span>Display name</span><input name="displayName" required maxlength="80" autocomplete="name" /></label>` : ""}
      <label><span>Password</span><input name="password" type="password" required minlength="12" maxlength="128" autocomplete="${setupRequired ? "new-password" : "current-password"}" /></label>
      ${setupRequired ? `<label><span>Confirm password</span><input name="confirmPassword" type="password" required minlength="12" maxlength="128" autocomplete="new-password" /></label>` : ""}
      <button class="primary-command" type="submit">${setupRequired ? "Create owner" : "Enter Nebula"}</button>
      <p class="account-message" data-account-message>${escapeHtml(notice)}</p>
    </form>
  </main>`;

export const bindAccountGate = (container: ParentNode) => {
  const form = container.querySelector<HTMLFormElement>("[data-account-form]");
  if (!form) return;
  const message = form.querySelector<HTMLElement>("[data-account-message]");
  const submit = form.querySelector<HTMLButtonElement>("button[type='submit']");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const password = String(data.get("password") ?? "");
    if (form.dataset.accountMode === "setup" && password !== String(data.get("confirmPassword") ?? "")) {
      if (message) message.textContent = "Passwords do not match.";
      return;
    }
    if (submit) submit.disabled = true;
    if (message) message.textContent = form.dataset.accountMode === "setup" ? "Creating owner..." : "Signing in...";
    try {
      if (form.dataset.accountMode === "setup") {
        await setupOwner({ displayName: String(data.get("displayName") ?? ""), password, username: String(data.get("username") ?? "") });
      } else {
        await login({ password, username: String(data.get("username") ?? "") });
      }
      window.location.reload();
    } catch (error) {
      if (message) message.textContent = error instanceof Error ? error.message : "Unable to continue.";
      if (submit) submit.disabled = false;
    }
  });
};

const initials = (user: AccountUser) => user.displayName.split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase();

export const renderAccountIdentity = (user: AccountUser) => `
  <div class="account-identity">
    <button class="account-identity-button" type="button" data-account-menu-toggle aria-expanded="false">
      <span>${escapeHtml(initials(user))}</span><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.role)}</small>
    </button>
    <div class="account-menu" data-account-menu hidden>
      <div><span>${escapeHtml(initials(user))}</span><p><strong>${escapeHtml(user.displayName)}</strong><small>@${escapeHtml(user.username)} · ${escapeHtml(user.role)}</small></p></div>
      <button type="button" data-account-settings>Account settings</button>
      <button type="button" data-account-switch>Switch account</button>
      <button class="destructive" type="button" data-account-sign-out>Sign out</button>
    </div>
  </div>`;

export const bindAccountIdentity = (container: ParentNode, options: { onOpenSettings: () => void }) => {
  const toggle = container.querySelector<HTMLButtonElement>("[data-account-menu-toggle]");
  const menu = container.querySelector<HTMLElement>("[data-account-menu]");
  if (!toggle || !menu) return;
  toggle.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    toggle.setAttribute("aria-expanded", String(!menu.hidden));
  });
  container.querySelector("[data-account-settings]")?.addEventListener("click", () => {
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    options.onOpenSettings();
  });
  const signOut = async () => {
    try { await logout(); } finally { window.location.reload(); }
  };
  container.querySelector("[data-account-switch]")?.addEventListener("click", () => void signOut());
  container.querySelector("[data-account-sign-out]")?.addEventListener("click", () => void signOut());
  return () => {
    if (!menu.hidden) {
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      return true;
    }
    return false;
  };
};

export const renderAccountSettings = (session: AccountSessionState) => `
  <section class="diagnostic-section account-settings-section" data-diagnostic-section="account">
    <h3>Account</h3>
    <div class="account-settings-grid">
      <form data-account-profile-form>
        <p class="eyebrow">Profile</p><h4>${escapeHtml(session.user.displayName)}</h4>
        <label><span>Account name</span><input value="${escapeHtml(session.user.username)}" disabled /></label>
        <label><span>Display name</span><input name="displayName" required maxlength="80" value="${escapeHtml(session.user.displayName)}" /></label>
        <p class="account-detail">${escapeHtml(session.user.role)} · created ${new Date(session.user.createdAt).toLocaleDateString()}</p>
        <button type="submit">Save profile</button><span data-profile-status></span>
      </form>
      <form data-account-password-form>
        <p class="eyebrow">Security</p><h4>Change password</h4>
        <label><span>Current password</span><input name="currentPassword" type="password" required autocomplete="current-password" /></label>
        <label><span>New password</span><input name="newPassword" type="password" required minlength="12" maxlength="128" autocomplete="new-password" /></label>
        <label><span>Confirm new password</span><input name="confirmPassword" type="password" required minlength="12" maxlength="128" autocomplete="new-password" /></label>
        <button type="submit">Update password</button><span data-password-status></span>
      </form>
      <section class="account-sessions-panel">
        <p class="eyebrow">Devices</p><h4>Active sessions</h4><div data-account-sessions><p>Loading sessions...</p></div>
      </section>
      ${session.user.role === "owner" ? `<section class="account-members-panel"><p class="eyebrow">Server administration</p><h4>Accounts</h4><div data-account-members><p>Loading accounts...</p></div><form data-create-member-form><label><span>Account name</span><input name="username" required minlength="3" maxlength="32" /></label><label><span>Display name</span><input name="displayName" required maxlength="80" /></label><label><span>Temporary password</span><input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" /></label><button type="submit">Add member</button><span data-member-status></span></form></section>` : ""}
      <section class="account-signout-panel"><p><strong>Leave this dashboard</strong><span>Server and client connection settings stay on this device.</span></p><button class="destructive" type="button" data-settings-sign-out>Sign out</button></section>
    </div>
  </section>`;

export const bindAccountSettings = (container: ParentNode) => {
  const profile = container.querySelector<HTMLFormElement>("[data-account-profile-form]");
  profile?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = profile.querySelector<HTMLElement>("[data-profile-status]");
    try {
      const data = new FormData(profile);
      await updateProfile({ displayName: String(data.get("displayName") ?? "") });
      if (status) status.textContent = "Profile saved. It will appear everywhere after reload.";
    } catch (error) { if (status) status.textContent = error instanceof Error ? error.message : "Unable to save profile."; }
  });

  const password = container.querySelector<HTMLFormElement>("[data-account-password-form]");
  password?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(password);
    const status = password.querySelector<HTMLElement>("[data-password-status]");
    if (data.get("newPassword") !== data.get("confirmPassword")) { if (status) status.textContent = "New passwords do not match."; return; }
    try {
      await changePassword({ currentPassword: String(data.get("currentPassword") ?? ""), newPassword: String(data.get("newPassword") ?? "") });
      password.reset();
      if (status) status.textContent = "Password updated. Other sessions were revoked.";
      await loadSessions();
    } catch (error) { if (status) status.textContent = error instanceof Error ? error.message : "Unable to change password."; }
  });

  const sessionList = container.querySelector<HTMLElement>("[data-account-sessions]");
  const loadSessions = async () => {
    if (!sessionList) return;
    try {
      const { sessions } = await listAccountSessions();
      sessionList.innerHTML = sessions.map((item) => `<article class="account-session-row"><div><strong>${escapeHtml(item.clientLabel)}</strong><span>${item.current ? "Current device" : `Active ${new Date(item.lastSeenAt).toLocaleString()}`} · expires ${new Date(item.expiresAt).toLocaleDateString()}</span></div><button type="button" data-revoke-session="${item.id}">${item.current ? "Sign out" : "Revoke"}</button></article>`).join("") || "<p>No active sessions.</p>";
    } catch (error) { sessionList.textContent = error instanceof Error ? error.message : "Unable to load sessions."; }
  };
  sessionList?.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-revoke-session]");
    if (!button) return;
    const result = await revokeAccountSession(button.dataset.revokeSession ?? "");
    if (result.currentRevoked) window.location.reload(); else await loadSessions();
  });
  void loadSessions();

  const memberList = container.querySelector<HTMLElement>("[data-account-members]");
  const loadMembers = async () => {
    if (!memberList) return;
    try {
      const { accounts } = await listAccounts();
      memberList.innerHTML = accounts.map((account) => `<article class="account-session-row"><div><strong>${escapeHtml(account.displayName)}</strong><span>@${escapeHtml(account.username)} · ${account.role}${account.disabled ? " · disabled" : ""}</span></div>${account.role === "member" ? `<button type="button" data-member-id="${account.id}" data-member-disabled="${String(account.disabled)}">${account.disabled ? "Enable" : "Disable"}</button>` : ""}</article>`).join("");
    } catch (error) { memberList.textContent = error instanceof Error ? error.message : "Unable to load accounts."; }
  };
  memberList?.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-member-id]");
    if (!button) return;
    await setMemberDisabled(button.dataset.memberId ?? "", button.dataset.memberDisabled !== "true");
    await loadMembers();
  });
  const createMember = container.querySelector<HTMLFormElement>("[data-create-member-form]");
  createMember?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(createMember);
    const status = createMember.querySelector<HTMLElement>("[data-member-status]");
    try {
      await createMemberAccount({ displayName: String(data.get("displayName") ?? ""), password: String(data.get("password") ?? ""), username: String(data.get("username") ?? "") });
      createMember.reset();
      if (status) status.textContent = "Member added.";
      await loadMembers();
    } catch (error) { if (status) status.textContent = error instanceof Error ? error.message : "Unable to add member."; }
  });
  void loadMembers();

  container.querySelector("[data-settings-sign-out]")?.addEventListener("click", async () => {
    try { await logout(); } finally { window.location.reload(); }
  });
};
