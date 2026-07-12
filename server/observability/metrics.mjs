const HELP = Object.freeze({
  nebula_component_ready: "Whether a bounded Nebula component is ready.",
  nebula_disk_free_bytes: "Free bytes on a bounded Nebula storage class.",
  nebula_disk_total_bytes: "Total bytes on a bounded Nebula storage class.",
  nebula_jobs_active: "Currently active background jobs.",
  nebula_jobs_worker_heartbeat_age_seconds: "Age of the jobs worker heartbeat.",
  nebula_catalog_failed_scans: "Catalog roots whose latest scan failed.",
  nebula_catalog_pending_probes: "Catalog probe jobs pending or running.",
  nebula_catalog_scanning_roots: "Catalog roots currently scanning.",
  nebula_process_uptime_seconds: "Nebula server process uptime."
});

const COMPONENTS = new Set(["database", "content_root", "jobs_worker", "catalog", "content_disk", "cache_disk"]);
const family = (name, samples) => samples.length
  ? `# HELP ${name} ${HELP[name]}\n# TYPE ${name} gauge\n${samples.map(({ labels = "", value }) => `${name}${labels} ${value}`).join("\n")}\n`
  : "";
const label = (key, value) => `{${key}="${value}"}`;

export const renderPrometheusMetrics = ({ readiness, uptimeSeconds }) => {
  const samples = Object.fromEntries(Object.keys(HELP).map((name) => [name, []]));
  samples.nebula_process_uptime_seconds.push({ value: uptimeSeconds });
  for (const component of readiness.components) {
    if (!COMPONENTS.has(component.name)) continue;
    samples.nebula_component_ready.push({ labels: label("component", component.name), value: component.ready ? 1 : 0 });
    const values = component.measurements;
    if (component.name === "jobs_worker") {
      if (values.active !== undefined) samples.nebula_jobs_active.push({ value: values.active });
      if (values.heartbeatAgeSeconds !== undefined) samples.nebula_jobs_worker_heartbeat_age_seconds.push({ value: values.heartbeatAgeSeconds });
    } else if (component.name === "catalog") {
      if (values.failedScans !== undefined) samples.nebula_catalog_failed_scans.push({ value: values.failedScans });
      if (values.pendingProbes !== undefined) samples.nebula_catalog_pending_probes.push({ value: values.pendingProbes });
      if (values.scanningRoots !== undefined) samples.nebula_catalog_scanning_roots.push({ value: values.scanningRoots });
    } else if (component.name === "content_disk" || component.name === "cache_disk") {
      const storage = component.name === "content_disk" ? "content" : "cache";
      if (values.freeBytes !== undefined) samples.nebula_disk_free_bytes.push({ labels: label("storage", storage), value: values.freeBytes });
      if (values.totalBytes !== undefined) samples.nebula_disk_total_bytes.push({ labels: label("storage", storage), value: values.totalBytes });
    }
  }
  return Object.keys(HELP).map((name) => family(name, samples[name])).join("");
};

const METRIC_BACKENDS = new Set(["software", "vaapi", "nvenc", "videotoolbox"]);
const METRIC_OUTCOMES = new Set(["success", "failure", "fallback"]);
export const renderTranscodeAccelerationMetrics = (status = {}) => {
  const lines = ["# HELP nebula_transcode_active Active bounded transcode jobs.", "# TYPE nebula_transcode_active gauge"];
  lines.push(`nebula_transcode_active{backend="hardware"} ${Math.max(0, Number(status.active?.hardware) || 0)}`);
  lines.push(`nebula_transcode_active{backend="software"} ${Math.max(0, Number(status.active?.software) || 0)}`);
  lines.push("# HELP nebula_transcode_outcomes_total Bounded transcode outcomes.", "# TYPE nebula_transcode_outcomes_total counter");
  for (const item of Array.isArray(status.outcomes) ? status.outcomes : []) {
    if (!METRIC_BACKENDS.has(item.backend) || !METRIC_OUTCOMES.has(item.outcome)) continue;
    lines.push(`nebula_transcode_outcomes_total{backend="${item.backend}",outcome="${item.outcome}"} ${Math.max(0, Number(item.count) || 0)}`);
  }
  return `${lines.join("\n")}\n`;
};
