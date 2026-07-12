import { randomUUID } from "node:crypto";

export const AUDIT_EVENT_TYPES = Object.freeze([
  "account.owner_setup", "account.login", "account.logout", "account.profile_updated",
  "account.password_changed", "account.member_created", "account.member_status_changed",
  "account.session_revoked", "account.server_setting_changed", "auth.access_denied",
  "catalog.scan_requested", "job.enqueued", "job.cancel_requested",
  "backup.created", "backup.inspected"
]);

export const AUDIT_OUTCOMES = Object.freeze(["success", "failure", "denied"]);
export const AUDIT_ACTOR_KINDS = Object.freeze(["account", "service", "system", "anonymous"]);

const EVENT_TYPES = new Set(AUDIT_EVENT_TYPES);
const OUTCOMES = new Set(AUDIT_OUTCOMES);
const ACTOR_KINDS = new Set(AUDIT_ACTOR_KINDS);
const METADATA_KEYS = new Set([
  "clientType", "disabled", "jobType", "setting", "transport", "created", "requestedBy"
]);
const METADATA_VALUES = new Set(["browser", "native", "cookie", "bearer", "tmdb", "manual", "startup", "scan", "probe", "metadata", "artwork", "cleanup"]);
const bounded = (value, max) => value === null || value === undefined ? null : String(value).slice(0, max);
const iso = (value) => new Date(value).toISOString();
const safeTargetId = (value) => {
  const result = bounded(value, 160);
  if (!result || /[\\/\u0000-\u001f]/u.test(result) || /\.(?:aac|avi|flac|m4a|mkv|mov|mp3|mp4|ogg|wav|webm)$/iu.test(result)) return null;
  return result;
};

const sanitizeMetadata = (metadata) => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const safe = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!METADATA_KEYS.has(key)) continue;
    if (typeof value === "boolean") safe[key] = value;
    else if (typeof value === "string" && METADATA_VALUES.has(value)) safe[key] = value;
  }
  return safe;
};

const parseSafeMetadata = (value) => {
  try { return sanitizeMetadata(JSON.parse(value)); } catch { return {}; }
};

const fromRow = (row) => row ? ({
  actor: { kind: row.actor_kind, principalId: row.principal_id, role: row.actor_role },
  eventType: row.event_type,
  id: row.id,
  metadata: parseSafeMetadata(row.metadata_json),
  occurredAt: row.occurred_at,
  outcome: row.outcome,
  target: row.target_type ? { id: safeTargetId(row.target_id), type: row.target_type } : null
}) : null;

const encodeCursor = (row) => Buffer.from(JSON.stringify([row.occurred_at, row.id]), "utf8").toString("base64url");
const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string") throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error("Invalid audit cursor."), { status: 400, expose: true });
  }
};

const parseDate = (value, label) => {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw Object.assign(new Error(`Invalid audit ${label}.`), { status: 400, expose: true });
  return new Date(timestamp).toISOString();
};

export const actorFromContext = (context) => ({
  kind: context?.kind === "account" ? "account" : context?.kind === "service" ? "service" : "anonymous",
  principalId: context?.principalId ?? null,
  role: context?.user?.role ?? (context?.kind === "service" ? "service-admin" : null)
});

export const createAuditService = ({ db, maxEvents = 10_000, now = () => Date.now(), retentionDays = 90, uuid = randomUUID } = {}) => {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A SQLite database is required.");
  const boundedMaxEvents = Math.max(100, Math.min(100_000, Number(maxEvents) || 10_000));
  const boundedRetentionDays = Math.max(1, Math.min(3650, Number(retentionDays) || 90));

  const prune = () => {
    const cutoff = new Date(Number(now()) - boundedRetentionDays * 86_400_000).toISOString();
    db.prepare("DELETE FROM audit_events WHERE occurred_at < ?").run(cutoff);
    db.prepare(`DELETE FROM audit_events WHERE id IN (
      SELECT id FROM audit_events ORDER BY occurred_at DESC, id DESC LIMIT -1 OFFSET ?
    )`).run(boundedMaxEvents);
  };

  const record = (event) => {
    if (!event || !EVENT_TYPES.has(event.eventType)) throw new TypeError("Unsupported audit event type.");
    if (!OUTCOMES.has(event.outcome)) throw new TypeError("Unsupported audit outcome.");
    const actorKind = ACTOR_KINDS.has(event.actor?.kind) ? event.actor.kind : "system";
    const occurredAt = iso(event.occurredAt ?? now());
    const metadata = JSON.stringify(sanitizeMetadata(event.metadata));
    db.prepare(`INSERT INTO audit_events
      (id, event_type, actor_kind, principal_id, actor_role, target_type, target_id, occurred_at, outcome, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      uuid(), event.eventType, actorKind, bounded(event.actor?.principalId, 128), bounded(event.actor?.role, 32),
      bounded(event.target?.type, 64), safeTargetId(event.target?.id), occurredAt, event.outcome, metadata
    );
    prune();
    return true;
  };

  const recordBestEffort = (event) => {
    try { return record(event); } catch { return false; }
  };

  const list = ({ actorKind = null, cursor = null, eventType = null, from = null, limit = 50, outcome = null, principalId = null, to = null } = {}) => {
    if (eventType && !EVENT_TYPES.has(eventType)) throw Object.assign(new Error("Invalid audit event type."), { status: 400, expose: true });
    if (outcome && !OUTCOMES.has(outcome)) throw Object.assign(new Error("Invalid audit outcome."), { status: 400, expose: true });
    if (actorKind && !ACTOR_KINDS.has(actorKind)) throw Object.assign(new Error("Invalid audit actor kind."), { status: 400, expose: true });
    const decoded = decodeCursor(cursor);
    const pageSize = Math.max(1, Math.min(100, Number(limit) || 50));
    const rows = db.prepare(`SELECT * FROM audit_events
      WHERE (? IS NULL OR event_type = ?)
        AND (? IS NULL OR outcome = ?)
        AND (? IS NULL OR actor_kind = ?)
        AND (? IS NULL OR principal_id = ?)
        AND (? IS NULL OR occurred_at >= ?)
        AND (? IS NULL OR occurred_at <= ?)
        AND (? IS NULL OR occurred_at < ? OR (occurred_at = ? AND id < ?))
      ORDER BY occurred_at DESC, id DESC LIMIT ?`).all(
        eventType, eventType, outcome, outcome, actorKind, actorKind,
        bounded(principalId, 128), bounded(principalId, 128),
        parseDate(from, "from date"), parseDate(from, "from date"),
        parseDate(to, "to date"), parseDate(to, "to date"),
        decoded?.[0] ?? null, decoded?.[0] ?? null, decoded?.[0] ?? null, decoded?.[1] ?? null,
        pageSize + 1
      );
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    return {
      events: page.map(fromRow),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
      retention: { maxEvents: boundedMaxEvents, retentionDays: boundedRetentionDays }
    };
  };

  return { list, prune, record, recordBestEffort };
};
