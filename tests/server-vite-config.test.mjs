import assert from "node:assert/strict";
import test from "node:test";
import { createExactViteHostGuard, createViteServerOptions, parseExactViteAllowedHosts } from "../server/viteConfig.mjs";

test("deployment can disable HMR without changing the development default", () => {
  assert.deepEqual(createViteServerOptions({}), { hmr: { host: "127.0.0.1" } });
  assert.deepEqual(createViteServerOptions({ NEBULA_VITE_HMR: "false" }), { hmr: false });
});

test("runtime host guard accepts only local, IP, configured, or exact sidecar-published hosts", () => {
  const response = () => ({ body: "", end(value = "") { this.body += value; }, writeHead(status) { this.status = status; } });
  let dynamic = "nebula.tail024251.ts.net";
  const guard = createExactViteHostGuard({ configuredHosts: ["media.home.example"], dynamicHost: () => dynamic });
  for (const host of ["localhost:5173", "127.0.0.1:5173", "192.168.1.20:5173", "media.home.example", "nebula.tail024251.ts.net"]) {
    assert.equal(guard({ headers: { host } }, response()), true, host);
  }
  for (const host of ["attacker.example", "other.tail024251.ts.net", "nebula.tail024251.ts.net.attacker.example", "*.ts.net"] ) {
    const denied = response();
    assert.equal(guard({ headers: { host } }, denied), false, host);
    assert.equal(denied.status, 403);
  }
  dynamic = null;
  assert.equal(guard({ headers: { host: "nebula.tail024251.ts.net" } }, response()), false);
});

test("Vite accepts only explicit exact hostnames", () => {
  assert.deepEqual(parseExactViteAllowedHosts("nebula.example.ts.net, media.home.example"), ["nebula.example.ts.net", "media.home.example"]);
  assert.deepEqual(createViteServerOptions({ NEBULA_VITE_ALLOWED_HOSTS: "Nebula.Example.ts.net" }), {
    allowedHosts: ["nebula.example.ts.net"], hmr: { host: "127.0.0.1" }
  });
  for (const unsafe of ["*", ".ts.net", "*.ts.net", "https://nebula.example.ts.net", "nebula.example.ts.net:443", "nebula/example"]) {
    assert.throws(() => parseExactViteAllowedHosts(unsafe), /exact hostnames only/);
  }
});
