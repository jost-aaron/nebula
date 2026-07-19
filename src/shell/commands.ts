export type ShellCommand =
  | { type: "move"; delta: -1 | 1; source: "keyboard" | "wheel" | "gamepad" }
  | { type: "select"; appId: string; source: "pointer" | "programmatic" }
  | { type: "open"; source: "keyboard" | "pointer" | "gamepad" }
  | { type: "details"; source: "pointer" }
  | { type: "back"; source: "keyboard" | "pointer" | "gamepad" };

export const commandFromKey = (key: string): ShellCommand | null => {
  if (key === "ArrowRight" || key === "ArrowDown") {
    return { type: "move", delta: 1, source: "keyboard" };
  }

  if (key === "ArrowLeft" || key === "ArrowUp") {
    return { type: "move", delta: -1, source: "keyboard" };
  }

  if (key === "Enter") {
    return { type: "open", source: "keyboard" };
  }

  if (key === "Escape") {
    return { type: "back", source: "keyboard" };
  }

  return null;
};
