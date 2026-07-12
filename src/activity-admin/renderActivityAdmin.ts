import { AUDIT_ACTOR_KINDS, AUDIT_EVENT_TYPES, AUDIT_OUTCOMES, listAuditEvents } from "../api/auditApi";
import type { AuditActorKind, AuditEvent, AuditEventType, AuditOutcome } from "../api/auditApi";
import "./activityAdmin.css";

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const title = (value: string) => value.split(".").map((part) => part.replaceAll("_", " ")).join(" · ");
const option = (value: string) => `<option value="${value}">${title(value)}</option>`;
const formatTarget = (event: AuditEvent) => event.target ? `${event.target.type} · ${event.target.id ?? "unknown"}` : "No target";
const formatActor = (event: AuditEvent) => event.actor.principalId
  ? `${event.actor.kind} · ${event.actor.principalId.slice(0, 12)}${event.actor.principalId.length > 12 ? "…" : ""}`
  : event.actor.kind;

const renderEvent = (event: AuditEvent) => `<article class="activity-card" data-outcome="${event.outcome}" data-audit-event-id="${event.id}">
  <div class="activity-card-head"><strong>${escapeHtml(title(event.eventType))}</strong><span>${escapeHtml(event.outcome)}</span></div>
  <div class="activity-card-details">
    <span><small>Actor</small>${escapeHtml(formatActor(event))}</span>
    <span><small>Target</small>${escapeHtml(formatTarget(event))}</span>
    <time datetime="${escapeHtml(event.occurredAt)}"><small>Time</small>${escapeHtml(new Date(event.occurredAt).toLocaleString())}</time>
  </div>
</article>`;

export const renderActivityAdmin = () => `<section class="activity-admin" data-activity-admin data-diagnostic-section="activity" aria-labelledby="activity-title">
  <div class="activity-header">
    <div><h3 id="activity-title">Activity history</h3><p>Bounded, redacted administration and security events.</p></div>
    <button type="button" data-activity-refresh>Refresh</button>
  </div>
  <div class="activity-filters" aria-label="Activity filters">
    <label>Event<select data-activity-event><option value="">All events</option>${AUDIT_EVENT_TYPES.map(option).join("")}</select></label>
    <label>Outcome<select data-activity-outcome><option value="">All outcomes</option>${AUDIT_OUTCOMES.map(option).join("")}</select></label>
    <label>Actor<select data-activity-actor><option value="">All actors</option>${AUDIT_ACTOR_KINDS.map(option).join("")}</select></label>
    <label>Principal ID<input type="search" data-activity-principal maxlength="128" autocomplete="off" placeholder="Exact ID" /></label>
    <label>From<input type="datetime-local" data-activity-from /></label>
    <label>To<input type="datetime-local" data-activity-to /></label>
  </div>
  <p class="activity-status" data-activity-status role="status" aria-live="polite">Loading activity…</p>
  <div class="activity-list" data-activity-list aria-busy="true"></div>
  <button class="activity-more" type="button" data-activity-more hidden>Load more</button>
</section>`;

export const bindActivityAdmin = (container: ParentNode) => {
  const root = container.querySelector<HTMLElement>("[data-activity-admin]");
  if (!root) return () => {};
  const list = root.querySelector<HTMLElement>("[data-activity-list]")!;
  const status = root.querySelector<HTMLElement>("[data-activity-status]")!;
  const more = root.querySelector<HTMLButtonElement>("[data-activity-more]")!;
  let events: AuditEvent[] = [];
  let nextCursor: string | null = null;
  let disposed = false;
  let loading = false;

  const input = <T extends HTMLInputElement | HTMLSelectElement>(selector: string) => root.querySelector<T>(selector)!;
  const filters = () => ({
    actorKind: (input<HTMLSelectElement>("[data-activity-actor]").value || undefined) as AuditActorKind | undefined,
    eventType: (input<HTMLSelectElement>("[data-activity-event]").value || undefined) as AuditEventType | undefined,
    from: input<HTMLInputElement>("[data-activity-from]").value ? new Date(input<HTMLInputElement>("[data-activity-from]").value).toISOString() : undefined,
    outcome: (input<HTMLSelectElement>("[data-activity-outcome]").value || undefined) as AuditOutcome | undefined,
    principalId: input<HTMLInputElement>("[data-activity-principal]").value.trim() || undefined,
    to: input<HTMLInputElement>("[data-activity-to]").value ? new Date(input<HTMLInputElement>("[data-activity-to]").value).toISOString() : undefined
  });
  const draw = () => {
    list.innerHTML = events.length ? events.map(renderEvent).join("") : `<div class="activity-empty">No events match these filters.</div>`;
    list.setAttribute("aria-busy", "false");
    more.hidden = !nextCursor;
  };
  const load = async (append = false) => {
    if (loading || disposed) return;
    loading = true;
    status.textContent = append ? "Loading more activity…" : "Refreshing activity…";
    try {
      const page = await listAuditEvents({ ...filters(), cursor: append ? nextCursor ?? undefined : undefined, limit: 30 });
      if (disposed) return;
      events = append ? [...events, ...page.events] : page.events;
      nextCursor = page.nextCursor;
      draw();
      status.textContent = `${events.length} event${events.length === 1 ? "" : "s"} shown · retained for ${page.retention.retentionDays} days, up to ${page.retention.maxEvents.toLocaleString()}`;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Activity could not be loaded.";
      list.setAttribute("aria-busy", "false");
    } finally { loading = false; }
  };

  root.addEventListener("change", (event) => { if ((event.target as Element).matches("select, input[type='datetime-local']")) void load(); });
  input<HTMLInputElement>("[data-activity-principal]").addEventListener("search", () => void load());
  input<HTMLInputElement>("[data-activity-principal]").addEventListener("keydown", (event) => { if (event.key === "Enter") void load(); });
  root.querySelector("[data-activity-refresh]")?.addEventListener("click", () => void load());
  more.addEventListener("click", () => void load(true));
  void load();
  return () => { disposed = true; };
};
