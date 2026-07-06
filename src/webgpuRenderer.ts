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
  var p = (input.uv - vec2f(0.5)) * vec2f(aspect, 1.0);
  let t = uniforms.time * 0.08;

  let waveA = sin((p.x * 3.4 + p.y * 1.7) + t * 5.0);
  let waveB = cos(length(p + vec2f(sin(t), cos(t)) * 0.18) * 9.0 - t * 8.0);
  let ribbon = smoothstep(0.32, 0.0, abs(p.y + waveA * 0.06 - sin(p.x * 2.0 + t) * 0.12));
  let glow = pow(max(0.0, 1.0 - length(p * vec2f(0.72, 1.1))), 2.4);
  let grain = hash(input.uv * uniforms.resolution + uniforms.time) * 0.035;

  let base = vec3f(0.015, 0.018, 0.025);
  let teal = vec3f(0.0, 0.72, 0.95);
  let amber = vec3f(1.0, 0.62, 0.16);
  let rose = vec3f(0.94, 0.25, 0.62);
  let color = base + teal * glow * 0.55 + amber * ribbon * 0.38 + rose * max(waveB, 0.0) * 0.08 + grain;
  return vec4f(color, 1.0);
}
`;

export async function startRenderer(canvas: HTMLCanvasElement): Promise<RendererState> {
  if (!("gpu" in navigator)) {
    startFallbackRenderer(canvas);
    return { adapterName: "Unavailable", mode: "fallback" };
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance"
  });

  if (!adapter) {
    startFallbackRenderer(canvas);
    return { adapterName: "No compatible adapter", mode: "fallback" };
  }

  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");

  if (!context) {
    startFallbackRenderer(canvas);
    return { adapterName: "Canvas context unavailable", mode: "fallback" };
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  const module = device.createShaderModule({ code: shader });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vertexMain"
    },
    fragment: {
      module,
      entryPoint: "fragmentMain",
      targets: [{ format }]
    }
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
  });

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      context.configure({
        device,
        format,
        alphaMode: "opaque"
      });
    }
  };

  const startedAt = performance.now();
  const frame = () => {
    resize();
    const data = new Float32Array([
      canvas.width,
      canvas.height,
      (performance.now() - startedAt) / 1000,
      Number(document.documentElement.dataset.focusIndex ?? 0)
    ]);

    device.queue.writeBuffer(uniformBuffer, 0, data);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.01, g: 0.012, b: 0.016, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();

    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
  const adapterInfo = "info" in adapter ? await adapter.info : undefined;

  return {
    adapterName: adapterInfo?.description || adapterInfo?.vendor || "WebGPU adapter",
    mode: "webgpu"
  };
}

function startFallbackRenderer(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  const draw = (time: number) => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(canvas.clientWidth * ratio);
    canvas.height = Math.floor(canvas.clientHeight * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const gradient = context.createRadialGradient(width * 0.54, height * 0.42, 40, width * 0.54, height * 0.42, width * 0.72);
    gradient.addColorStop(0, "rgba(0, 212, 255, 0.42)");
    gradient.addColorStop(0.45, "rgba(255, 207, 63, 0.14)");
    gradient.addColorStop(1, "rgba(5, 7, 12, 1)");

    context.fillStyle = gradient;
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
    requestAnimationFrame(draw);
  };

  requestAnimationFrame(draw);
}
