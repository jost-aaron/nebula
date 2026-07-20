const SEGMENTS = 120;
const SEGMENT_BYTES = 2 * 1024 * 1024;

const simulate = (origins) => {
  const availableAt = origins.map(() => 0);
  const requests = origins.map(() => 0);
  const completions = [];
  for (let index = 0; index < SEGMENTS; index += 1) {
    const origin = availableAt.indexOf(Math.min(...availableAt));
    const selected = origins[origin];
    const duration = selected.latencyMs + (SEGMENT_BYTES / selected.bytesPerSecond) * 1000;
    availableAt[origin] += duration;
    requests[origin] += 1;
    completions.push(availableAt[origin]);
  }
  const totalMs = Math.max(...availableAt);
  return {
    aggregateMbps: Number(((SEGMENTS * SEGMENT_BYTES * 8) / (totalMs / 1000) / 1_000_000).toFixed(2)),
    rebufferProxyMs: Number(Math.max(0, totalMs - SEGMENTS * 4_000).toFixed(1)),
    requestDistribution: requests,
    startupMs: Number(Math.min(...completions).toFixed(1)),
    totalMs: Number(totalMs.toFixed(1))
  };
};

export const runMultiOriginBenchmark = () => {
  const direct = { bytesPerSecond: 8 * 1024 * 1024, latencyMs: 20 };
  const relay = { bytesPerSecond: 3 * 1024 * 1024, latencyMs: 120 };
  return {
    fixture: { note: "Deterministic scheduling model; not network or real-tailnet evidence.", segmentBytes: SEGMENT_BYTES, segments: SEGMENTS },
    singleDirect: simulate([direct]),
    singleRelay: simulate([relay]),
    twoDirect: simulate([direct, direct]),
    directAndRelay: simulate([direct, relay])
  };
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  console.log(JSON.stringify(runMultiOriginBenchmark(), null, 2));
}
