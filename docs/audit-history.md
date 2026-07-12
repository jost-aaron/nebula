# Structured Activity And Audit History

Nebula persists bounded, redacted operational history in the shared
`nebula.sqlite` database. The domain lives under `server/audit/`; its schema is
registered centrally after Jobs as `audit-v1`.

## Data contract

Each event has a stable event type, actor kind and principal ID, optional actor
role, optional target type and ID, UTC timestamp, outcome, and a small metadata
object. Event types cover owner setup, login/logout, profile/password/member and
session administration, server-setting changes, authorization denial, manual
catalog scans, job enqueue/cancel actions, and backup creation/inspection.

Metadata is an allowlist, not a generic logging payload. The service redacts on
both write and read. Passwords, credentials, tokens, cookies, CSRF values,
authorization headers, raw error text, media paths, filenames, and backup paths
are never accepted as metadata or returned by the API. Target IDs reject paths
and media filenames. Audit failures are swallowed by `recordBestEffort()` and
cannot change the result of the primary operation.

Default retention is 90 days and 10,000 events. Operators may set
`NEBULA_AUDIT_RETENTION_DAYS` and `NEBULA_AUDIT_MAX_EVENTS`; both are clamped to
safe bounds. Age and count pruning run after successful writes.

## API and UI

`GET /api/admin/audit` is limited to owners and service admins. Members receive
`403`. It supports cursor pagination plus `eventType`, `outcome`, `actorKind`,
`principalId`, `from`, `to`, and bounded `limit` filters.

Owner Settings includes an Activity category with the same filters, refresh,
retention summary, responsive event cards, and Load more pagination. Members do
not receive the category or render/bind its controller. At 390×844 the filter
and card grids collapse to one column without changing global safe-area rules.

The SQLite backup flow captures the audit table automatically with the shared
database. Existing backups remain inspectable because `audit_events` is not a
required legacy-backup validation table.
