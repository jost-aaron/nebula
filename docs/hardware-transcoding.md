# Hardware Transcoding Foundations

Nebula optionally selects a hardware H.264 encoder after playback planning and
policy admission. The default is `software-only`; ordinary development and
deployment require no GPU, host package, or runtime change.

## Configuration

`NEBULA_TRANSCODE_ACCELERATION` accepts `disabled`, `software-only`, `auto`,
and `prefer-` or `require-` forms for `vaapi`, `nvenc`, and `videotoolbox`.
Prefer modes fall back to software. Require modes fail session creation with
`required_backend_unavailable`. Owner/service-admin callers can read, update
for the running process, or refresh detection with `GET`, `PUT`, and `POST`
at `/api/admin/transcode-acceleration`. Runtime changes are not persisted;
restart returns to the environment-authored configuration.

The server parses `ffmpeg -encoders`, checks required device availability, and
runs a bounded one-frame synthetic transcode with argument arrays and
`shell:false`. Results are cached for five minutes. Availability is true only
after the real self-test succeeds inside the running container. Probe failure
never blocks startup or software mode.

Selection is server-authored. Clients cannot supply encoders, devices, filters,
presets, or arguments. Bitrate ceilings, AAC behavior, subtitle burn-in, HLS
segmentation, cancellation, timeouts, output limits, cache isolation, and
cleanup are shared. A preferred hardware execution failure cleans partial
output and gets at most one software retry. Required mode, cancellation,
timeout, segment-limit, and output-limit failures do not retry. One policy
lease spans both attempts and releases exactly once.

Public status contains only stable backend/outcome/reason values. It excludes
device paths, drivers, GPU IDs, commands, stderr, users, media, and session IDs.
Metrics accept only known low-cardinality backend and outcome labels.

## Optional Linux prerequisites

VAAPI needs a working DRM render node and FFmpeg `h264_vaapi` support. Use a
deployment-only override on a verified Linux host:

```yaml
services:
  dashboard:
    devices:
      - /dev/dri/renderD128:/dev/dri/renderD128
    environment:
      NEBULA_TRANSCODE_ACCELERATION: prefer-vaapi
```

The container user needs host-specific render-node group permission.

NVENC needs a supported NVIDIA GPU/driver, NVIDIA Container Toolkit, container
GPU access, and FFmpeg `h264_nvenc` support:

```yaml
services:
  dashboard:
    gpus: all
    environment:
      NEBULA_TRANSCODE_ACCELERATION: prefer-nvenc
```

These are optional production prerequisites, not normal development steps.

VideoToolbox is probed because native macOS FFmpeg can expose
`h264_videotoolbox`. Nebula's standard image is Linux, and Docker Desktop on
macOS generally cannot expose the host VideoToolbox device to it. VideoToolbox
must remain unavailable unless another verified architecture passes the real
self-test. An encoder listing alone is not proof.

## Validation boundary

Docker tests always run real software HLS. Injected fixtures test deterministic
hardware paths. Report hardware as passed only when the same running container
detects a supported backend and completes an actual fixture transcode;
otherwise record it as skipped/unavailable.
