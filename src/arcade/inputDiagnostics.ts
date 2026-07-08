export interface ArcadeGamepadButtonSnapshot {
  index: number;
  pressed: boolean;
  touched: boolean;
  value: number;
}

export interface ArcadeGamepadAxisSnapshot {
  index: number;
  value: number;
}

export interface ArcadeGamepadSnapshot {
  index: number;
  id: string;
  connected: boolean;
  mapping: GamepadMappingType | "custom" | "";
  timestamp: number;
  buttons: ArcadeGamepadButtonSnapshot[];
  axes: ArcadeGamepadAxisSnapshot[];
  haptics: boolean;
}

export interface ArcadeInputDiagnosticsSnapshot {
  supported: boolean;
  gamepadCount: number;
  timestamp: number;
  gamepads: ArcadeGamepadSnapshot[];
}

export interface ArcadeInputDiagnosticsMonitor {
  read: () => ArcadeInputDiagnosticsSnapshot;
  start: () => void;
  stop: () => void;
}

export interface ArcadeInputDiagnosticsMonitorOptions {
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 250;

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const formatAxisValue = (value: number) => (Math.abs(value) < 0.005 ? "0.00" : value.toFixed(2));

const normalizeMapping = (mapping: GamepadMappingType | string): ArcadeGamepadSnapshot["mapping"] => {
  if (mapping === "standard" || mapping === "" || mapping === "xr-standard") {
    return mapping;
  }

  return "custom";
};

const getNavigatorWithGamepads = (): Navigator | null => {
  if (typeof navigator === "undefined") {
    return null;
  }

  return navigator;
};

const hasVibrationActuator = (gamepad: Gamepad): boolean => {
  const candidate = gamepad as Gamepad & {
    vibrationActuator?: unknown;
    hapticActuators?: unknown[];
  };

  return Boolean(candidate.vibrationActuator) || Boolean(candidate.hapticActuators?.length);
};

export function isArcadeGamepadApiSupported(targetNavigator: Navigator | null = getNavigatorWithGamepads()): boolean {
  return typeof targetNavigator?.getGamepads === "function";
}

export function readArcadeInputDiagnostics(
  targetNavigator: Navigator | null = getNavigatorWithGamepads()
): ArcadeInputDiagnosticsSnapshot {
  const supported = isArcadeGamepadApiSupported(targetNavigator);
  const timestamp = Date.now();

  if (!supported || !targetNavigator) {
    return {
      supported,
      gamepadCount: 0,
      timestamp,
      gamepads: []
    };
  }

  const gamepads = Array.from(targetNavigator.getGamepads())
    .filter((gamepad): gamepad is Gamepad => Boolean(gamepad))
    .map((gamepad) => ({
      index: gamepad.index,
      id: gamepad.id,
      connected: gamepad.connected,
      mapping: normalizeMapping(gamepad.mapping),
      timestamp: gamepad.timestamp,
      buttons: gamepad.buttons.map((button, index) => ({
        index,
        pressed: button.pressed,
        touched: button.touched,
        value: button.value
      })),
      axes: gamepad.axes.map((value, index) => ({
        index,
        value
      })),
      haptics: hasVibrationActuator(gamepad)
    }));

  return {
    supported,
    gamepadCount: gamepads.length,
    timestamp,
    gamepads
  };
}

export function createArcadeInputDiagnosticsMonitor(
  onChange: (snapshot: ArcadeInputDiagnosticsSnapshot) => void,
  options: ArcadeInputDiagnosticsMonitorOptions = {}
): ArcadeInputDiagnosticsMonitor {
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  let intervalId: number | null = null;

  const read = () => readArcadeInputDiagnostics();
  const notify = () => onChange(read());

  const start = () => {
    if (intervalId !== null) {
      return;
    }

    notify();
    intervalId = window.setInterval(notify, pollIntervalMs);
    window.addEventListener("gamepadconnected", notify);
    window.addEventListener("gamepaddisconnected", notify);
  };

  const stop = () => {
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }

    window.removeEventListener("gamepadconnected", notify);
    window.removeEventListener("gamepaddisconnected", notify);
  };

  return { read, start, stop };
}

export function renderArcadeInputDiagnosticsPanel(snapshot: ArcadeInputDiagnosticsSnapshot): string {
  if (!snapshot.supported) {
    return `
      <section class="arcade-input-diagnostics" data-arcade-input-diagnostics>
        <div class="arcade-input-diagnostics__header">
          <h3>Controller Input</h3>
          <span>Gamepad API unavailable</span>
        </div>
      </section>
    `;
  }

  const gamepadRows =
    snapshot.gamepads.length > 0
      ? snapshot.gamepads.map(renderGamepadRow).join("")
      : `
        <div class="arcade-input-diagnostics__empty">
          <strong>No controllers connected</strong>
          <span>Connect or wake a controller to inspect browser input state.</span>
        </div>
      `;

  return `
    <section class="arcade-input-diagnostics" data-arcade-input-diagnostics>
      <div class="arcade-input-diagnostics__header">
        <h3>Controller Input</h3>
        <span>${snapshot.gamepadCount} connected</span>
      </div>
      <div class="arcade-input-diagnostics__list">
        ${gamepadRows}
      </div>
    </section>
  `;
}

function renderGamepadRow(gamepad: ArcadeGamepadSnapshot): string {
  const activeButtons = gamepad.buttons
    .filter((button) => button.pressed || button.touched || button.value > 0.01)
    .map((button) => `B${button.index}:${button.value.toFixed(2)}`)
    .slice(0, 12);

  const axes = gamepad.axes
    .map((axis) => `A${axis.index}:${formatAxisValue(axis.value)}`)
    .slice(0, 8)
    .join(" ");

  return `
    <article class="arcade-input-diagnostics__device" data-gamepad-index="${gamepad.index}">
      <div class="arcade-input-diagnostics__device-main">
        <strong>${escapeHtml(gamepad.id)}</strong>
        <span>Index ${gamepad.index} · ${escapeHtml(gamepad.mapping || "unmapped")} · ${
          gamepad.haptics ? "haptics" : "no haptics"
        }</span>
      </div>
      <div class="arcade-input-diagnostics__metrics" aria-label="Controller state">
        <span>${gamepad.buttons.length} buttons</span>
        <span>${gamepad.axes.length} axes</span>
        <span>${Math.round(gamepad.timestamp)} ms</span>
      </div>
      <div class="arcade-input-diagnostics__state">
        <span>${escapeHtml(activeButtons.length > 0 ? activeButtons.join(" ") : "Buttons idle")}</span>
        <span>${escapeHtml(axes || "Axes unavailable")}</span>
      </div>
    </article>
  `;
}

// Future Moonlight bridge code can translate these snapshots into Moonlight Core
// controller events without coupling the Arcade UI to browser Gamepad objects.
