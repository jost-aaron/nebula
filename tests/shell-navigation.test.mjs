import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mapGamepadControls } from "../src/shell/gamepadMapping.ts";
import { bindGamepadCommands } from "../src/shell/gamepad.ts";
import { RepeatGate, WheelCommandGate } from "../src/shell/inputGates.ts";
import { loadFocusedAppId, saveFocusedAppId, shellPreferencesKey } from "../src/shell/persistence.ts";
import { createShellState, transitionShellState } from "../src/shell/state.ts";

const apps = ["cinema", "arcade", "studio"];

test("shell transitions select stable IDs and clamp directional movement", () => {
  let state = createShellState(apps, "arcade");
  state = transitionShellState(state, { type: "move", delta: 1 }, apps);
  assert.equal(state.focusedAppId, "studio");
  assert.equal(transitionShellState(state, { type: "move", delta: 1 }, apps).focusedAppId, "studio");
  assert.equal(transitionShellState(state, { type: "select", appId: "missing" }, apps), state);

  state = transitionShellState(state, { type: "show-details" }, apps);
  assert.deepEqual(state, { focusedAppId: "studio", detailAppId: "studio", activeAppId: null });
  state = transitionShellState(state, { type: "activate" }, apps);
  assert.deepEqual(state, { focusedAppId: "studio", detailAppId: null, activeAppId: "studio" });
  assert.equal(transitionShellState(state, { type: "close-active" }, apps).activeAppId, null);
});

test("shell persistence validates account scope and migrates a valid index once", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };

  saveFocusedAppId(storage, "user-a", "studio");
  assert.equal(loadFocusedAppId(storage, "user-a", apps), "studio");
  assert.equal(loadFocusedAppId(storage, "user-b", apps), null);
  assert.equal(loadFocusedAppId(storage, "user-a", ["cinema"]), null);

  values.set(shellPreferencesKey, JSON.stringify({ version: 1, principalId: "user-a", focusedIndex: 1 }));
  assert.equal(loadFocusedAppId(storage, "user-a", apps), "arcade");
  assert.deepEqual(JSON.parse(values.get(shellPreferencesKey)), { version: 2, principalId: "user-a", focusedAppId: "arcade" });
});

test("wheel and held-input gates emit one deliberate, debounced step", () => {
  const wheel = new WheelCommandGate(100, 500);
  assert.equal(wheel.push(40, 0), null);
  assert.equal(wheel.push(60, 10), 1);
  assert.equal(wheel.push(200, 100), null);
  assert.equal(wheel.push(100, 510), 1);
  wheel.reset();
  assert.equal(wheel.push(-100, 520), -1);

  const repeat = new RepeatGate(300, 100);
  assert.equal(repeat.shouldFire("next", true, 0, true), true);
  assert.equal(repeat.shouldFire("next", true, 299, true), false);
  assert.equal(repeat.shouldFire("next", true, 300, true), true);
  assert.equal(repeat.shouldFire("next", true, 350, true), false);
  repeat.shouldFire("next", false, 351, true);
  assert.equal(repeat.shouldFire("next", true, 352, true), true);
});

test("standard gamepad axes, d-pad, A, and B map to shell controls", () => {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false }));
  buttons[0] = { pressed: true };
  buttons[14] = { pressed: true };
  assert.deepEqual(mapGamepadControls({ axes: [0, 0], buttons }), { previous: true, next: false, open: true, back: false });
  assert.equal(mapGamepadControls({ axes: [0.8, 0], buttons: [] }).next, true);
  assert.equal(mapGamepadControls({ axes: [0.2, 0.3], buttons: [] }).next, false);
  assert.equal(mapGamepadControls({ axes: [0, 0], buttons: [{ pressed: false }, { pressed: true }] }).back, true);
});

test("gamepad polling starts once, stops on disconnect, and disposes cleanly", () => {
  const listeners = new Map();
  const frames = new Map();
  const cancelled = [];
  const commands = [];
  let nextFrame = 1;
  let pads = [];
  const host = {
    navigator: { getGamepads: () => pads },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    requestAnimationFrame: (callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => {
      cancelled.push(id);
      frames.delete(id);
    }
  };

  const dispose = bindGamepadCommands(host, (command) => commands.push(command));
  assert.equal(frames.size, 0);
  pads = [{ index: 0, axes: [1, 0], buttons: [] }];
  listeners.get("gamepadconnected")({ gamepad: pads[0] });
  listeners.get("gamepadconnected")({ gamepad: pads[0] });
  assert.equal(frames.size, 1);
  const [[frameId, poll]] = frames;
  frames.delete(frameId);
  poll(0);
  assert.deepEqual(commands, [{ type: "move", delta: 1, source: "gamepad" }]);
  pads = [null];
  listeners.get("gamepaddisconnected")({ gamepad: { index: 0 } });
  assert.equal(frames.size, 0);
  assert.equal(cancelled.length, 1);
  dispose();
  assert.equal(listeners.size, 0);
});

test("shell markup exposes one roving tile focus target and modal semantics", async () => {
  const [main, css] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(main, /role="toolbar" aria-label="Applications"/);
  assert.match(main, /tabindex="\$\{isFocused \? "0" : "-1"\}"/);
  assert.match(main, /aria-current=/);
  assert.match(main, /role="dialog" aria-modal="true"/);
  assert.match(main, /shellRoot\.inert = true/);
  assert.match(main, /bindGamepadCommands/);
  assert.match(css, /\.app-tile:focus-visible/);
});
