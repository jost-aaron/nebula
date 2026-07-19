import { getTailscaleEnrollmentStatus, setTailscaleEnabled, type TailscaleEnrollmentStatus, type TailscaleNetworkPath, type TailscalePeerPath } from "../api/tailscaleApi";

const escapeHtml = (value: string) => value
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const pathLabels: Record<TailscalePeerPath["path"], string> = {
  derp: "DERP relay", direct: "Direct", idle: "Idle", "peer-relay": "Peer relay", unknown: "Unknown"
};

const formatBytes = (value: number) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
};

const renderPeer = (peer: TailscalePeerPath) => `
  <li class="tailscale-peer" data-path="${peer.path}">
    <span class="tailscale-path-dot" aria-hidden="true"></span>
    <div class="tailscale-peer-identity"><strong>${escapeHtml(peer.device)}</strong><small>${escapeHtml(peer.os)} · ${peer.online ? "Online" : "Offline"}</small></div>
    <div class="tailscale-peer-path"><strong>${pathLabels[peer.path]}</strong><small>${peer.path === "derp" && peer.relayRegion ? `Region ${escapeHtml(peer.relayRegion.toUpperCase())}` : peer.active ? "Active now" : "No active traffic"}</small></div>
    <small class="tailscale-peer-traffic">↓ ${formatBytes(peer.rxBytes)} · ↑ ${formatBytes(peer.txBytes)}</small>
  </li>`;

const renderNetworkPath = (networkPath?: TailscaleNetworkPath) => `
  <section class="tailscale-network-path" aria-labelledby="tailscale-network-path-title">
    <div class="tailscale-network-heading">
      <div><p class="eyebrow">Live diagnostics</p><h4 id="tailscale-network-path-title">Network Path</h4></div>
      <small>${networkPath ? `Updated ${new Date(networkPath.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : "Waiting for status"}</small>
    </div>
    ${networkPath ? `
      <div class="tailscale-path-summary" aria-label="Connection path summary">
        <span data-path="direct"><strong>${networkPath.summary.direct}</strong> Direct</span>
        <span data-path="peer-relay"><strong>${networkPath.summary.peerRelay}</strong> Peer relay</span>
        <span data-path="derp"><strong>${networkPath.summary.derp}</strong> DERP</span>
        <span data-path="idle"><strong>${networkPath.summary.idle + networkPath.summary.unknown}</strong> Idle</span>
      </div>
      ${networkPath.peers.length ? `<ul class="tailscale-peer-list">${networkPath.peers.map(renderPeer).join("")}</ul>` : `<p class="tailscale-network-empty">No peer devices are visible yet.</p>`}
    ` : `<p class="tailscale-network-empty">The companion has not published its first bounded status snapshot yet.</p>`}
    <p class="tailscale-path-note">Server-side view. Paths can change as Tailscale upgrades or falls back between direct and relayed connections. Nebula does not guess which peer is this browser.</p>
  </section>`;

export const renderTailscaleAdmin = () => `
  <section class="diagnostic-section tailscale-admin-section" data-diagnostic-section="remote-access">
    <div class="tailscale-admin-heading">
      <div><p class="eyebrow">Private network</p><h3>Tailscale Remote Access</h3></div>
      <span class="tailscale-state" data-tailscale-state>Checking</span>
    </div>
    <div class="tailscale-admin-body" data-tailscale-body aria-live="polite">
      <p>Checking the optional Tailscale companion...</p>
    </div>
  </section>`;

const renderStatus = (status: TailscaleEnrollmentStatus) => {
  if (!status.available || status.state === "unavailable") return `
    <div class="tailscale-callout">
      <strong>Tailscale control is unavailable.</strong>
      <p>This server predates the dormant Tailscale companion or was deployed without it. Rebuild the stack with the current Compose configuration; localhost access is unaffected.</p>
    </div>`;

  if (status.state === "disabled") return `
    <div class="tailscale-callout">
      <p class="eyebrow">Optional remote access</p>
      <strong>Tailscale is off</strong>
      <p>Enable the isolated companion for private tailnet-only HTTPS. Nebula stays available on localhost, Funnel remains disabled, and Nebula account sign-in is still required.</p>
      <div class="tailscale-actions"><button class="tailscale-primary-action" type="button" data-tailscale-enable>Enable Tailscale</button></div>
    </div>`;

  if (status.state === "connected") return `
    <div class="tailscale-connected">
      <span class="tailscale-orbit" aria-hidden="true"><i></i></span>
      <div><strong>Connected to your tailnet</strong><p>Nebula is being served privately over Tailscale HTTPS. Nebula account sign-in is still required.</p></div>
    </div>
    <div class="tailscale-actions">
      ${status.serverUrl ? `<a class="tailscale-primary-action" href="${escapeHtml(status.serverUrl)}" target="_blank" rel="noopener noreferrer">Open private Nebula URL</a>` : ""}
      <button class="tailscale-danger-action" type="button" data-tailscale-disable>Disable Tailscale</button>
    </div>
    ${status.serverUrl ? `<code>${escapeHtml(status.serverUrl)}</code>` : ""}
    ${renderNetworkPath(status.networkPath)}`;

  if (status.state === "https-required") return `
    <div class="tailscale-callout is-attention">
      <p class="eyebrow">Tailnet configuration required</p>
      <strong>Enable HTTPS certificates in Tailscale</strong>
      <p>The server joined your tailnet, but Tailscale refused to create the private HTTPS endpoint. In the Tailscale admin console, open DNS, enable MagicDNS if needed, then enable HTTPS Certificates.</p>
      <p class="tailscale-disclosure">Tailscale publishes this machine name and tailnet DNS name to Certificate Transparency when issuing the certificate.</p>
      <div class="tailscale-actions">
        <a class="tailscale-primary-action" href="https://tailscale.com/docs/how-to/set-up-https-certificates" target="_blank" rel="noopener noreferrer">Open HTTPS setup guide</a>
        <button class="tailscale-danger-action" type="button" data-tailscale-disable>Disable Tailscale</button>
      </div>
      <small>After enabling HTTPS in Tailscale, disable and re-enable Tailscale here to apply Serve again.</small>
    </div>`;

  if (status.state === "awaiting-login" && status.loginUrl) return `
    <div class="tailscale-callout is-ready">
      <p class="eyebrow">One-time server enrollment</p>
      <strong>Authenticate this Nebula server</strong>
      <p>Tailscale sign-in opens in a separate trusted page. Nebula never receives your identity-provider password, OAuth session, or tailnet credentials.</p>
      <div class="tailscale-actions">
        <a class="tailscale-primary-action" href="${escapeHtml(status.loginUrl)}" target="_blank" rel="noopener noreferrer" data-tailscale-login>Open Tailscale Sign-In</a>
        <button type="button" data-tailscale-copy>Copy sign-in link</button>
        <button class="tailscale-danger-action" type="button" data-tailscale-disable>Disable Tailscale</button>
      </div>
      <code data-tailscale-login-url>${escapeHtml(status.loginUrl)}</code>
      <small>The link is temporary. This page updates automatically after authentication.</small>
    </div>`;

  return `
    <div class="tailscale-callout">
      <strong>Waiting for the Tailscale companion</strong>
      <p>The isolated companion is starting. Its one-time sign-in link will appear here when it is ready.</p>
      <div class="tailscale-actions"><button class="tailscale-danger-action" type="button" data-tailscale-disable>Disable Tailscale</button></div>
    </div>`;
};

export const bindTailscaleAdmin = (container: ParentNode) => {
  const body = container.querySelector<HTMLElement>("[data-tailscale-body]");
  const state = container.querySelector<HTMLElement>("[data-tailscale-state]");
  if (!body || !state) return () => {};
  let disposed = false;
  let timer = 0;
  let changing = false;

  const load = async () => {
    window.clearTimeout(timer);
    try {
      const status = await getTailscaleEnrollmentStatus();
      if (disposed) return;
      state.textContent = status.state === "awaiting-login" ? "Sign-in required"
        : status.state === "connected" ? "Connected"
          : status.state === "https-required" ? "HTTPS setup required"
          : status.state === "starting" ? "Starting"
            : status.state === "disabled" ? "Off" : "Unavailable";
      state.dataset.state = status.state;
      body.innerHTML = renderStatus(status);
      body.querySelector<HTMLButtonElement>("[data-tailscale-enable]")?.addEventListener("click", () => void applyEnabled(true));
      body.querySelector<HTMLButtonElement>("[data-tailscale-disable]")?.addEventListener("click", (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        if (button.dataset.confirm !== "true") {
          button.dataset.confirm = "true";
          button.textContent = "Confirm disable";
          return;
        }
        void applyEnabled(false);
      });
      body.querySelector<HTMLButtonElement>("[data-tailscale-copy]")?.addEventListener("click", async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        try {
          await navigator.clipboard.writeText(status.loginUrl ?? "");
          button.textContent = "Copied";
        } catch { button.textContent = "Copy unavailable"; }
      });
      if (["disabled", "unavailable"].includes(status.state)) return;
    } catch (error) {
      if (disposed) return;
      state.textContent = "Unavailable";
      body.innerHTML = `<div class="tailscale-callout"><strong>Unable to read Tailscale status</strong><p>${escapeHtml(error instanceof Error ? error.message : "Try again shortly.")}</p></div>`;
    }
    timer = window.setTimeout(load, 5000);
  };

  const applyEnabled = async (enabled: boolean) => {
    if (changing) return;
    changing = true;
    state.textContent = enabled ? "Enabling" : "Disabling";
    try {
      await setTailscaleEnabled(enabled);
      await load();
    } catch (error) {
      if (!disposed) body.innerHTML = `<div class="tailscale-callout"><strong>Unable to ${enabled ? "enable" : "disable"} Tailscale</strong><p>${escapeHtml(error instanceof Error ? error.message : "The server rejected the request.")}</p></div>`;
    } finally {
      changing = false;
    }
  };

  void load();
  return () => { disposed = true; window.clearTimeout(timer); };
};
