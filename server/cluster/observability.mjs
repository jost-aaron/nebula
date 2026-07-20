const NODE_STATES = Object.freeze(["online", "draining", "offline", "revoked"]);
const DELIVERY_STATES = Object.freeze(["queued", "running", "ready", "failed", "cancelled", "expired"]);
const MAX_COUNT = 1_000_000;

const count = (value) => Math.max(0, Math.min(MAX_COUNT, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0));
const milliseconds = (value) => Math.max(0, Math.min(24 * 60 * 60_000, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0));
const safeArray = (value) => Array.isArray(value) ? value.slice(0, 10_000) : [];
const ageMs = (timestamp, currentTime) => {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.max(0, currentTime - parsed) : null;
};
const blankCounts = (states) => Object.fromEntries(states.map((state) => [state, 0]));
const metric = (name, value) => ({ name, value: count(value) });

export const createClusterOperationsService = ({
  audit = null,
  clockAuditIntervalMs = 5 * 60_000,
  clockSampleLimit = 128,
  deliverySnapshot = () => ({}),
  manifestSnapshot = () => [],
  manifestStaleMs = 15 * 60_000,
  nodesSnapshot = () => [],
  now = () => Date.now(),
  schedulerSnapshot = () => ({})
} = {}) => {
  const boundedClockLimit = Math.max(8, Math.min(1_024, count(clockSampleLimit)));
  const boundedClockAuditIntervalMs = Math.max(10_000, Math.min(60 * 60_000, milliseconds(clockAuditIntervalMs)));
  const boundedStaleMs = Math.max(30_000, milliseconds(manifestStaleMs));
  const clockSamples = [];
  let lastClockAuditAt = null;
  let previousReadiness = null;

  const read = (provider, fallback) => {
    try { return { failed: false, value: provider() }; }
    catch { return { failed: true, value: fallback }; }
  };

  const nodeSummary = (input) => {
    const states = blankCounts(NODE_STATES);
    for (const node of safeArray(input)) {
      const state = NODE_STATES.includes(node?.state) ? node.state : "offline";
      states[state] += 1;
    }
    return { paired: states.online + states.draining + states.offline, states };
  };

  const manifestSummary = (input, currentTime) => {
    const result = { aging: 0, fresh: 0, missing: 0, stale: 0, total: 0 };
    let oldestAgeMs = 0;
    for (const entry of safeArray(input)) {
      result.total += 1;
      const age = ageMs(entry?.lastCompleteAt ?? entry?.lastSyncAt, currentTime);
      if (age === null) result.missing += 1;
      else {
        oldestAgeMs = Math.max(oldestAgeMs, age);
        if (age >= boundedStaleMs) result.stale += 1;
        else if (age >= boundedStaleMs / 2) result.aging += 1;
        else result.fresh += 1;
      }
    }
    return { ...result, oldestAgeBucket: oldestAgeMs >= boundedStaleMs * 4 ? "4x-stale" : oldestAgeMs >= boundedStaleMs ? "stale" : oldestAgeMs >= boundedStaleMs / 2 ? "aging" : "fresh" };
  };

  const schedulerSummary = (input) => ({
    activeNodes: count(input?.activeNodes),
    activeSessions: count(input?.activeSessions ?? input?.sessionCount),
    cooldowns: count(input?.cooldowns),
    cooldownMaxRemainingBucket: milliseconds(input?.cooldownMaxRemainingMs) > 60_000 ? "over-60s"
      : milliseconds(input?.cooldownMaxRemainingMs) > 10_000 ? "10-60s" : milliseconds(input?.cooldownMaxRemainingMs) > 0 ? "under-10s" : "none"
  });

  const deliverySummary = (input) => {
    const states = blankCounts(DELIVERY_STATES);
    for (const state of DELIVERY_STATES) states[state] = count(input?.states?.[state] ?? input?.[state]);
    return { active: count(input?.active ?? states.queued + states.running + states.ready), states };
  };

  const clockSummary = () => {
    const buckets = { "under-1s": 0, "1-10s": 0, "10-60s": 0, "over-60s": 0 };
    let accepted = 0;
    let rejected = 0;
    for (const sample of clockSamples) {
      buckets[sample.bucket] += 1;
      if (sample.accepted) accepted += 1; else rejected += 1;
    }
    return { accepted, buckets, rejected, samples: clockSamples.length, status: rejected ? "rejected" : buckets["10-60s"] || buckets["over-60s"] ? "warning" : "ok" };
  };

  const collect = () => {
    const currentTime = Number(now());
    const nodesInput = read(nodesSnapshot, []);
    const manifestsInput = read(manifestSnapshot, []);
    const schedulerInput = read(schedulerSnapshot, {});
    const deliveryInput = read(deliverySnapshot, {});
    const nodes = nodeSummary(nodesInput.value);
    const manifests = manifestSummary(manifestsInput.value, currentTime);
    const scheduler = schedulerSummary(schedulerInput.value);
    const delivery = deliverySummary(deliveryInput.value);
    const clock = clockSummary();
    const reasons = [];
    if (nodesInput.failed || manifestsInput.failed || schedulerInput.failed || deliveryInput.failed) reasons.push("OBSERVABILITY_INPUT_UNAVAILABLE");
    if (nodes.paired > 0 && nodes.states.online + nodes.states.draining === 0) reasons.push("NO_AVAILABLE_NODES");
    else if (nodes.states.offline > 0) reasons.push("NODE_UNAVAILABLE");
    if (manifests.missing > 0 || manifests.stale > 0) reasons.push("MANIFEST_STALE");
    else if (manifests.aging > 0) reasons.push("MANIFEST_AGING");
    if (delivery.states.failed > 0) reasons.push("DELIVERY_FAILURES");
    if (clock.status === "rejected") reasons.push("CLOCK_SKEW_REJECTED");
    else if (clock.status === "warning") reasons.push("CLOCK_SKEW_WARNING");
    const hardFailure = reasons.includes("OBSERVABILITY_INPUT_UNAVAILABLE") || reasons.includes("NO_AVAILABLE_NODES");
    const status = hardFailure ? "not-ready" : reasons.length ? "degraded" : "ready";
    return {
      checkedAt: new Date(Number.isFinite(currentTime) ? currentTime : 0).toISOString(),
      clock, delivery, manifests, nodes, reasons, scheduler, status
    };
  };

  const auditReadiness = (readiness) => {
    if (readiness.status === previousReadiness) return;
    if (previousReadiness !== null || readiness.status !== "ready") {
      const reason = readiness.status === "ready" ? "cluster-ready" : readiness.status === "degraded" ? "cluster-degraded" : "cluster-not-ready";
      audit?.recordBestEffort?.({ actor: { kind: "system" }, eventType: "cluster.readiness_changed", metadata: { reason }, outcome: readiness.status === "ready" ? "success" : "failure" });
    }
    previousReadiness = readiness.status;
  };

  const readiness = () => {
    const result = collect();
    auditReadiness(result);
    return result;
  };

  return {
    metrics() {
      const snapshot = readiness();
      return {
        generatedAt: snapshot.checkedAt,
        samples: [
          metric("nebula_cluster_ready", snapshot.status === "ready" ? 1 : 0),
          metric("nebula_cluster_degraded", snapshot.status === "degraded" ? 1 : 0),
          metric("nebula_cluster_not_ready", snapshot.status === "not-ready" ? 1 : 0),
          ...NODE_STATES.map((state) => metric(`nebula_cluster_nodes_${state}`, snapshot.nodes.states[state])),
          metric("nebula_cluster_manifests_fresh", snapshot.manifests.fresh),
          metric("nebula_cluster_manifests_aging", snapshot.manifests.aging),
          metric("nebula_cluster_manifests_stale", snapshot.manifests.stale),
          metric("nebula_cluster_manifests_missing", snapshot.manifests.missing),
          metric("nebula_cluster_scheduler_active_sessions", snapshot.scheduler.activeSessions),
          metric("nebula_cluster_scheduler_active_nodes", snapshot.scheduler.activeNodes),
          metric("nebula_cluster_scheduler_cooldowns", snapshot.scheduler.cooldowns),
          ...DELIVERY_STATES.map((state) => metric(`nebula_cluster_deliveries_${state}`, snapshot.delivery.states[state])),
          metric("nebula_cluster_clock_samples_accepted", snapshot.clock.accepted),
          metric("nebula_cluster_clock_samples_rejected", snapshot.clock.rejected)
        ]
      };
    },
    readiness,
    recordClockSkew({ accepted, skewMs } = {}) {
      const absolute = Math.min(24 * 60 * 60_000, Math.abs(Number(skewMs) || 0));
      const bucket = absolute >= 60_000 ? "over-60s" : absolute >= 10_000 ? "10-60s" : absolute >= 1_000 ? "1-10s" : "under-1s";
      const sample = { accepted: accepted === true, bucket };
      clockSamples.push(sample);
      while (clockSamples.length > boundedClockLimit) clockSamples.shift();
      const observedTime = Number(now());
      const currentTime = Number.isFinite(observedTime) ? observedTime : 0;
      if (!sample.accepted && (lastClockAuditAt === null || currentTime - lastClockAuditAt >= boundedClockAuditIntervalMs)) {
        audit?.recordBestEffort?.({ actor: { kind: "system" }, eventType: "cluster.clock_skew_detected", metadata: { reason: "clock-skew" }, outcome: "failure" });
        lastClockAuditAt = currentTime;
      }
      return sample;
    }
  };
};
