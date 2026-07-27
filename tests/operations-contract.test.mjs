import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("deployment uses liveness for container health and keeps readiness separate", async () => {
  const compose = await readFile(new URL("../compose.deploy.yaml", import.meta.url), "utf8");
  assert.match(compose, /healthcheck:[\s\S]*http:\/\/127\.0\.0\.1:5173\/healthz/);
  assert.doesNotMatch(compose, /healthcheck:[\s\S]{0,240}http:\/\/127\.0\.0\.1:5173\/readyz/);
});

test("server stops job claiming before waiting for HTTP shutdown", async () => {
  const source = await readFile(new URL("../server/dev.mjs", import.meta.url), "utf8");
  const stop = source.indexOf("const jobsStop = jobsWorker.stop()");
  const close = source.indexOf("httpServer.close(resolve)");
  assert.ok(stop >= 0 && close > stop);
  assert.match(source, /Promise\.all\(\[jobsStop, serverClose\]\)/);
});
