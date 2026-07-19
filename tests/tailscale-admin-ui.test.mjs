import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ui = await readFile(new URL("../src/settings/tailscaleAdmin.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../src/settings/tailscaleAdmin.css", import.meta.url), "utf8");
const panel = await readFile(new URL("../src/settings/renderSettingsPanel.ts", import.meta.url), "utf8");

test("owner Settings exposes a dedicated browser-assisted Tailscale enrollment surface", () => {
  assert.match(panel, /data-diagnostic-tab=\"remote-access\"/);
  assert.match(ui, /Open Tailscale Sign-In/);
  assert.match(ui, /target=\"_blank\" rel=\"noopener noreferrer\"/);
  assert.match(ui, /navigator\.clipboard\.writeText/);
  assert.match(ui, /Enable Tailscale/);
  assert.match(ui, /Confirm disable/);
  assert.match(ui, /setTailscaleEnabled/);
  assert.match(ui, /Enable HTTPS certificates in Tailscale/);
  assert.match(ui, /set-up-https-certificates/);
  assert.match(ui, /Nebula account sign-in is still required/);
  assert.match(ui, /Network Path/);
  assert.match(ui, /Direct/);
  assert.match(ui, /Peer relay/);
  assert.match(ui, /DERP relay/);
  assert.match(ui, /does not guess which peer is this browser/);
  assert.match(ui, /window\.setTimeout\(load, 5000\)/);
  assert.doesNotMatch(ui, /<iframe|oauth.*secret|tailscaled\.sock|docker\.sock/i);
  assert.match(css, /\.tailscale-admin-section[^}]*height:\s*max-content/);
  assert.match(css, /\.tailscale-path-summary/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.tailscale-peer/);
});
