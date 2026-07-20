const ALLOWED_REASONS = new Set([
  "ok", "unavailable", "query_failed", "inaccessible", "stopped", "stale", "snapshot_failed",
  "scan_failed", "scan_stale", "low_space", "stat_failed", "check_failed",
  "cluster_degraded", "cluster_unavailable"
]);

const finiteMeasurements = (measurements) => Object.fromEntries(Object.entries(measurements ?? {})
  .filter(([key, value]) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(key) && Number.isFinite(value))
  .map(([key, value]) => [key, Number(value)]));

const normalize = (check, value) => ({
  measurements: finiteMeasurements(value?.measurements),
  name: check.name,
  ready: value?.ready === true,
  reason: ALLOWED_REASONS.has(value?.reason) ? value.reason : value?.ready === true ? "ok" : "unavailable"
});

export const createObservabilityService = ({ checks = [], now = () => Date.now(), startedAt = now() } = {}) => {
  if (!Array.isArray(checks) || checks.some((entry) => !entry || !/^[a-z][a-z0-9_]*$/.test(entry.name) || typeof entry.run !== "function")) {
    throw new TypeError("Observability checks require bounded names and run functions.");
  }
  if (new Set(checks.map((entry) => entry.name)).size !== checks.length) throw new TypeError("Observability check names must be unique.");

  const readiness = async () => {
    const components = await Promise.all(checks.map(async (check) => {
      try { return normalize(check, await check.run()); }
      catch { return normalize(check, { ready: false, reason: "check_failed" }); }
    }));
    return { checkedAt: new Date(now()).toISOString(), components, ready: components.every((component) => component.ready) };
  };

  const liveness = () => ({ live: true });
  const uptimeSeconds = () => Math.max(0, (now() - startedAt) / 1000);
  return { liveness, readiness, uptimeSeconds };
};
