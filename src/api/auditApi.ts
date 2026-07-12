import { apiJson } from "./http";

export const AUDIT_EVENT_TYPES = [
  "account.owner_setup", "account.login", "account.logout", "account.profile_updated",
  "account.password_changed", "account.member_created", "account.member_status_changed",
  "account.session_revoked", "account.server_setting_changed", "auth.access_denied",
  "catalog.scan_requested", "job.enqueued", "job.cancel_requested", "backup.created", "backup.inspected"
] as const;
export const AUDIT_OUTCOMES = ["success", "failure", "denied"] as const;
export const AUDIT_ACTOR_KINDS = ["account", "service", "system", "anonymous"] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export interface AuditEvent {
  actor: { kind: AuditActorKind; principalId: string | null; role: string | null };
  eventType: AuditEventType;
  id: string;
  metadata: Record<string, boolean | string>;
  occurredAt: string;
  outcome: AuditOutcome;
  target: { id: string | null; type: string } | null;
}

export interface AuditPage {
  events: AuditEvent[];
  nextCursor: string | null;
  retention: { maxEvents: number; retentionDays: number };
}

export interface AuditFilters {
  actorKind?: AuditActorKind;
  cursor?: string;
  eventType?: AuditEventType;
  from?: string;
  limit?: number;
  outcome?: AuditOutcome;
  principalId?: string;
  to?: string;
}

export const listAuditEvents = (filters: AuditFilters = {}) => {
  const query = new URLSearchParams();
  query.set("limit", String(filters.limit ?? 30));
  for (const key of ["actorKind", "cursor", "eventType", "from", "outcome", "principalId", "to"] as const) {
    if (filters[key]) query.set(key, String(filters[key]));
  }
  return apiJson<AuditPage>(`/api/admin/audit?${query.toString()}`);
};
