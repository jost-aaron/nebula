# Nebula Party

Party is Nebula's private, single-server messaging application. Enabled local
accounts can exchange direct messages, create groups, and share attachments
without an external messaging or storage service. Party is integrated with the
dashboard account/session model and is intended for people who already trust the
operator of the same Nebula server.

Party is **not Signal Protocol compatible and is not end-to-end encrypted**.
The Nebula server can read message text, membership, read positions, filenames,
attachment metadata, and attachment bytes. Protect the host, data volume,
backups, live sessions, and transport accordingly.

## Product behavior

- Direct conversations are canonical: the same two accounts always resolve to
  one conversation, regardless of who starts it.
- Groups have a title, optional image attachment as an avatar, and up to 100
  members. The creator is the immutable owner. Owners can appoint
  administrators; administrators can update group details and manage ordinary
  members.
- Conversation lists are ordered by latest activity with a stable UUID
  tiebreaker. Search matches bounded group titles and the other members'
  display names or usernames.
- Messages have a per-conversation monotonic sequence, client idempotency key,
  bounded multiline text, and chronological keyset pagination.
- Read positions and unread counts are per account. A user's own messages do
  not count as unread.
- An authenticated Server-Sent Events stream carries only an opaque
  conversation-change hint. The client reloads authorized data through the
  normal API and reconnects with capped backoff.
- The responsive view provides desktop list/thread columns and a single-pane
  mobile flow with explicit Back navigation. Enter sends; Shift+Enter inserts a
  newline; Escape closes Party dialogs or the app surface.

Typing indicators, presence, per-message read receipts, message editing,
deletion, reactions, voice/video calls, disappearing messages, federation, and
external push notifications are not part of version one.

## Identity and authorization

`party.use` is granted to enabled owner and member account sessions. It is not
granted to guests. Party additionally requires `request.nebulaAuth.kind` to be
`account`; legacy service tokens, localhost service administration, media
tickets, and guest sessions fail closed because they have no Party user
identity.

The service checks current conversation membership before listing a
conversation, reading or sending messages, changing read state, uploading, and
serving every attachment request or byte range. Non-members receive a
not-found result at object lookup boundaries so conversation and attachment IDs
cannot be used as an account-discovery oracle. Disabling an account invalidates
its sessions through the account layer and excludes it from new Party user
discovery.

Only the minimum discovery projection leaves the server:

```json
{ "id": "account-uuid", "username": "member-name", "displayName": "Member Name" }
```

Passwords, credentials, session data, preferences, last-login metadata,
disabled accounts, and unrelated authorization policy are never included.
Group/member audit events contain actor and conversation IDs only. Message
bodies, titles, usernames, filenames, digests, and attachment content are not
written to audit history.

Cookie-authenticated mutations continue to require Nebula's
`X-Nebula-CSRF` header. Native account bearer sessions do not use CSRF. CORS is
still API-only and exact-origin allowlisted. Rendered message text and filenames
are escaped; Party never treats them as HTML.

## Persistence and ordering

The centrally tracked `party-v1` domain migration creates strict tables in the
shared `nebula.sqlite` database:

- `party_conversations`
- `party_conversation_members`
- `party_messages`
- `party_attachments`

IDs are server-generated UUIDs. A unique sorted account-pair key deduplicates
direct conversations inside an immediate transaction. The same transaction
allocates a message sequence, links any attachment metadata, rechecks the
conversation attachment quota, and updates conversation activity. Indexed
queries use bounded limits and `(conversation_id, sequence)` keysets instead of
unbounded offsets.

Message text is limited to 8,000 characters and 16 KiB of UTF-8. Conversation
and message page limits are capped at 100. Group titles are limited to 100
characters. The UI currently caps groups at 100 members.

## HTTP API

All routes are beneath `/api/party`, require an enabled account, use JSON unless
noted, and return only membership-authorized resources.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/users?q=&limit=` | Search enabled accounts using the minimal projection. |
| `POST` | `/direct` | Resolve or create a canonical DM from `{userId}`. |
| `POST` | `/groups` | Create a group from `{title, memberIds}`. |
| `GET` | `/conversations?q=&limit=&cursor=` | List the caller's conversations using an opaque keyset cursor. |
| `GET` / `PATCH` | `/conversations/:id` | Read details or change a managed group's title/avatar. |
| `POST` | `/conversations/:id/members` | Add a group member. |
| `PATCH` / `DELETE` | `/conversations/:id/members/:userId` | Change a role or remove/leave membership. |
| `GET` / `POST` | `/conversations/:id/messages` | Page messages by `beforeSequence`, or send `{text, clientId}`. |
| `POST` | `/conversations/:id/read` | Advance the caller's read position with `{sequence}`. |
| `GET` | `/events` | Authenticated `text/event-stream` change hints and heartbeats. |
| `POST` | `/conversations/:id/attachments?clientId=` | Raw, length-bounded file upload. |
| `GET` / `HEAD` | `/attachments/:id` | Authorized inline/download response with single-range support. |

Upload requests send the original display name URL-encoded in
`X-Nebula-File-Name`, a conservative declared `Content-Type`, and an exact
`Content-Length`. Successful uploads create attachment-only messages; there is
no client-visible draft storage identity.

The SSE stream emits:

```text
event: ready
data: {}

event: conversation
data: {"conversationId":"..."}
```

No body, sender, filename, unread count, or membership data appears in an SSE
frame. Membership is rechecked when each hint is published. Each connection is
bound to the account session that opened it; session expiry and the injected
account-session validator are checked on publish and heartbeat. Account
disable/revocation integrations can also close all streams for one user or
session immediately.

## Attachment safety and lifecycle

Attachment bytes live under
`$NEBULA_DATA_ROOT/party-attachments/<shard>/<shard>/<uuid>.blob`, separate
from the Files app's shared `content/` namespace. Caller filenames are display
metadata only; storage keys are generated, path-contained, and never accepted
from HTTP clients.

Version-one defaults are 25 MiB per file, 250 MiB per conversation, 2 GiB per
uploader account, and 10 GiB across the server. The latter three are configurable
with `NEBULA_PARTY_CONVERSATION_ATTACHMENT_BYTES`,
`NEBULA_PARTY_USER_ATTACHMENT_BYTES`, and
`NEBULA_PARTY_GLOBAL_ATTACHMENT_BYTES`. Quotas are rechecked in the same
transaction that publishes attachment metadata, so concurrent uploads cannot
over-admit storage. The server:

- requires a non-chunked, positive `Content-Length`;
- accepts a conservative image, video, audio, PDF, text, archive, and binary
  MIME allowlist;
- rejects HTML, SVG, script/XML, executable signatures, declared/detected type
  mismatches, malformed UTF-8 text, and oversized bodies;
- streams to a random mode-restricted temporary file while hashing SHA-256;
- publishes without clobbering, reauthorizes membership, then commits message
  and metadata transactionally;
- removes temporary or newly published bytes on abort, validation failure,
  authorization failure, quota failure, or database failure;
- serves only regular contained files, with `nosniff`, a sanitized content
  disposition, no-store caching, and one RFC byte range;
- permits inline rendering only for conservative browser-native images,
  audio/video, and sandboxed PDF. Other allowed types download.

Startup and periodic maintenance remove only bounded, stale generated files
from `party-attachments/.tmp`. Permanent conversation deletion and retention
first queue every referenced storage key in `party_attachment_cleanup` in the
same database transaction that removes its message metadata. The filesystem
cleanup is retried in bounded maintenance batches, so a transient unlink
failure cannot silently lose the deletion obligation. Operators must not delete
database rows or attachment files by hand.

## Privacy and threat boundary

Party protects against cross-account access in the application layer; it does
not protect against the Nebula operator, root access to the host, database or
backup disclosure, a compromised server process, or a compromised signed-in
browser. Existing deployments do not encrypt the database or Party attachment
tree at rest. Use encrypted host storage where required and treat every backup
bundle as private message data.

Use HTTPS for any traffic beyond trusted localhost. Private Tailscale Serve is
the preferred existing remote-access path. A plain LAN deployment exposes
messages and attachments to anyone able to observe that network path even
though account authentication still applies.

Party does not send content to an external messaging, identity, notification,
thumbnail, or media-processing provider. Attachment previews are browser-native.

## Backup, restore, retention, and capacity

Online Nebula backups contain a consistent copy of all Party tables and every
database-referenced attachment blob. The manifest records each attachment as a
`party-attachment` file with size and SHA-256. Inspection rejects missing,
extra, unsafe, or modified Party attachment entries. Offline no-clobber restore
publishes both the database and attachment tree into a new staged data root.

Consequently, unlike Cinema/Files media, Party attachment bytes **are included**
in Nebula backup bundles. Protect, transport, retain, and destroy those bundles
as secrets. Verify enough free capacity for live attachments plus versioned
backups. Attachment admission has layered per-conversation, per-uploader, and
server-wide quotas; operators should set them below actual free space because
backup copies require additional capacity.

By default Party retains message history, membership state, read positions, and
linked attachments indefinitely. Members can download a bounded, paginated JSON
export of any conversation they can currently read; attachment entries contain
member-authorized download paths rather than embedding binary data.

A group owner can permanently delete the shared group for every member. Either
participant can permanently delete a direct conversation for both
participants. The UI states this shared, irreversible scope and the API requires
the exact conversation id as an explicit confirmation value. These actions are
audited without titles or message contents.

Automatic message retention is opt-in. Set `NEBULA_PARTY_RETENTION_DAYS` to a
positive number only after communicating the shared-history policy to users.
`NEBULA_PARTY_MAINTENANCE_INTERVAL_MINUTES` (default 60) and
`NEBULA_PARTY_MAINTENANCE_BATCH_SIZE` (default 250, maximum 1,000) bound each
pass. A value of `0` retention days disables automatic expiry. Retention deletes
messages older than the cutoff and queues their attachment blobs for durable
cleanup; it does not delete conversation membership or account records. Nebula
does not provide legal holds or per-message selective deletion.

Use the staged restore runbook in [deployment.md](deployment.md). A recovery
check is incomplete until an owner and member can open Party history and
download a restored attachment from the disposable restored instance.

## Verification

Focused backend and attachment suites:

```sh
docker compose run --rm dashboard node --test tests/server-party*.test.mjs
```

The tests cover migration idempotency/constraints, direct deduplication, minimal
discovery, group permissions/audit redaction, message idempotency and ordering,
pagination, unread isolation, member-only export, deletion authorization and
confirmation, bounded retention, durable attachment cleanup, IDOR denial, SSE
scoping/session-revocation teardown, raw upload
validation, quota enforcement, cleanup, traversal defense, authorized
GET/HEAD/range serving, and API contracts.

Run the browser vertical slice in an isolated test stack:

```sh
./scripts/test-e2e.sh --project=owner --grep "Party"
```

The scenario uses the setup project's owner/member storage states, creates a
canonical DM, exchanges messages in both directions, uploads and downloads a
real text fixture, and checks mobile navigation, overflow, and Escape close.

Before release, also run the TypeScript check, complete Node suite, complete
Playwright suite, and a staged backup/restore rehearsal. Do not run acceptance
against the normal port 5173 deployment or normal data/content volumes.
