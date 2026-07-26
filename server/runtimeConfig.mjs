const integer = (env, name, fallback, { min, max }) => {
  const raw = String(env[name] ?? "").trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
};

const boolean = (env, name, fallback) => {
  const raw = String(env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw !== "true" && raw !== "false") throw new Error(`${name} must be true or false.`);
  return raw === "true";
};

export const readRuntimeConfig = (env = process.env) => ({
  auditMaxEvents: integer(env, "NEBULA_AUDIT_MAX_EVENTS", 10_000, { min: 100, max: 1_000_000 }),
  auditRetentionDays: integer(env, "NEBULA_AUDIT_RETENTION_DAYS", 90, { min: 1, max: 3_650 }),
  externalHttps: boolean(env, "NEBULA_EXTERNAL_HTTPS", false),
  host: String(env.HOST ?? "0.0.0.0").trim() || "0.0.0.0",
  jobConcurrency: integer(env, "NEBULA_MEDIA_JOB_CONCURRENCY", 1, { min: 1, max: 2 }),
  jobHistoryDays: integer(env, "NEBULA_JOB_HISTORY_DAYS", 30, { min: 1, max: 3_650 }),
  jobHistoryRetain: integer(env, "NEBULA_JOB_HISTORY_RETAIN", 1_000, { min: 0, max: 100_000 }),
  startupScanDelayMs: integer(env, "NEBULA_STARTUP_SCAN_DELAY_MS", 120_000, { min: 0, max: 600_000 }),
  port: integer(env, "PORT", 5173, { min: 1, max: 65_535 }),
  production: String(env.NODE_ENV ?? "").trim() === "production"
});
