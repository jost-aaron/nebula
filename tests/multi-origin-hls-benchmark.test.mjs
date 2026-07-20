import assert from "node:assert/strict";
import test from "node:test";
import { runMultiOriginBenchmark } from "../scripts/benchmark-multi-origin-hls.mjs";

test("generated benchmark is deterministic and labels its evidence limits", () => {
  const result = runMultiOriginBenchmark();
  assert.match(result.fixture.note, /not network or real-tailnet evidence/);
  assert.ok(result.twoDirect.totalMs < result.singleDirect.totalMs);
  assert.ok(result.directAndRelay.totalMs < result.singleRelay.totalMs);
  assert.equal(result.twoDirect.requestDistribution.reduce((sum, value) => sum + value, 0), result.fixture.segments);
});

