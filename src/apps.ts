export type AppKind = "media" | "games" | "system" | "developer" | "social" | "files";

export interface DashboardApp {
  id: string;
  name: string;
  kind: AppKind;
  status: "ready" | "prototype" | "planned";
  accent: string;
  icon: string;
  description: string;
}

export const dashboardApps: DashboardApp[] = [
  {
    id: "cinema",
    name: "Cinema",
    kind: "media",
    status: "prototype",
    accent: "#00d4ff",
    icon: "Clapperboard",
    description: "A future native video player surface with library, playback, and queue hooks."
  },
  {
    id: "arcade",
    name: "Arcade",
    kind: "games",
    status: "prototype",
    accent: "#ffcf3f",
    icon: "Gamepad2",
    description: "Moonlight-ready game streaming shell with mock host, session, and controller diagnostics."
  },
  {
    id: "studio",
    name: "Studio",
    kind: "media",
    status: "ready",
    accent: "#f2b872",
    icon: "AudioLines",
    description: "Dedicated music library for local MP3, FLAC, M4A, WAV, AAC, and OGG tracks."
  },
  {
    id: "files",
    name: "Files",
    kind: "files",
    status: "ready",
    accent: "#4da3ff",
    icon: "FolderOpen",
    description: "Browse and manage local dashboard content."
  },
  {
    id: "party",
    name: "Party",
    kind: "social",
    status: "planned",
    accent: "#ff7bbf",
    icon: "UsersRound",
    description: "Presence, friends, voice, and shared watch sessions."
  },
  {
    id: "settings",
    name: "Settings",
    kind: "system",
    status: "ready",
    accent: "#c7d0dc",
    icon: "SlidersHorizontal",
    description: "System preferences and shell-level configuration."
  },
  {
    id: "search",
    name: "Search",
    kind: "system",
    status: "ready",
    accent: "#ffffff",
    icon: "Radar",
    description: "Find and launch dashboard apps by name."
  }
];
