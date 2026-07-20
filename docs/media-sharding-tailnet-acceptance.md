# Media Sharding Tailnet Acceptance

This record tracks operator evidence for the real-tailnet exit criteria in
`media-sharding-implementation-plan.md`. Automated and generated-fixture tests
remain the authoritative repeatable coverage; this document records only what
was observed on an enrolled tailnet.

## 2026-07-19 Single-Node Pass

Environment:

- current `main` at `ea53992`;
- one Nebula server enrolled as `nebula.tail024251.ts.net`;
- Tailscale Serve in userspace mode, proxying private HTTPS `/` to
  `http://127.0.0.1:5173`;
- persistent account and Tailscale state retained across a dashboard and
  sidecar rebuild;
- cluster mode disabled, so this was not a multi-shard acceptance run.

Passed:

- the dashboard and sidecar rebuilt independently and returned healthy;
- `tailscale serve status --json` reported HTTPS on port 443 and
  `AllowFunnel: false`;
- an unauthenticated tailnet request reached Nebula and received the expected
  account-gate `401` response;
- a `capacitor://localhost` API preflight returned `204`, credential support,
  and the expected methods and headers;
- the existing owner browser session restored over private HTTPS;
- `tailscale ping` first observed `DERP(sea)` and then upgraded to a direct LAN
  path in the same run;
- Cinema loaded the real local title over the tailnet URL, created an HTTPS
  delivery session, reached `readyState 4`, advanced continuously, and buffered
  ahead;
- the player seek control moved playback forward by approximately 10 seconds
  and playback remained healthy;
- no bearer value, media ticket, or grant ID was detected in the dashboard and
  sidecar logs or rendered HTML during the pass;
- Studio loaded its authenticated library over the tailnet URL; the active data
  volume had no audio fixture, so streaming could not be exercised;
- Docker verification passed TypeScript and all 391 tests, and the host tree
  remained free of `node_modules` and `dist`.

Still required for MVP acceptance:

- repeat on at least one coordinator and two disposable paired shards with
  cluster mode enabled;
- verify one deduplicated item backed by byte-identical replicas and keep a
  different encode distinct;
- exercise remote Cinema and Studio original, remux, HLS/transcode, fixed
  quality, subtitle, history, and resume paths;
- distribute simultaneous sessions, terminate the selected shard, and measure
  exact-fingerprint failover and resume drift;
- confirm offline, draining, cooldown, revoked, and permission-denied nodes
  receive no new sessions;
- force a sustained DERP playback path, not only the observed DERP bootstrap,
  and compare throughput with the direct path;
- verify a Grant-denied tailnet device and a device outside the tailnet cannot
  connect;
- complete rolling restart, interrupted key rotation, and backup/restore checks
  against the disposable paired nodes.

Do not promote the cluster feature as real-tailnet production-ready until the
remaining paired-node checks are recorded here. The standalone deployment is
not blocked by those checks.
