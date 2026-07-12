import { access, constants, statfs } from "node:fs/promises";

const result = (name, ready, reason = ready ? "ok" : "unavailable", measurements = {}) => ({
  measurements,
  name,
  ready,
  reason
});

export const createDatabaseCheck = ({ database }) => async () => {
  try {
    database.prepare("SELECT 1 AS healthy").get();
    return result("database", true);
  } catch {
    return result("database", false, "query_failed");
  }
};

export const createDirectoryCheck = ({ name, directory }) => async () => {
  try {
    await access(directory, constants.R_OK | constants.W_OK);
    return result(name, true);
  } catch {
    return result(name, false, "inaccessible");
  }
};

export const createWorkerCheck = ({ snapshot, now = () => Date.now(), staleAfterMs = 30_000 }) => async () => {
  try {
    const state = await snapshot();
    if (!state?.running) return result("jobs_worker", false, "stopped", { active: 0 });
    const heartbeatAgeMs = Math.max(0, now() - Number(state.heartbeatAt));
    return result("jobs_worker", heartbeatAgeMs <= staleAfterMs, heartbeatAgeMs <= staleAfterMs ? "ok" : "stale", {
      active: Math.max(0, Number(state.active) || 0),
      heartbeatAgeSeconds: heartbeatAgeMs / 1000
    });
  } catch {
    return result("jobs_worker", false, "snapshot_failed");
  }
};

export const createCatalogCheck = ({ snapshot, now = () => Date.now(), staleAfterMs = 24 * 60 * 60 * 1000 }) => async () => {
  try {
    const state = await snapshot();
    const failed = Math.max(0, Number(state?.failedScans) || 0);
    const scanning = Math.max(0, Number(state?.scanningRoots) || 0);
    const pendingProbes = Math.max(0, Number(state?.pendingProbes) || 0);
    const lastCompletedAt = state?.lastCompletedAt == null ? null : Number(state.lastCompletedAt);
    const stale = lastCompletedAt !== null && now() - lastCompletedAt > staleAfterMs;
    const ready = failed === 0 && !stale;
    return result("catalog", ready, failed ? "scan_failed" : stale ? "scan_stale" : "ok", {
      failedScans: failed,
      pendingProbes,
      scanningRoots: scanning
    });
  } catch {
    return result("catalog", false, "snapshot_failed");
  }
};

export const createDiskCheck = ({ name, directory, minimumFreeBytes = 1024 ** 3, stat = statfs }) => async () => {
  try {
    const info = await stat(directory);
    const freeBytes = Number(info.bavail) * Number(info.bsize);
    const totalBytes = Number(info.blocks) * Number(info.bsize);
    const ready = Number.isFinite(freeBytes) && freeBytes >= minimumFreeBytes;
    return result(name, ready, ready ? "ok" : "low_space", { freeBytes, totalBytes });
  } catch {
    return result(name, false, "stat_failed");
  }
};

