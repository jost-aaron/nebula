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
  startFallbackRenderer(canvas);
  return { adapterName: "Matched iOS background", mode: "fallback" };
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
