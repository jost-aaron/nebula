import { cancelAllJobs, cancelJob, enqueueJob, JOB_STATES, JOB_TYPES, listJobs } from "../api/jobsApi";
import type { BackgroundJob, JobsSummary, JobState, JobType } from "../api/jobsApi";
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
const queueOrder = (left: BackgroundJob, right: BackgroundJob) =>
  timeValue(left.availableAt) - timeValue(right.availableAt) || timeValue(left.createdAt) - timeValue(right.createdAt);
const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const percent = (value: number) => Math.round(Math.min(1, Math.max(0, value || 0)) * 100);
const stateLabel = (state: JobState) => state === "succeeded" ? "Completed" : `${state.slice(0, 1).toUpperCase()}${state.slice(1)}`;
const typeLabel = (type: JobType) => `${type.slice(0, 1).toUpperCase()}${type.slice(1)}`;
const relativeTime = (value: string) => {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "Unknown time";
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString();
};
const jobSubject = (job: BackgroundJob) => {
  for (const key of ["title", "name", "path", "sourcePath", "contentPath", "folder", "sourceId", "itemId"]) {
    const value = job.payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return job.dedupeKey ?? "";
};

const renderJob = (job: BackgroundJob, confirmingId: string | null, queuePosition: number | null = null, canManage = true) => {
  const progress = percent(job.progress);
  const cancelRequested = Boolean(job.cancelRequestedAt);
  const renditionProfile = job.type === "rendition" && typeof job.payload.profileId === "string" ? ` · ${escapeHtml(job.payload.profileId)}` : "";
  const subject = jobSubject(job);
  return `<article class="jobs-admin-card" data-state="${job.state}" data-job-id="${job.id}">
    <div class="jobs-admin-card-header">
      <span class="jobs-admin-title">
        <strong>${escapeHtml(typeLabel(job.type))} job${renditionProfile}</strong>
        ${subject ? `<span title="${escapeHtml(subject)}">${escapeHtml(subject)}</span>` : ""}
        <code>${escapeHtml(job.id.slice(0, 8))}</code>
      </span>
      <span class="jobs-admin-state">${escapeHtml(stateLabel(job.state))}</span>
    </div>
    <div class="jobs-admin-card-meta">
      ${queuePosition === null ? "" : `<span class="jobs-admin-queue-position">Queue #${queuePosition}</span>`}
      <span>${escapeHtml(job.currentStage ?? "Waiting")}</span><span>${progress}%</span>
      <span>Attempt ${job.attempt}/${job.maxAttempts}</span><span title="${escapeHtml(job.updatedAt)}">${relativeTime(job.updatedAt)}</span>
    </div>
    <div class="jobs-admin-progress" role="progressbar" aria-label="${escapeHtml(job.type)} job progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><i style="--job-progress:${progress}%"></i></div>
    ${job.error ? `<p class="jobs-admin-error"><strong>${escapeHtml(job.error.code ?? "Job failed")}:</strong> ${escapeHtml(job.error.message)}</p>` : ""}
    ${canManage && job.type === "probe" && job.state === "failed" ? `<div><button type="button" data-jobs-retry-probe="${job.id}">Re-probe file</button></div>` : ""}
    ${canManage && ACTIVE_STATES.has(job.state) ? confirmingId === job.id
      ? `<div class="jobs-admin-confirm" role="group" aria-label="Confirm cancellation"><span>${job.state === "running" ? "Running work stops at its next cancellation checkpoint." : "This queued job will not run."}</span><button type="button" data-jobs-confirm-cancel="${job.id}">Confirm cancel</button><button type="button" data-jobs-keep>Keep job</button></div>`
      : `<div><button class="jobs-admin-cancel" type="button" data-jobs-request-cancel="${job.id}" ${cancelRequested ? "disabled" : ""}>${cancelRequested ? "Cancellation requested" : "Cancel job"}</button></div>` : ""}
  </article>`;
};

export const renderJobsAdmin = ({ canManage = true }: { canManage?: boolean } = {}) => `<section class="jobs-admin" data-jobs-admin data-jobs-can-manage="${canManage}" data-diagnostic-section="jobs" aria-labelledby="jobs-admin-title">
  <div class="jobs-admin-header">
    <div class="jobs-admin-copy"><h3 id="jobs-admin-title">Background jobs</h3><p>Search, monitor, and control every media-processing queue.</p></div>
    <div class="jobs-admin-actions"><button type="button" data-jobs-refresh>Refresh</button>${canManage ? `<button class="jobs-admin-cancel-all" type="button" data-jobs-cancel-all>Cancel all jobs</button>` : ""}</div>
  </div>
  ${canManage ? `<div class="jobs-admin-enqueue" aria-label="Enqueue maintenance job">
    ${MAINTENANCE_JOBS.map(({ type, label }) => `<button type="button" data-jobs-enqueue="${type}">${label}</button>`).join("")}
  </div>` : `<p class="jobs-admin-read-only">Job monitoring is read-only for this session.</p>`}
  <div class="jobs-admin-summary" data-jobs-summary aria-label="Job state totals">
    ${JOB_STATES.map((state) => `<button type="button" data-jobs-summary-state="${state}" data-state="${state}" aria-pressed="false"><span>${stateLabel(state)}</span><strong>—</strong></button>`).join("")}
  </div>
  <div class="jobs-admin-filters" role="search">
    <label class="jobs-admin-search">Search jobs<input type="search" data-jobs-search placeholder="Title, path, stage, error, or job ID" autocomplete="off" /></label>
    <label>State<select data-jobs-state><option value="">All states</option>${JOB_STATES.map((state) => `<option value="${state}">${stateLabel(state)}</option>`).join("")}</select></label>
    <label>Type<select data-jobs-type><option value="">All types</option>${JOB_TYPES.map((type) => `<option value="${type}">${typeLabel(type)}</option>`).join("")}</select></label>
    <button type="button" data-jobs-clear-filters>Clear filters</button>
  </div>
  <p class="jobs-admin-status" data-jobs-status role="status" aria-live="polite">Loading jobs…</p>
  <div class="jobs-admin-list" data-jobs-list aria-busy="true"></div>
  <button class="jobs-admin-load-more" type="button" data-jobs-load-more hidden>Load older jobs</button>
</section>`;

export const bindJobsAdmin = (container: ParentNode) => {
  const root = container.querySelector<HTMLElement>("[data-jobs-admin]");
  if (!root) return () => {};
  const list = root.querySelector<HTMLElement>("[data-jobs-list]")!;
  const status = root.querySelector<HTMLElement>("[data-jobs-status]")!;
  const stateFilter = root.querySelector<HTMLSelectElement>("[data-jobs-state]")!;
  const typeFilter = root.querySelector<HTMLSelectElement>("[data-jobs-type]")!;
  const searchInput = root.querySelector<HTMLInputElement>("[data-jobs-search]")!;
  const summaryRoot = root.querySelector<HTMLElement>("[data-jobs-summary]")!;
  const loadMoreButton = root.querySelector<HTMLButtonElement>("[data-jobs-load-more]")!;
  const cancelAllButton = root.querySelector<HTMLButtonElement>("[data-jobs-cancel-all]");
  const canManage = root.dataset.jobsCanManage === "true";
  searchInput.value = "";
  let jobs: BackgroundJob[] = [];
  let summary: JobsSummary = { counts: {}, total: 0, typeCounts: {} };
  let total = 0;
  let confirmingId: string | null = null;
  let disposed = false;
  let loading = false;
  let searchTimer = 0;

  const draw = () => {
    const latestSucceeded = [...jobs].filter((job) => job.state === "succeeded").sort(newestFirst)[0] ?? null;
    const running = jobs.filter((job) => job.state === "running").sort(queueOrder);
    const queued = jobs.filter((job) => job.state === "queued").sort(queueOrder);
    const focusedIds = new Set([latestSucceeded?.id, ...running.map((job) => job.id), ...queued.map((job) => job.id)].filter(Boolean));
    const history = jobs.filter((job) => !focusedIds.has(job.id)).sort(newestFirst);
    list.innerHTML = jobs.length ? `
      ${latestSucceeded ? `<section class="jobs-admin-group jobs-admin-receipt" aria-labelledby="jobs-admin-completed"><div class="jobs-admin-group-heading"><strong id="jobs-admin-completed">Just completed</strong><span>Latest success</span></div><div class="jobs-admin-group-list">${renderJob(latestSucceeded, confirmingId, null, canManage)}</div></section>` : ""}
      <section class="jobs-admin-group" aria-labelledby="jobs-admin-running">
        <div class="jobs-admin-group-heading"><strong id="jobs-admin-running">Running now</strong><span>${summary.counts.running ?? running.length} running</span></div>
        <div class="jobs-admin-group-list">${running.length ? running.map((job) => renderJob(job, confirmingId, null, canManage)).join("") : `<div class="jobs-admin-empty jobs-admin-empty-compact">No jobs are running.</div>`}</div>
      </section>
      <section class="jobs-admin-group" aria-labelledby="jobs-admin-queue">
        <div class="jobs-admin-group-heading"><strong id="jobs-admin-queue">Queue</strong><span>${summary.counts.queued ?? queued.length} queued</span></div>
        <div class="jobs-admin-group-list">${queued.length ? queued.map((job, index) => renderJob(job, confirmingId, index + 1, canManage)).join("") : `<div class="jobs-admin-empty jobs-admin-empty-compact">The queue is clear.</div>`}</div>
      </section>
      <details class="jobs-admin-history"${stateFilter.value || typeFilter.value || searchInput.value ? " open" : ""}>
        <summary>Recent history <span>${history.length}</span></summary>
        <div class="jobs-admin-group-list">${history.length ? history.map((job) => renderJob(job, confirmingId, null, canManage)).join("") : `<div class="jobs-admin-empty">No older jobs.</div>`}</div>
      </details>` : `<div class="jobs-admin-empty">No jobs match these filters.</div>`;
    for (const state of JOB_STATES) {
      const button = summaryRoot.querySelector<HTMLButtonElement>(`[data-jobs-summary-state="${state}"]`);
      if (!button) continue;
      button.querySelector("strong")!.textContent = String(summary.counts[state] ?? 0);
      button.classList.toggle("active", stateFilter.value === state);
      button.setAttribute("aria-pressed", stateFilter.value === state ? "true" : "false");
    }
    loadMoreButton.hidden = jobs.length >= total;
    loadMoreButton.textContent = `Load older jobs (${Math.max(0, total - jobs.length)} remaining)`;
    list.setAttribute("aria-busy", "false");
  };

  const load = async (announce = true, append = false) => {
    if (loading || disposed) return;
    loading = true;
    if (announce) status.textContent = append ? "Loading older jobs…" : "Refreshing jobs…";
    try {
      const result = await listJobs({
        limit: 100,
        offset: append ? jobs.length : 0,
        query: searchInput.value.trim() || undefined,
        state: (stateFilter.value || undefined) as JobState | undefined,
        type: (typeFilter.value || undefined) as JobType | undefined
      });
      if (disposed) return;
      jobs = append ? [...jobs, ...result.jobs.filter((job) => !jobs.some((current) => current.id === job.id))] : result.jobs;
      summary = result.summary;
      total = result.total;
      if (cancelAllButton) cancelAllButton.disabled = (summary.counts.queued ?? 0) + (summary.counts.running ?? 0) === 0;
      confirmingId = jobs.some((job) => job.id === confirmingId) ? confirmingId : null;
      draw();
      status.textContent = `Showing ${jobs.length} of ${total} matching · ${summary.counts.running ?? 0} running · ${summary.counts.queued ?? 0} queued · Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Jobs could not be loaded.";
      list.setAttribute("aria-busy", "false");
    } finally { loading = false; }
  };
  const setBusy = (busy: boolean) => root.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = busy || button.textContent === "Cancellation requested";
  });

  root.addEventListener("change", (event) => {
    if ((event.target as Element).matches("[data-jobs-state], [data-jobs-type]")) void load();
  });
  root.addEventListener("input", (event) => {
    if (!(event.target as Element).matches("[data-jobs-search]")) return;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void load(), 250);
  });
  root.addEventListener("click", async (event) => {
    const target = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!target) return;
    if (target.matches("[data-jobs-refresh]")) { void load(); return; }
    if (target.matches("[data-jobs-load-more]")) { void load(true, true); return; }
    if (target.matches("[data-jobs-clear-filters]")) {
      stateFilter.value = "";
      typeFilter.value = "";
      searchInput.value = "";
      void load();
      searchInput.focus();
      return;
    }
    const summaryState = target.dataset.jobsSummaryState as JobState | undefined;
    if (summaryState) {
      stateFilter.value = stateFilter.value === summaryState ? "" : summaryState;
      void load();
      return;
    }
    if (target.matches("[data-jobs-cancel-all]")) {
      if (target.dataset.confirm !== "true") {
        target.dataset.confirm = "true";
        target.textContent = "Confirm cancel all";
        status.textContent = "Press again to cancel every queued and running job.";
        return;
      }
      try {
        setBusy(true);
        const result = await cancelAllJobs();
        target.dataset.confirm = "false";
        target.textContent = "Cancel all jobs";
        status.textContent = result.total ? `Cancellation requested for ${result.total} job${result.total === 1 ? "" : "s"}.` : "There are no active jobs to cancel.";
        await load(false);
      } catch (error) { status.textContent = error instanceof Error ? error.message : "Jobs could not be cancelled."; }
      finally { if (!disposed) setBusy(false); }
      return;
    }
    if (target.matches("[data-jobs-keep]")) { confirmingId = null; draw(); return; }
    const requestId = target.dataset.jobsRequestCancel;
    if (requestId) {
      confirmingId = requestId;
      draw();
      list.querySelector<HTMLButtonElement>(`[data-jobs-confirm-cancel="${requestId}"]`)?.focus();
      return;
    }
    try {
      const type = target.dataset.jobsEnqueue as JobType | undefined;
      const cancelId = target.dataset.jobsConfirmCancel;
      const retryProbeId = target.dataset.jobsRetryProbe;
      if (!type && !cancelId && !retryProbeId) return;
      setBusy(true);
      if (type) {
        const result = await enqueueJob({ type, payload: {}, dedupeKey: `manual:${type}` });
        status.textContent = result.created ? `${typeLabel(type)} job queued.` : `${typeLabel(type)} job is already active.`;
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
  const timer = window.setInterval(() => {
    if ((summary.counts.queued ?? 0) + (summary.counts.running ?? 0) > 0) void load(false);
  }, 5_000);
  return () => {
    disposed = true;
    window.clearInterval(timer);
    window.clearTimeout(searchTimer);
  };
};
