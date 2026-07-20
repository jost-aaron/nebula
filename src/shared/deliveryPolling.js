export class DeliveryPreparationTimeoutError extends Error {
  constructor() {
    super("Playback preparation timed out.");
    this.name = "DeliveryPreparationTimeoutError";
  }
}

const abortError = (signal) => signal.reason instanceof Error
  ? signal.reason
  : new DOMException("Playback preparation was cancelled.", "AbortError");

export const createAbortableDelay = ({
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (timer) => globalThis.clearTimeout(timer)
} = {}) => (delay, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(abortError(signal)); return; }
  const timer = setTimer(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, delay);
  const onAbort = () => {
    clearTimer(timer);
    signal.removeEventListener("abort", onAbort);
    reject(abortError(signal));
  };
  signal.addEventListener("abort", onAbort, { once: true });
});

const defaultDelay = createAbortableDelay();

export const pollDeliveryUntilReady = async ({
  initial,
  getStatus,
  cancel,
  signal,
  timeoutMs = 45_000,
  initialDelayMs = 350,
  maximumDelayMs = 4_000,
  backoffFactor = 1.8,
  jitterRatio = 0.1,
  now = () => Date.now(),
  random = () => Math.random(),
  delay = defaultDelay
}) => {
  const deadline = now() + timeoutMs;
  let current = initial;
  let nextDelay = initialDelayMs;
  let cancelled = false;
  const cancelOnce = async () => {
    if (cancelled) return;
    cancelled = true;
    await cancel(current.session.id).catch(() => undefined);
  };

  try {
    while (["queued", "running"].includes(current.session.status)) {
      if (signal.aborted) throw abortError(signal);
      const remaining = deadline - now();
      if (remaining <= 0) throw new DeliveryPreparationTimeoutError();
      const jitter = nextDelay * jitterRatio * ((random() * 2) - 1);
      await delay(Math.min(remaining, Math.max(0, Math.round(nextDelay + jitter))), signal);
      if (signal.aborted) throw abortError(signal);
      if (now() >= deadline) throw new DeliveryPreparationTimeoutError();
      current = await getStatus(current.session.id, signal);
      nextDelay = Math.min(maximumDelayMs, nextDelay * backoffFactor);
    }
    if (current.session.status !== "ready") throw new Error("Playback delivery did not become ready.");
    return current;
  } catch (error) {
    await cancelOnce();
    throw error;
  }
};
