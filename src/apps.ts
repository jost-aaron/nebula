export type AppKind = "media" | "games" | "system" | "developer" | "social";

export interface DashboardApp {
  id: string;
  name: string;
  kind: AppKind;
  status: "ready" | "prototype" | "planned";
  accent: string;
  description: string;
}

export const dashboardApps: DashboardApp[] = [
  {
    id: "cinema",
    name: "Cinema",
    kind: "media",
    status: "prototype",
    accent: "#00d4ff",
    description: "A future native video player surface with library, playback, and queue hooks."
  },
  {
    id: "arcade",
    name: "Arcade",
    kind: "games",
    status: "planned",
    accent: "#ffcf3f",
    description: "Game launcher and controller-first discovery space."
  },
  {
    id: "studio",
    name: "Studio",
    kind: "developer",
    status: "ready",
    accent: "#72f29d",
    description: "Developer tools, diagnostics, and WebGPU capability probes."
  },
  {
    id: "party",
    name: "Party",
    kind: "social",
    status: "planned",
    accent: "#ff7bbf",
    description: "Presence, friends, voice, and shared watch sessions."
  },
  {
    id: "settings",
    name: "Settings",
    kind: "system",
    status: "ready",
    accent: "#c7d0dc",
    description: "System preferences and shell-level configuration."
  },
  {
    id: "search",
    name: "Search",
    kind: "system",
    status: "ready",
    accent: "#ffffff",
    description: "Find and launch dashboard apps by name."
  }
];
