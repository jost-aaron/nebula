import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DeliveryPreparationTimeoutError,
  createAbortableDelay,
  pollDeliveryUntilReady
} from "../src/shared/deliveryPolling.js";

const delivery = (status) => ({ session: { id: "cluster_session_fixture_01", status } });

test("delivery polling uses bounded exponential backoff and returns ready", async () => {
  let currentTime = 0;
  const delays = [];
  const statuses = [delivery("running"), delivery("ready")];
  const result = await pollDeliveryUntilReady({
    initial: delivery("queued"),
    getStatus: async () => statuses.shift(),
    cancel: async () => assert.fail("ready delivery must not be cancelled"),
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    initialDelayMs: 100,
    maximumDelayMs: 500,
    backoffFactor: 2,
    jitterRatio: 0,
    now: () => currentTime,
    delay: async (milliseconds) => { delays.push(milliseconds); currentTime += milliseconds; }
  });
  assert.equal(result.session.status, "ready");
  assert.deepEqual(delays, [100, 200]);
});

test("permanently queued delivery reaches its finite deadline and cancels once", async () => {
  let currentTime = 0;
  let cancellations = 0;
  await assert.rejects(pollDeliveryUntilReady({
    initial: delivery("queued"),
    getStatus: async () => delivery("queued"),
    cancel: async () => { cancellations += 1; },
    signal: new AbortController().signal,
    timeoutMs: 250,
    initialDelayMs: 100,
    maximumDelayMs: 200,
    backoffFactor: 2,
    jitterRatio: 0,
    now: () => currentTime,
    delay: async (milliseconds) => { currentTime += milliseconds; }
  }), DeliveryPreparationTimeoutError);
  assert.equal(currentTime, 250);
  assert.equal(cancellations, 1);
});

test("source-switch abort clears its timer and cancels the cluster session once", async () => {
  const activeTimers = new Map();
  let nextTimer = 0;
  let cancellations = 0;
  const controller = new AbortController();
  const delay = createAbortableDelay({
    setTimer: (callback) => { const id = ++nextTimer; activeTimers.set(id, callback); return id; },
    clearTimer: (id) => { activeTimers.delete(id); }
  });
  const pending = pollDeliveryUntilReady({
    initial: delivery("queued"),
    getStatus: async () => assert.fail("aborted polling must not request status"),
    cancel: async () => { cancellations += 1; },
    signal: controller.signal,
    delay
  });
  await Promise.resolve();
  assert.equal(activeTimers.size, 1);
  controller.abort(new DOMException("Source switched.", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancellations, 1);
  assert.equal(activeTimers.size, 0);
});

test("Cinema and Studio connect preparation aborts to supersession and teardown", async () => {
  const [cinema, studio] = await Promise.all([
    readFile(new URL("../src/cinema/renderCinemaView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/studio/renderStudioView.ts", import.meta.url), "utf8")
  ]);
  for (const source of [cinema, studio]) {
    assert.match(source, /pollDeliveryUntilReady/);
    assert.match(source, /preparationController\?\.abort\(\)/);
    assert.match(source, /cancelCluster/);
  }
  assert.match(cinema, /const localRequest = \+\+requestGeneration;[\s\S]*?preparationController\?\.abort\(\)/);
  assert.match(cinema, /const stopPlayback = \(\) => \{[\s\S]*?preparationController\?\.abort\(\)/);
  assert.match(studio, /const releaseClusterDelivery = \(\) => \{[\s\S]*?preparationController\?\.abort\(\)/);
  assert.match(studio, /playerRequestGeneration \+= 1;[\s\S]*?releaseClusterDelivery\(\)/);
});
