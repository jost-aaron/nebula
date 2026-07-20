import { getClusterAdmin, updateClusterNode, type ClusterNodeControlUpdate } from "../api/clusterAdminApi";
import type { ClusterAdminNode, ClusterAdminSnapshot } from "../shared/clusterTypes";
import "./clusterAdmin.css";

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const value = (input: number | null) => input === null ? "" : String(input);

export const renderClusterAdmin = () => `
  <section class="cluster-admin diagnostic-section" data-diagnostic-section="cluster" aria-live="polite">
    <div class="cluster-admin-heading">
      <div><p class="eyebrow">Distributed media</p><h3>Cluster</h3><p>Shape where new playback sessions run without changing a node's cryptographic identity.</p></div>
      <button type="button" data-cluster-refresh>Refresh</button>
    </div>
    <div data-cluster-content><p class="cluster-admin-loading">Loading cluster controls…</p></div>
    <span class="cluster-admin-message" data-cluster-message></span>
  </section>`;

const renderNode = (node: ClusterAdminNode) => `
  <form class="cluster-node-card${node.controls.maintenanceDrain ? " is-draining" : ""}" data-cluster-node="${escapeHtml(node.nodeId)}">
    <header>
      <div><span class="cluster-node-state state-${escapeHtml(node.state)}"><i></i>${node.controls.maintenanceDrain ? "Draining" : escapeHtml(node.state)}</span><h4>${escapeHtml(node.name)}</h4><p>${node.local ? "This coordinator" : escapeHtml(node.role)} · ${escapeHtml(node.nodeId)}</p></div>
      <div class="cluster-node-load"><span><strong>${node.load.activeStreams}</strong><small>streams</small></span><span><strong>${node.load.activeTranscodes}</strong><small>transcodes</small></span></div>
    </header>
    <div class="cluster-node-fields">
      <label><span>Display name</span><input name="name" maxlength="64" required value="${escapeHtml(node.name)}"></label>
      <label><span>Scheduling priority</span><input name="priority" type="number" min="-100" max="100" required value="${node.controls.priority}"></label>
      <label><span>Stream capacity</span><input name="maxConcurrentStreams" type="number" min="1" max="100" placeholder="Unlimited" value="${value(node.controls.maxConcurrentStreams)}"></label>
      <label><span>Live transcodes</span><input name="maxConcurrentTranscodes" type="number" min="0" max="32" placeholder="Unlimited" value="${value(node.controls.maxConcurrentTranscodes)}"></label>
    </div>
    <footer>
      <p>${node.controls.maintenanceDrain ? "No new sessions are assigned; active sessions can finish." : "Available for new sessions within the configured limits."}</p>
      <div><button type="button" class="cluster-drain-button" data-cluster-drain="${node.controls.maintenanceDrain ? "false" : "true"}">${node.controls.maintenanceDrain ? "Undrain node" : "Drain for maintenance"}</button><button type="submit">Save controls</button></div>
    </footer>
  </form>`;

const renderSnapshot = (snapshot: ClusterAdminSnapshot) => `
  <div class="cluster-admin-summary">
    <span><small>Cluster</small><strong>${escapeHtml(snapshot.identity.clusterId)}</strong></span>
    <span><small>Nodes</small><strong>${snapshot.nodes.length}</strong></span>
    <span><small>Accepting sessions</small><strong>${snapshot.nodes.filter((node) => node.state === "online" && !node.controls.maintenanceDrain).length}</strong></span>
  </div>
  <div class="cluster-node-list">${snapshot.nodes.map(renderNode).join("")}</div>`;

const nullableNumber = (form: FormData, name: string) => {
  const raw = String(form.get(name) ?? "").trim();
  return raw === "" ? null : Number(raw);
};

export const bindClusterAdmin = (container: ParentNode) => {
  const root = container.querySelector<HTMLElement>(".cluster-admin");
  const content = root?.querySelector<HTMLElement>("[data-cluster-content]");
  const message = root?.querySelector<HTMLElement>("[data-cluster-message]");
  if (!root || !content || !message) return () => {};
  let disposed = false;
  const show = (text: string) => { message.textContent = text; };
  const save = async (nodeId: string, update: ClusterNodeControlUpdate, success: string) => {
    show("Saving cluster controls…");
    try { await updateClusterNode(nodeId, update); await load(); show(success); }
    catch (error) { show(error instanceof Error ? error.message : "Cluster controls could not be saved."); }
  };
  const bindCards = () => {
    root.querySelectorAll<HTMLFormElement>("[data-cluster-node]").forEach((form) => {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const data = new FormData(form);
        void save(form.dataset.clusterNode ?? "", {
          maxConcurrentStreams: nullableNumber(data, "maxConcurrentStreams"),
          maxConcurrentTranscodes: nullableNumber(data, "maxConcurrentTranscodes"),
          name: String(data.get("name") ?? "").trim(),
          priority: Number(data.get("priority"))
        }, "Node controls saved.");
      });
      form.querySelector<HTMLButtonElement>("[data-cluster-drain]")?.addEventListener("click", (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        const draining = button.dataset.clusterDrain === "true";
        void save(form.dataset.clusterNode ?? "", { maintenanceDrain: draining }, draining ? "Node is draining." : "Node is accepting sessions.");
      });
    });
  };
  const load = async () => {
    try {
      const snapshot = await getClusterAdmin();
      if (disposed) return false;
      content.innerHTML = renderSnapshot(snapshot);
      bindCards();
      return true;
    } catch {
      if (!disposed) {
        content.innerHTML = `<p class="cluster-admin-unavailable">Cluster mode is not enabled on this server.</p>`;
        show("");
      }
      return false;
    }
  };
  root.querySelector("[data-cluster-refresh]")?.addEventListener("click", () => {
    show("Refreshing…");
    void load().then((loaded) => { if (loaded) show("Cluster status refreshed."); });
  });
  void load();
  const timer = window.setInterval(() => { if (!root.hidden) void load(); }, 10_000);
  return () => { disposed = true; window.clearInterval(timer); };
};
