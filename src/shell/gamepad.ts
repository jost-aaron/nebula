import type { ShellCommand } from "./commands.ts";
import { mapGamepadControls, type GamepadSnapshot } from "./gamepadMapping.ts";
import { RepeatGate } from "./inputGates.ts";

export interface GamepadHost {
  addEventListener(type: "gamepadconnected" | "gamepaddisconnected", listener: EventListener): void;
  removeEventListener(type: "gamepadconnected" | "gamepaddisconnected", listener: EventListener): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  navigator: { getGamepads?: () => readonly (GamepadSnapshot | null)[] };
}

export const bindGamepadCommands = (host: GamepadHost, dispatch: (command: ShellCommand) => void) => {
  const gate = new RepeatGate();
  let frame: number | null = null;

  const poll = (now: number) => {
    const gamepad = host.navigator.getGamepads?.().find((candidate) => candidate !== null) ?? null;
    const controls = gamepad ? mapGamepadControls(gamepad) : { previous: false, next: false, open: false, back: false };

    if (gate.shouldFire("previous", controls.previous, now, true)) dispatch({ type: "move", delta: -1, source: "gamepad" });
    if (gate.shouldFire("next", controls.next, now, true)) dispatch({ type: "move", delta: 1, source: "gamepad" });
    if (gate.shouldFire("open", controls.open, now, false)) dispatch({ type: "open", source: "gamepad" });
    if (gate.shouldFire("back", controls.back, now, false)) dispatch({ type: "back", source: "gamepad" });

    frame = host.requestAnimationFrame(poll);
  };

  const start = () => {
    if (frame === null) frame = host.requestAnimationFrame(poll);
  };
  const stopIfDisconnected = (event: Event) => {
    const disconnectedIndex = (event as GamepadEvent).gamepad?.index;
    const hasRemainingGamepad = host.navigator.getGamepads?.().some((candidate, index) =>
      candidate !== null && index !== disconnectedIndex
    );
    if (hasRemainingGamepad) return;
    if (frame !== null) host.cancelAnimationFrame(frame);
    frame = null;
  };

  host.addEventListener("gamepadconnected", start);
  host.addEventListener("gamepaddisconnected", stopIfDisconnected);
  if (host.navigator.getGamepads?.().some(Boolean)) start();

  return () => {
    host.removeEventListener("gamepadconnected", start);
    host.removeEventListener("gamepaddisconnected", stopIfDisconnected);
    if (frame !== null) host.cancelAnimationFrame(frame);
    frame = null;
  };
};
