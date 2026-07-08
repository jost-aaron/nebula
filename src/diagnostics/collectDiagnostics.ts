import type { DashboardApp } from "../apps";
import type { DiagnosticsSnapshot, PerformanceSnapshot, RendererRuntimeState } from "./types";

interface CollectDiagnosticsOptions {
  activeNavigation: string;
  apps: DashboardApp[];
  focusedIndex: number;
  launchedApp: DashboardApp | null;
  performance: PerformanceSnapshot;
  renderer: RendererRuntimeState;
}

const importantLimitNames = [
  "maxTextureDimension2D",
  "maxTextureArrayLayers",
  "maxBindGroups",
  "maxBindingsPerBindGroup",
  "maxBufferSize",
  "maxComputeWorkgroupSizeX",
  "maxComputeInvocationsPerWorkgroup"
] as const;

export async function collectDiagnostics(options: CollectDiagnosticsOptions): Promise<DiagnosticsSnapshot> {
  const adapter = "gpu" in navigator ? await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }) : null;
  const features = adapter ? Array.from(adapter.features).sort() : [];
  const limits = adapter
    ? importantLimitNames.map((name) => [name, String(adapter.limits[name])] satisfies [string, string])
    : [];

  return {
    apps: {
      activeNavigation: options.activeNavigation,
      appCount: options.apps.length,
      apps: options.apps,
      focusedApp: options.apps[options.focusedIndex],
      openPanel: options.launchedApp?.name ?? "None"
    },
    display: {
      colorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      devicePixelRatio: window.devicePixelRatio || 1,
      orientation: screen.orientation?.type ?? "unknown",
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      screen: `${screen.width} x ${screen.height}`,
      viewport: `${window.innerWidth} x ${window.innerHeight}`
    },
    performance: options.performance,
    renderer: {
      adapterName: options.renderer.adapterName,
      features,
      limits,
      mode: options.renderer.mode,
      preferredFormat: options.renderer.preferredFormat ?? ("gpu" in navigator ? navigator.gpu.getPreferredCanvasFormat() : "unavailable"),
      webgpuAvailable: "gpu" in navigator
    },
    runtime: {
      language: navigator.language,
      online: navigator.onLine,
      platform: navigator.platform,
      userAgent: navigator.userAgent
    },
    timestamp: new Date().toISOString()
  };
}
