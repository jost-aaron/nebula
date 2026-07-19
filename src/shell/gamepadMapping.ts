export interface GamepadSnapshot {
  index?: number;
  axes: readonly number[];
  buttons: readonly { pressed: boolean }[];
}

export interface GamepadControlState {
  previous: boolean;
  next: boolean;
  open: boolean;
  back: boolean;
}

export const mapGamepadControls = (gamepad: GamepadSnapshot, deadzone = 0.55): GamepadControlState => ({
  previous: (gamepad.axes[0] ?? 0) < -deadzone || (gamepad.axes[1] ?? 0) < -deadzone || Boolean(gamepad.buttons[14]?.pressed) || Boolean(gamepad.buttons[12]?.pressed),
  next: (gamepad.axes[0] ?? 0) > deadzone || (gamepad.axes[1] ?? 0) > deadzone || Boolean(gamepad.buttons[15]?.pressed) || Boolean(gamepad.buttons[13]?.pressed),
  open: Boolean(gamepad.buttons[0]?.pressed),
  back: Boolean(gamepad.buttons[1]?.pressed)
});
