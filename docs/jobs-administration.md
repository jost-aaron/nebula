# Background Job Administration

Wave 4 adds a focused, owner-oriented frontend surface for the persistent jobs
domain. The module lives in `src/jobs-admin/`; its typed API client lives in
`src/api/jobsApi.ts`.

## Capabilities

- Lists queued, running, succeeded, failed, and cancelled jobs.
- Shows type, stage, progress, attempt count, last update, and terminal errors.
- Filters by lifecycle state and job type and refreshes explicitly.
- Polls every five seconds while the current result contains active work.
- Enqueues scan, metadata refresh, artwork cache, and cleanup maintenance jobs.
- Requires a second, explicit confirmation before cancellation. Running jobs
  explain that cancellation is cooperative.
- Uses the shared API base URL, account/bearer authentication, CSRF handling,
  and session-expiry behavior through `apiJson`.

Probe jobs are visible and filterable but are not available as a generic manual
action because the backend requires a trusted catalog `sourceId`.

## Integration Request

The integration owner should import `renderJobsAdmin` and `bindJobsAdmin` from
`src/jobs-admin/renderJobsAdmin.ts`, include `renderJobsAdmin()` in the owner-only
Settings content, add a Jobs category button, and bind/dispose the controller
with the Settings surface lifecycle. This branch intentionally does not edit
`src/main.ts`, shared server routing, shared contracts, or broad styles.

The account role must be checked by the integration point; `/api/jobs` remains
server-authorized with `media.manage` as the enforcement boundary.

## Verification

Run TypeScript and Node tests inside Docker. At `390x844`, verify filters and
maintenance commands remain full-width, the two-column enqueue grid does not
overflow, confirmation controls are reachable by keyboard, and the Settings
surface retains its safe-area padding.
