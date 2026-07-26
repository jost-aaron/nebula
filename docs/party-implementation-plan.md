# Nebula Party Implementation Plan

## Product scope

Party is a private messaging application for enabled accounts on one Nebula
server. It provides canonical direct messages, owner/admin-managed groups,
per-account unread state, message history, attachment delivery, and fast local
updates. It does not federate, contact an external service, or claim Signal
Protocol compatibility.

## V1 privacy model

- Nebula account authentication and conversation membership are the security
  boundary. Only enabled local accounts may use Party.
- Message text, membership metadata, read positions, filenames, MIME types, and
  attachment metadata are stored in the shared Nebula SQLite database.
- Attachment bytes are stored beneath the server-owned Nebula data root, never
  in the shared Files/content namespace.
- The server can read all Party content. Party is not end-to-end encrypted.
  Existing deployments do not have database or attachment encryption at rest;
  operators must protect the data volume, backups, host, and live sessions.
- TLS or private Tailscale Serve is required to protect traffic outside a
  trusted development host. Party does not weaken Nebula's cookie/CSRF, bearer
  session, CORS, or account-disable behavior.
- Audit events cover group/member administration but deliberately exclude
  message bodies, filenames, attachment hashes, and other message content.
- Typing indicators, presence, voice/video, federation, message editing, and
  disappearing messages are outside v1. Read state is represented only as a
  per-user conversation position.

## Server architecture

`server/party/` owns one centrally ordered domain migration, repository/service
logic, attachment storage, event subscriptions, and HTTP routes.

The schema uses UUID identities and strict foreign keys:

- `party_conversations`: direct/group kind, canonical direct key, bounded group
  title/avatar metadata, creator, and timestamps.
- `party_conversation_members`: account membership, owner/admin/member role,
  join time, and last-read sequence.
- `party_messages`: per-conversation monotonically increasing sequence, sender,
  bounded UTF-8 text, client idempotency key, and timestamp.
- `party_attachments`: message/uploader ownership, server-generated storage key,
  sanitized display name, detected MIME, size, digest, and timestamp.

Canonical DMs use a unique sorted user-id pair key and an immediate transaction,
so concurrent requests return the same conversation. Messages allocate their
sequence and update the conversation timestamp in the same transaction. Queries
use `(conversation_id, sequence)` indexes, bounded limits, and keyset cursors.
Unread counts compare each membership's last-read sequence with message
sequences from other senders.

The route surface is under `/api/party` and always requires the new
`party.use` capability plus an enabled account context. Service tokens and
guests have no Party identity and are rejected by the Party service even if a
broader route guard is present.

Authenticated fetch-stream SSE at `/api/party/events` publishes only opaque
conversation-change hints to current members. No message content is carried in
the event payload. The browser resynchronizes through normal bounded APIs,
reconnects with capped exponential backoff, and also refreshes on window focus
or network recovery. Heartbeats and subscriber counts are bounded.

## Attachment lifecycle and controls

Uploads use a raw streaming request so the browser can report progress and
cancel with `XMLHttpRequest.abort()`. Controls include:

- required, bounded `Content-Length` and a 25 MiB default per-file limit;
- a conservative allowlist for images, video, audio, PDF, text, archives, and
  general binary files;
- extension/name sanitization for display only, generated storage keys, and
  containment checks under `data/party-attachments`;
- server-side signature detection for common active/media formats, with
  declared/detected MIME mismatch rejection;
- write-to-random-temporary, streaming SHA-256, no-clobber atomic publication,
  and cleanup on abort or failure;
- membership reauthorization for upload, preview, HEAD, download, and every
  byte-range request;
- `nosniff`, safe content disposition, single-range parsing, and inline display
  only for a conservative image/audio/video/PDF allowlist;
- per-conversation attachment quota and transactionally linked message rows.

V1 uploads become attachment-only messages when publication succeeds, avoiding
orphan drafts. Safe browser-native image/audio/video previews are used; SVG and
HTML are always downloads. Deleting accounts/conversations is not a v1 product
operation, so referenced blobs have no normal destructive lifecycle yet. A
startup cleanup removes stale temporary files; a documented reconciliation
path covers unreferenced blobs.

## Frontend architecture

`src/party/` owns Party markup, state, rendering, controller bindings, upload
state, SSE reconnection, and teardown. `src/api/partyApi.ts` and
`src/shared/partyTypes.ts` keep transport and contracts out of the view.

The full-screen responsive surface has:

- searchable, deterministically ordered conversation navigation with unread
  badges and last-message previews;
- direct-user discovery and group creation/member management;
- a chronological, keyset-paginated message timeline;
- a multiline composer with Enter-to-send and Shift+Enter newline behavior;
- upload progress/cancel/failure UI and safe attachment cards/previews;
- loading, empty, error, offline, and reconnecting states;
- accessible labels, live regions, focus restoration, minimum touch targets,
  and a mobile conversation-list/detail transition.

Party is marked ready in the dashboard registry and is lazy-loaded from the app
surface to keep the existing initial bundle split.

## Backup, restore, retention, and operations

The Party tables are added to backup schema validation. Party attachment files
are copied into versioned backup bundles with checksums and restored
no-clobber beneath the staged data root. Backups therefore contain private
message content and must continue to be protected as secrets.

The first release keeps message history and linked attachments until an operator
restores or replaces the data set; no automatic message retention is implied.
Temporary upload cleanup is bounded and safe at startup. Readiness remains
database/data-root based and Party does not add an external dependency.

## Test plan

- Migration idempotency, constraints, preservation, and backup validation.
- Direct-message deduplication including concurrent-style repeated requests.
- Group permissions, member changes, disabled/non-member denial, and user
  discovery minimization.
- Message idempotency, ordering, pagination, unread/read isolation, bounded
  bodies, safe rendering contracts, and conversation ordering.
- Attachment size/type/signature/name validation, abort cleanup, quota,
  membership IDOR denial, range/HEAD/download behavior, and backup/restore.
- SSE membership scoping, heartbeat/teardown, client reconnect/backoff, and
  refresh behavior.
- TypeScript/static UI contracts plus Playwright owner/member messaging,
  upload/download, desktop/mobile layout, keyboard behavior, and reconnect
  state on a unique Compose project and free port.

## Workstream ownership

1. Backend/data/realtime: `server/party/schema.mjs`, repository/service/events
   modules, and focused backend tests.
2. Frontend/UX: `src/party/`, Party API/types, Party CSS, and focused UI tests.
3. Attachments/media/security: Party attachment module and focused attachment
   tests; report shared backup/storage integration needs.
4. Testing/operations: Party docs, Playwright scenario/fixtures, deployment and
   testing documentation changes; report shared route/main integration needs.

The primary integration owner retains `server/dev.mjs`, `server/api.mjs`,
`server/auth.mjs`, `src/main.ts`, `src/apps.ts`, shared backup/audit files, and
final merge/review responsibility.
