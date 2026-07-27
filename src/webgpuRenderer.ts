type RendererState = {
  adapterName: string;
  mode: "webgpu" | "fallback";
};

const shader = `
struct Uniforms {
  resolution: vec2f,
  time: f32,
  focus: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );

  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = output.position.xy * 0.5 + vec2f(0.5);
  return output;
}

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let aspect = uniforms.resolution.x / max(uniforms.resolution.y, 1.0);
  let uv = vec2f(input.uv.x, 1.0 - input.uv.y);
  let canvas = uv * uniforms.resolution;

  let isWideShell = select(0.0, 1.0, uniforms.resolution.x / max(uniforms.resolution.y, 1.0) > 0.74);
  let centerY = mix(0.42, 0.56, isWideShell);
  let center = vec2f(0.54, centerY) * uniforms.resolution;
  let radius = uniforms.resolution.x * 0.72;
  let radial = clamp(distance(canvas, center) / max(radius, 1.0), 0.0, 1.0);

  let waveY = uniforms.resolution.y * 0.62 + sin(canvas.x * 0.015 + uniforms.time) * 28.0;
  let line = smoothstep(2.25, 0.0, abs(canvas.y - waveY));
  let grain = hash(uv * uniforms.resolution + uniforms.time) * 0.014;

  let base = vec3f(0.015, 0.018, 0.025);
  let teal = vec3f(0.0, 0.83, 1.0);
  let amber = vec3f(1.0, 0.81, 0.25);
  let innerMix = smoothstep(0.0, 0.45, radial);
  let outerMix = smoothstep(0.45, 1.0, radial);
  let innerColor = mix(base + teal * 0.42, base + amber * 0.14, innerMix);
  let gradientColor = mix(innerColor, base, outerMix);
  let color = gradientColor + vec3f(line * 0.12) + grain;
  return vec4f(color, 1.0);
}
`;

export async function startRenderer(canvas: HTMLCanvasElement): Promise<RendererState> {
  if (!navigator.gpu) {
    startFallbackRenderer(canvas);
    return { adapterName: "Canvas 2D", mode: "fallback" };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No WebGPU adapter is available.");
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("WebGPU canvas context is unavailable.");
    const format = navigator.gpu.getPreferredCanvasFormat();
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: device.createShaderModule({ code: shader }), entryPoint: "vertexMain" },
      fragment: {
        module: device.createShaderModule({ code: shader }),
        entryPoint: "fragmentMain",
        targets: [{ format }]
      },
      primitive: { topology: "triangle-list" }
    });
    const uniforms = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms } }]
    });
    let configuredWidth = 0;
    let configuredHeight = 0;
    let animationFrame = 0;
    let stopped = false;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
      if (width === configuredWidth && height === configuredHeight) return;
      configuredWidth = width;
      configuredHeight = height;
      canvas.width = width;
      canvas.height = height;
      context.configure({ device, format, alphaMode: "opaque" });
    };

    const draw = (time = 0) => {
      animationFrame = 0;
      if (stopped || document.hidden) return;
      resize();
      device.queue.writeBuffer(
        uniforms,
        0,
        new Float32Array([configuredWidth, configuredHeight, time * 0.001, 0])
      );
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.015, g: 0.018, b: 0.025, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      if (!motion.matches) animationFrame = window.requestAnimationFrame(draw);
    };

    const schedule = () => {
      if (!stopped && !document.hidden && !animationFrame) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    };
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(canvas);
    document.addEventListener("visibilitychange", schedule);
    motion.addEventListener("change", schedule);
    device.lost.then(() => {
      if (stopped) return;
      stopped = true;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      motion.removeEventListener("change", schedule);
      startFallbackRenderer(canvas);
    }).catch(() => undefined);
    schedule();

    const adapterName = adapter.info?.description || adapter.info?.device || "WebGPU adapter";
    return { adapterName, mode: "webgpu" };
  } catch {
    startFallbackRenderer(canvas);
    return { adapterName: "Canvas 2D", mode: "fallback" };
  }
}

function startFallbackRenderer(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  let animationFrame = 0;
  let configuredWidth = 0;
  let configuredHeight = 0;
  let gradient: CanvasGradient | null = null;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (width === configuredWidth && height === configuredHeight) return;
    configuredWidth = width;
    configuredHeight = height;
    canvas.width = width;
    canvas.height = height;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    gradient = context.createRadialGradient(cssWidth * 0.54, cssHeight * 0.42, 40, cssWidth * 0.54, cssHeight * 0.42, cssWidth * 0.72);
    gradient.addColorStop(0, "rgba(0, 212, 255, 0.42)");
    gradient.addColorStop(0.45, "rgba(255, 207, 63, 0.14)");
    gradient.addColorStop(1, "rgba(5, 7, 12, 1)");
  };

  const draw = (time = 0) => {
    animationFrame = 0;
    if (document.hidden) return;
    resize();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    context.fillStyle = gradient ?? "rgb(5, 7, 12)";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "rgba(255, 255, 255, 0.16)";
    context.lineWidth = 2;
    context.beginPath();

    for (let x = -20; x < width + 20; x += 24) {
      const y = height * 0.62 + Math.sin(x * 0.015 + time * 0.001) * 28;
      if (x === -20) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }

    context.stroke();
    if (!motion.matches) animationFrame = window.requestAnimationFrame(draw);
  };

  const schedule = () => {
    if (!document.hidden && !animationFrame) animationFrame = window.requestAnimationFrame(draw);
  };
  const resizeObserver = new ResizeObserver(schedule);
  resizeObserver.observe(canvas);
  document.addEventListener("visibilitychange", schedule);
  motion.addEventListener("change", schedule);
  schedule();
}
