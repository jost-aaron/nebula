import type { PerformanceSnapshot } from "./types";

export function createPerformanceMonitor() {
  const frameSamples: number[] = [];
  const startedAt = performance.now();
  let lastFrame = startedAt;
  let running = false;

  const frame = (now: number) => {
    if (!running) {
      return;
    }

    const delta = now - lastFrame;
    lastFrame = now;

    if (delta > 0 && delta < 1000) {
      frameSamples.push(delta);
    }

    while (frameSamples.length > 120) {
      frameSamples.shift();
    }

    requestAnimationFrame(frame);
  };

  return {
    start() {
      if (running) {
        return;
      }

      running = true;
      lastFrame = performance.now();
      requestAnimationFrame(frame);
    },
    snapshot(): PerformanceSnapshot {
      const averageFrameMs =
        frameSamples.length > 0 ? frameSamples.reduce((sum, sample) => sum + sample, 0) / frameSamples.length : 0;

      return {
        averageFrameMs,
        fps: averageFrameMs > 0 ? 1000 / averageFrameMs : 0,
        samples: frameSamples.length,
        uptimeSeconds: (performance.now() - startedAt) / 1000
      };
    }
  };
}
