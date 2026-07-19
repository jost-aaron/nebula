export const createRenditionCleanupScheduler = ({ enqueue, getPolicy, setTimer = setTimeout, clearTimer = clearTimeout } = {}) => {
  let timer = null;
  let running = false;
  const schedule = () => {
    if (!running) return;
    const interval = Math.max(5, getPolicy().cleanupIntervalMinutes) * 60_000;
    timer = setTimer(() => {
      timer = null;
      enqueue("scheduled");
      schedule();
    }, interval);
    timer.unref?.();
  };
  const start = () => {
    if (running) return;
    running = true;
    schedule();
  };
  const stop = () => { running = false; if (timer) clearTimer(timer); timer = null; };
  return { start, stop };
};
