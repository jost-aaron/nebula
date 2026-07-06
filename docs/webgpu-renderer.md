# WebGPU Renderer

The animated background is a WebGPU fragment shader when WebGPU is available.
When WebGPU is unavailable, the app falls back to a Canvas 2D renderer.

## Startup Flow

`startRenderer(canvas)` does the following:

1. Checks for `navigator.gpu`.
2. Requests a high-performance adapter.
3. Requests a device.
4. Gets a `webgpu` canvas context.
5. Creates a uniform buffer.
6. Compiles WGSL shader code.
7. Creates a full-screen render pipeline.
8. Starts a `requestAnimationFrame` loop.

If any required WebGPU step fails, `startFallbackRenderer(canvas)` starts a
Canvas 2D animation instead.

## Full-Screen Triangle

The vertex shader draws one oversized triangle:

```wgsl
var positions = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f(3.0, -1.0),
  vec2f(-1.0, 3.0)
);
```

This is a common full-screen rendering pattern. The triangle covers the whole
viewport without a seam between two triangles.

## Uniforms

The shader uniform block is:

```wgsl
struct Uniforms {
  resolution: vec2f,
  time: f32,
  focus: f32,
};
```

Current values:

- `resolution` - canvas pixel width/height.
- `time` - seconds since renderer start.
- `focus` - focused dashboard app index.

The current shader does not strongly use `focus` yet. It is already wired so
future work can make the background react to selected apps.

## Fragment Shader

`fragmentMain()` computes the visible background per pixel. It combines:

- Aspect-corrected UV coordinates.
- Time-based wave functions.
- A ribbon shape.
- A center glow.
- Tiny procedural grain.
- A restrained multi-color palette.

This is shader work running on the GPU. In graphics language, call this a
fragment shader rather than a GPU kernel.

## Canvas Fallback

The fallback renderer:

- Uses `canvas.getContext("2d")`.
- Draws a radial gradient.
- Draws an animated wave line.
- Runs with the same `requestAnimationFrame` cadence.

Fallback should remain visually acceptable because WebGPU support is common but
not universal.

## Known Improvements

- Use `ResizeObserver` instead of resizing inside every frame.
- Handle WebGPU device loss.
- Use `focus` to alter shader palette/motion per selected app.
- Move shader code to a `.wgsl` file once the build setup supports it cleanly.
- Add a renderer diagnostics panel with adapter limits and feature flags.
