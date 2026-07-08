import type { DashboardApp } from "../apps";

export type RendererMode = "checking" | "webgpu" | "fallback" | "error";

export interface RendererRuntimeState {
  adapterName: string;
  mode: RendererMode;
  preferredFormat?: string;
}

export interface PerformanceSnapshot {
  averageFrameMs: number;
  fps: number;
  samples: number;
  uptimeSeconds: number;
}

export interface DisplayDiagnostics {
  colorScheme: string;
  devicePixelRatio: number;
  orientation: string;
  reducedMotion: boolean;
  screen: string;
  viewport: string;
}

export interface RendererDiagnostics {
  adapterName: string;
  features: string[];
  limits: Array<[string, string]>;
  mode: RendererMode;
  preferredFormat: string;
  webgpuAvailable: boolean;
}

export interface RuntimeDiagnostics {
  language: string;
  online: boolean;
  platform: string;
  userAgent: string;
}

export interface AppDiagnostics {
  activeNavigation: string;
  appCount: number;
  apps: DashboardApp[];
  focusedApp: DashboardApp;
  openPanel: string;
}

export interface DiagnosticsSnapshot {
  apps: AppDiagnostics;
  display: DisplayDiagnostics;
  performance: PerformanceSnapshot;
  renderer: RendererDiagnostics;
  runtime: RuntimeDiagnostics;
  timestamp: string;
}
