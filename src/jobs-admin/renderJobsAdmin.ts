import { cancelJob, enqueueJob, JOB_STATES, JOB_TYPES, listJobs } from "../api/jobsApi";
import type { BackgroundJob, JobState, JobType } from "../api/jobsApi";
import "./jobsAdmin.css";

const MAINTENANCE_JOBS: ReadonlyArray<{ type: JobType; label: string }> = [
  { type: "scan", label: "Scan library" },
  { type: "metadata", label: "Refresh metadata" },
  { type: "artwork", label: "Cache artwork" },
  { type: "cleanup", label: "Run cleanup" }
];
const ACTIVE_STATES = new Set<JobState>(["queued", "running"]);
const timeValue = (value: string) => new Date(value).getTime() || 0;
const newestFirst = (left: BackgroundJob, right: BackgroundJob) => timeValue(right.updatedAt) - timeValue(left.updatedAt);
const queueOrder = (left: BackgroundJob, right: BackgroundJob) => {
  if (left.state === "running" && right.state !== "running") return -1;
  if (right.state === "running" && left.state !== "running") return 1;
  return timeValue(left.availableAt) - timeValue(right.availableAt) || timeValue(left.createdAt) - timeValue(right.createdAt);
};

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const percent = (value: number) => Math.round(Math.min(1, Math.max(0, value || 0)) * 100);
const relativeTime = (value: string) => {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "Unknown time";
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString();
};

const renderJob = (job: BackgroundJob, confirmingId: string | null) => {
  const progress = percent(job.progress);
  const cancelRequested = Boolean(job.cancelRequestedAt);
  const renditionProfile = job.type === "rendition" && typeof job.payload.profileId === "string" ? ` · ${escapeHtml(job.payload.profileId)}` : "";
  return `<article class="jobs-admin-card" data-state="${job.state}" data-job-id="${job.id}">
    <div class="jobs-admin-card-header">
      <span class="jobs-admin-title"><strong>${escapeHtml(job.type)} job${renditionProfile}</strong><code>${escapeHtml(job.id.slice(0, 8))}</code></span>
      <span class="jobs-admin-state">${escapeHtml(job.state)}</span>
    </div>
    <div class="jobs-admin-card-meta">
      <span>${escapeHtml(job.currentStage ?? "Waiting")}</span><span>${progress}%</span>
      <span>Attempt ${job.attempt}/${job.maxAttempts}</span><span title="${escapeHtml(job.updatedAt)}">${relativeTime(job.updatedAt)}</span>
    </div>
    <div class="jobs-admin-progress" role="progressbar" aria-label="${escapeHtml(job.type)} job progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><i style="--job-progress:${progress}%"></i></div>
    ${job.error ? `<p class="jobs-admin-error"><strong>${escapeHtml(job.error.code ?? "Job failed")}:</strong> ${escapeHtml(job.error.message)}</p>` : ""}
    ${job.type === "probe" && job.state === "failed" ? `<div><button type="button" data-jobs-retry-probe="${job.id}">Re-probe file</button></div>` : ""}
    ${ACTIVE_STATES.has(job.state) ? confirmingId === job.id
      ? `<div class="jobs-admin-confirm" role="group" aria-label="Confirm cancellation"><span>${job.state === "running" ? "Running work stops at its next cancellation checkpoint." : "This queued job will not run."}</span><button type="button" data-jobs-confirm-cancel="${job.id}">Confirm cancel</button><button type="button" data-jobs-keep>Keep job</button></div>`
      : `<div><button class="jobs-admin-cancel" type="button" data-jobs-request-cancel="${job.id}" ${cancelRequested ? "disabled" : ""}>${cancelRequested ? "Cancellation requested" : "Cancel job"}</button></div>` : ""}
  </article>`;
};

export const renderJobsAdmin = () => `<section class="jobs-admin" data-jobs-admin data-diagnostic-section="jobs" aria-labelledby="jobs-admin-title">
  <div class="jobs-admin-header">
    <div class="jobs-admin-copy"><h3 id="jobs-admin-title">Background jobs</h3><p>Owner operations for media maintenance and processing.</p></div>
    <div class="jobs-admin-actions"><button type="button" data-jobs-refresh>Refresh</button></div>
  </div>
  <div class="jobs-admin-enqueue" aria-label="Enqueue maintenance job">
    ${MAINTENANCE_JOBS.map(({ type, label }) => `<button type="button" data-jobs-enqueue="${type}">${label}</button>`).join("")}
  </div>
  <div class="jobs-admin-filters">
    <label>State<select data-jobs-state><option value="">All states</option>${JOB_STATES.map((state) => `<option value="${state}">${state}</option>`).join("")}</select></label>
    <label>Type<select data-jobs-type><option value="">All types</option>${JOB_TYPES.map((type) => `<option value="${type}">${type}</option>`).join("")}</select></label>
  </div>
  <p class="jobs-admin-status" data-jobs-status role="status" aria-live="polite">Loading jobs…</p>
  <div class="jobs-admin-list" data-jobs-list aria-busy="true"></div>
</section>`;

export const bindJobsAdmin = (container: ParentNode) => {
  const root = container.querySelector<HTMLElement>("[data-jobs-admin]");
  if (!root) return () => {};
  const list = root.querySelector<HTMLElement>("[data-jobs-list]")!;
  const status = root.querySelector<HTMLElement>("[data-jobs-status]")!;
  const stateFilter = root.querySelector<HTMLSelectElement>("[data-jobs-state]")!;
  const typeFilter = root.querySelector<HTMLSelectElement>("[data-jobs-type]")!;
  let jobs: BackgroundJob[] = [];
  let confirmingId: string | null = null;
  let disposed = false;
  let loading = false;

  const draw = () => {
    const latestSucceeded = [...jobs].filter((job) => job.state === "succeeded").sort(newestFirst)[0] ?? null;
    const active = jobs.filter((job) => ACTIVE_STATES.has(job.state)).sort(queueOrder);
    const focusedIds = new Set([latestSucceeded?.id, ...active.map((job) => job.id)].filter(Boolean));
    const history = jobs.filter((job) => !focusedIds.has(job.id)).sort(newestFirst);
    const focused = [...(latestSucceeded ? [latestSucceeded] : []), ...active];
    list.innerHTML = jobs.length ? `
      <section class="jobs-admin-group" aria-labelledby="jobs-admin-now">
        <div class="jobs-admin-group-heading"><strong id="jobs-admin-now">Now</strong><span>${active.length} active</span></div>
        <div class="jobs-admin-group-list">${focused.length ? focused.map((job) => renderJob(job, confirmingId)).join("") : `<div class="jobs-admin-empty">No active or recently completed jobs.</div>`}</div>
      </section>
      <details class="jobs-admin-history"${stateFilter.value ? " open" : ""}>
        <summary>History <span>${history.length}</span></summary>
        <div class="jobs-admin-group-list">${history.length ? history.map((job) => renderJob(job, confirmingId)).join("") : `<div class="jobs-admin-empty">No older jobs.</div>`}</div>
      </details>` : `<div class="jobs-admin-empty">No jobs match these filters.</div>`;
    list.setAttribute("aria-busy", "false");
  };
  const load = async (announce = true) => {
    if (loading || disposed) return;
    loading = true;
    if (announce) status.textContent = "Refreshing jobs…";
    try {
      const result = await listJobs({ limit: 100, state: (stateFilter.value || undefined) as JobState | undefined, type: (typeFilter.value || undefined) as JobType | undefined });
      if (disposed) return;
      jobs = result.jobs;
      confirmingId = jobs.some((job) => job.id === confirmingId) ? confirmingId : null;
      draw();
      status.textContent = `${jobs.length} job${jobs.length === 1 ? "" : "s"} · Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Jobs could not be loaded.";
      list.setAttribute("aria-busy", "false");
    } finally { loading = false; }
  };
  const setBusy = (busy: boolean) => root.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = busy || button.textContent === "Cancellation requested"; });

  root.addEventListener("change", (event) => {
    if ((event.target as Element).matches("[data-jobs-state], [data-jobs-type]")) void load();
  });
  root.addEventListener("click", async (event) => {
    const target = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!target) return;
    if (target.matches("[data-jobs-refresh]")) { void load(); return; }
    if (target.matches("[data-jobs-keep]")) { confirmingId = null; draw(); return; }
    const requestId = target.dataset.jobsRequestCancel;
    if (requestId) { confirmingId = requestId; draw(); list.querySelector<HTMLButtonElement>(`[data-jobs-confirm-cancel="${requestId}"]`)?.focus(); return; }
    try {
      const type = target.dataset.jobsEnqueue as JobType | undefined;
      const cancelId = target.dataset.jobsConfirmCancel;
      const retryProbeId = target.dataset.jobsRetryProbe;
      if (!type && !cancelId && !retryProbeId) return;
      setBusy(true);
      if (type) {
        const result = await enqueueJob({ type, payload: {}, dedupeKey: `manual:${type}` });
        status.textContent = result.created ? `${type} job queued.` : `${type} job is already active.`;
      } else if (retryProbeId) {
        const failedProbe = jobs.find((job) => job.id === retryProbeId && job.type === "probe");
        if (!failedProbe) throw new Error("The failed probe is no longer available.");
        const result = await enqueueJob({ type: "probe", payload: failedProbe.payload, dedupeKey: failedProbe.dedupeKey ?? undefined, maxAttempts: 1 });
        status.textContent = result.created ? "File queued for re-probe." : "A probe for this file is already active.";
      } else if (cancelId) {
        await cancelJob(cancelId);
        confirmingId = null;
        status.textContent = "Cancellation requested.";
      }
      await load(false);
    } catch (error) { status.textContent = error instanceof Error ? error.message : "The operation failed."; }
    finally { if (!disposed) setBusy(false); }
  });

  void load();
  const timer = window.setInterval(() => { if (jobs.some((job) => ACTIVE_STATES.has(job.state))) void load(false); }, 5_000);
  return () => { disposed = true; window.clearInterval(timer); };
};
