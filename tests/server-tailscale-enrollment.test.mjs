import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTailscaleEnrollmentService } from "../server/tailscaleEnrollment.mjs";
import { createAuthGuard, sessionCookie } from "../server/auth.mjs";

const fixture = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-tailscale-control-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
};

test("dormant Tailscale companion is available but disabled", async (t) => {
  const controlDirectory = await fixture(t);
  const service = createTailscaleEnrollmentService({ available: true, controlDirectory });
  assert.deepEqual(await service.status(), {
    available: true, enabled: false, loginUrl: null, serverUrl: null, state: "disabled"
  });
  assert.equal(service.isExternalHttpsActive(), false);
});

test("owner control creates and removes only the fixed enable marker", async (t) => {
  const controlDirectory = await fixture(t);
  const service = createTailscaleEnrollmentService({ available: true, controlDirectory });
  assert.equal((await service.setEnabled(true)).state, "starting");
  assert.equal(await readFile(path.join(controlDirectory, "enabled"), "utf8"), "enabled\n");
  assert.equal((await service.setEnabled(false)).state, "disabled");
  await assert.rejects(readFile(path.join(controlDirectory, "enabled")), { code: "ENOENT" });
});

test("interactive enrollment returns only strict status files", async (t) => {
  const controlDirectory = await fixture(t);
  await writeFile(path.join(controlDirectory, "enabled"), "enabled\n");
  await writeFile(path.join(controlDirectory, "login-url"), "https://login.tailscale.com/a/Abc123\n");
  const service = createTailscaleEnrollmentService({ available: true, configuredFqdn: "nebula.example.ts.net", controlDirectory });
  assert.deepEqual(await service.status(), {
    available: true, enabled: true, loginUrl: "https://login.tailscale.com/a/Abc123", serverUrl: null, state: "awaiting-login"
  });

  await writeFile(path.join(controlDirectory, "login-url"), "https://attacker.example/a/Abc123\n");
  assert.equal((await service.status()).loginUrl, null);
});

test("connected marker activates Secure-cookie policy and a sanitized private URL", async (t) => {
  const controlDirectory = await fixture(t);
  await writeFile(path.join(controlDirectory, "enabled"), "enabled\n");
  await writeFile(path.join(controlDirectory, "connected"), "connected\n");
  await writeFile(path.join(controlDirectory, "serve-ready"), "ready\n");
  await writeFile(path.join(controlDirectory, "server-fqdn"), "Nebula.Example.ts.net\n");
  const service = createTailscaleEnrollmentService({ available: true, controlDirectory });
  assert.equal(service.isExternalHttpsActive(), true);
  assert.deepEqual(await service.status(), {
    available: true, enabled: true, loginUrl: null, serverUrl: "https://nebula.example.ts.net", state: "connected"
  });
  const request = { socket: { encrypted: false } };
  assert.doesNotMatch(sessionCookie(request, "before", 60, { externalHttps: () => false }), /; Secure/);
  assert.match(sessionCookie(request, "after", 60, { externalHttps: service.isExternalHttpsActive }), /; Secure/);
});

test("network diagnostics classify peer paths without exposing identities or addresses", async (t) => {
  const controlDirectory = await fixture(t);
  await writeFile(path.join(controlDirectory, "enabled"), "enabled\n");
  await writeFile(path.join(controlDirectory, "connected"), "connected\n");
  await writeFile(path.join(controlDirectory, "serve-ready"), "ready\n");
  await writeFile(path.join(controlDirectory, "server-fqdn"), "nebula.example.ts.net\n");
  await writeFile(path.join(controlDirectory, "network-status.json"), JSON.stringify({
    CurrentTailnet: { Name: "owner@example.com" },
    Peer: {
      "nodekey:secret-direct": { Active: true, CurAddr: "192.0.2.5:41641", HostName: "Living Room\u0000 Mac", OS: "macOS", Online: true, Relay: "sea", RxBytes: 2048, TxBytes: 4096, UserID: 42 },
      "nodekey:secret-derp": { Active: true, CurAddr: "", HostName: "Phone", OS: "iOS", Online: true, Relay: "LAX!", RxBytes: 1, TxBytes: 2 },
      "nodekey:secret-peer": { Active: true, CurAddr: "", HostName: "Tablet", OS: "android", Online: true, PeerRelay: "198.51.100.7:7777:vni:4", Relay: "sea" },
      "nodekey:secret-idle": { Active: false, CurAddr: "", HostName: "Laptop", OS: "linux", Online: true, Relay: "sea" }
    },
    User: { 42: { LoginName: "owner@example.com", ProfilePicURL: "https://example.com/private.png" } }
  }));
  const status = await createTailscaleEnrollmentService({ available: true, controlDirectory }).status();
  assert.deepEqual(status.networkPath.summary, { direct: 1, peerRelay: 1, derp: 1, idle: 1, unknown: 0 });
  assert.deepEqual(status.networkPath.peers.map(({ device, path, relayRegion }) => ({ device, path, relayRegion })), [
    { device: "Living Room Mac", path: "direct", relayRegion: undefined },
    { device: "Phone", path: "derp", relayRegion: "lax" },
    { device: "Tablet", path: "peer-relay", relayRegion: undefined },
    { device: "Laptop", path: "idle", relayRegion: undefined }
  ]);
  const exposed = JSON.stringify(status);
  for (const secret of ["192.0.2.5", "198.51.100.7", "owner@example.com", "nodekey:", "private.png"]) assert.doesNotMatch(exposed, new RegExp(secret.replaceAll(".", "\\.")));
});

test("network diagnostics reject symlinks, oversized files, and malformed JSON", async (t) => {
  const controlDirectory = await fixture(t);
  await writeFile(path.join(controlDirectory, "enabled"), "enabled\n");
  await writeFile(path.join(controlDirectory, "connected"), "connected\n");
  const target = path.join(controlDirectory, "network-target.json");
  await writeFile(target, JSON.stringify({ Peer: {} }));
  await symlink(target, path.join(controlDirectory, "network-status.json"));
  const service = createTailscaleEnrollmentService({ available: true, controlDirectory });
  assert.equal((await service.status()).networkPath, undefined);
  await rm(path.join(controlDirectory, "network-status.json"));
  await writeFile(path.join(controlDirectory, "network-status.json"), "{".repeat(262145));
  assert.equal((await service.status()).networkPath, undefined);
  await writeFile(path.join(controlDirectory, "network-status.json"), "not json");
  assert.equal((await service.status()).networkPath, undefined);
});

test("a joined node without active Serve reports HTTPS setup instead of a dead URL", async (t) => {
  const controlDirectory = await fixture(t);
  await writeFile(path.join(controlDirectory, "enabled"), "enabled\n");
  await writeFile(path.join(controlDirectory, "connected"), "connected\n");
  await writeFile(path.join(controlDirectory, "serve-error"), "https-required\n");
  await writeFile(path.join(controlDirectory, "server-fqdn"), "nebula.example.ts.net\n");
  const service = createTailscaleEnrollmentService({ available: true, controlDirectory });
  assert.equal(service.isExternalHttpsActive(), false);
  assert.deepEqual(await service.status(), {
    available: true, enabled: true, loginUrl: null, serverUrl: null, state: "https-required"
  });
});

test("control and status symlinks are rejected", async (t) => {
  const controlDirectory = await fixture(t);
  const target = path.join(controlDirectory, "target");
  await writeFile(target, "enabled\n");
  await symlink(target, path.join(controlDirectory, "enabled"));
  const service = createTailscaleEnrollmentService({ available: true, controlDirectory });
  assert.equal((await service.status()).state, "disabled");
  await assert.rejects(service.setEnabled(true), /control marker is invalid/i);
  await assert.rejects(service.setEnabled(false), /not a regular file/i);
});

test("Tailscale control requires server administration capability", async () => {
  const accountStore = {
    authenticateMediaTicket: () => null,
    authenticateSession: (token) => token === "owner" || token === "member" ? {
      csrfToken: "csrf", expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId: token,
      user: { id: `${token}-id`, role: token, username: token }
    } : null,
    countUsers: () => 2,
    isOwnerInitialized: () => true
  };
  const auth = createAuthGuard(accountStore);
  const response = () => ({ body: "", end(value = "") { this.body += value; }, setHeader() {}, writeHead(status) { this.status = status; return this; } });
  const request = (token, method = "PUT") => ({ headers: { authorization: `Bearer ${token}` }, method, socket: { remoteAddress: "203.0.113.10" }, url: "/api/admin/tailscale" });
  const url = new URL("http://nebula.local/api/admin/tailscale");
  assert.equal(await auth.authorize(request("owner"), response(), url), true);
  const denied = response();
  assert.equal(await auth.authorize(request("member"), denied, url), false);
  assert.equal(denied.status, 403);
});
