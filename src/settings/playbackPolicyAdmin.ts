import { getPlaybackPolicy, getPlaybackPolicyStatus, saveGlobalPlaybackPolicy, saveUserPlaybackPolicy, type PlaybackPolicyLimits, type PlaybackPolicySnapshot } from "../api/playbackPolicyApi";
import "./playbackPolicyAdmin.css";

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const value = (input: number | null | undefined) => input === null || input === undefined ? "" : String(input);
const bitrate = (bits: number | null) => bits === null ? "Unlimited" : `${(bits / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} Mbps`;
const streamLimit = (count: number | null) => count === null ? "Unlimited" : String(count);

export const renderPlaybackPolicyAdmin = () => `
  <section class="playback-policy-admin diagnostic-section" data-diagnostic-section="playback-policy" aria-live="polite">
    <div class="playback-policy-heading">
      <div><h3>Playback Policy</h3><p>Bound server-produced remux and HLS sessions. Blank limits preserve unlimited behavior.</p></div>
      <button type="button" data-policy-refresh>Refresh</button>
    </div>
    <p class="playback-policy-note"><strong>Direct-play limitation:</strong> direct file byte ranges are not counted or bitrate-shaped because the current HTTP endpoint cannot reliably identify playback completion. Client capability checks still apply.</p>
    <div data-policy-content><p class="playback-policy-loading">Loading playback policy…</p></div>
    <span class="playback-policy-message" data-policy-message></span>
  </section>`;

const fields = (policy: PlaybackPolicyLimits, prefix: string, inherited = false) => `
  <label><span>Concurrent streams</span><input type="number" min="1" max="100" inputmode="numeric" name="maxConcurrentStreams" value="${value(policy.maxConcurrentStreams)}" placeholder="${inherited ? "No account limit" : "Unlimited"}" aria-label="${prefix} concurrent stream limit"></label>
  <label><span>Maximum bitrate (bps)</span><input type="number" min="64000" max="1000000000" step="1000" inputmode="numeric" name="maxBitrate" value="${value(policy.maxBitrate)}" placeholder="${inherited ? "Inherit global" : "Unlimited"}" aria-label="${prefix} bitrate limit"></label>`;

const renderSnapshot = (snapshot: PlaybackPolicySnapshot) => `
  <div class="playback-policy-summary">
    <span><small>Active governed streams</small><strong>${snapshot.activeStreams ?? 0}</strong></span>
    <span><small>Global stream ceiling</small><strong>${streamLimit(snapshot.global.maxConcurrentStreams)}</strong></span>
    <span><small>Global bitrate ceiling</small><strong>${bitrate(snapshot.global.maxBitrate)}</strong></span>
  </div>
  <form class="playback-policy-form playback-policy-global" data-policy-global>
    <div><h4>Server-wide limits</h4><p>The stream limit is aggregate across all accounts.</p></div>
    ${fields(snapshot.global, "Global")}
    <button type="submit">Save global policy</button>
  </form>
  <div class="playback-policy-users">
    <div><h4>Account limits</h4><p>Per-account stream limits are independent; bitrate uses the strictest global or account value.</p></div>
    ${snapshot.users.map((user) => `
      <form class="playback-policy-form" data-policy-user="${user.id}">
        <div class="playback-policy-user-title"><strong>${escapeHtml(user.displayName)}</strong><span>@${escapeHtml(user.username)}${user.disabled ? " · disabled" : ""}</span><small>${user.activeStreams} active · effective ${streamLimit(user.effective.maxConcurrentStreams)} streams · ${bitrate(user.effective.maxBitrate)}</small></div>
        ${fields(user.override ?? { maxBitrate: null, maxConcurrentStreams: null }, user.displayName, true)}
        <button type="submit">Save account policy</button>
      </form>`).join("")}
  </div>`;

const readLimits = (form: HTMLFormElement): PlaybackPolicyLimits => {
  const data = new FormData(form);
  const parse = (name: string) => {
    const raw = String(data.get(name) ?? "").trim();
    return raw ? Number(raw) : null;
  };
  return { maxBitrate: parse("maxBitrate"), maxConcurrentStreams: parse("maxConcurrentStreams") };
};

export const bindPlaybackPolicyAdmin = (container: ParentNode) => {
  const root = container.querySelector<HTMLElement>(".playback-policy-admin");
  const content = root?.querySelector<HTMLElement>("[data-policy-content]");
  const message = root?.querySelector<HTMLElement>("[data-policy-message]");
  if (!root || !content || !message) return () => {};
  let disposed = false;
  const show = (text: string) => { message.textContent = text; };
  const bindForms = () => {
    root.querySelector<HTMLFormElement>("[data-policy-global]")?.addEventListener("submit", async (event) => {
      event.preventDefault(); show("Saving server-wide policy…");
      try { await saveGlobalPlaybackPolicy(readLimits(event.currentTarget as HTMLFormElement)); await load(); show("Server-wide policy saved."); } catch (error) { show(error instanceof Error ? error.message : "Policy could not be saved."); }
    });
    root.querySelectorAll<HTMLFormElement>("[data-policy-user]").forEach((form) => form.addEventListener("submit", async (event) => {
      event.preventDefault(); show("Saving account policy…");
      try { await saveUserPlaybackPolicy(form.dataset.policyUser ?? "", readLimits(form)); await load(); show("Account policy saved."); } catch (error) { show(error instanceof Error ? error.message : "Policy could not be saved."); }
    }));
  };
  const load = async (status = false) => {
    try {
      const snapshot = status ? await getPlaybackPolicyStatus() : await getPlaybackPolicy();
      if (disposed) return;
      content.innerHTML = renderSnapshot(snapshot); bindForms();
    } catch (error) { if (!disposed) show(error instanceof Error ? error.message : "Playback policy could not be loaded."); }
  };
  root.querySelector("[data-policy-refresh]")?.addEventListener("click", () => { show("Refreshing…"); void load(true).then(() => show("Playback status refreshed.")); });
  void load(true);
  const timer = window.setInterval(() => { if (!root.hidden) void load(true); }, 10_000);
  return () => { disposed = true; window.clearInterval(timer); };
};
