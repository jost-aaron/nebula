import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const deployComposeUrl = new URL("../compose.deploy.yaml", import.meta.url);
const developmentComposeUrl = new URL("../compose.yaml", import.meta.url);
const serveUrl = new URL("../deploy/tailscale/serve.json", import.meta.url);
const supervisorUrl = new URL("../deploy/tailscale/containerboot-enrollment.sh", import.meta.url);

test("both stacks include a dormant pinned userspace companion with isolated privileges", async () => {
  for (const composeUrl of [developmentComposeUrl, deployComposeUrl]) {
    const compose = await readFile(composeUrl, "utf8");
    assert.match(compose, /tailscale:\n\s+image: tailscale\/tailscale@sha256:[a-f0-9]{64}/);
    assert.doesNotMatch(compose, /profiles:/);
    assert.match(compose, /tailscale:[\s\S]*?network_mode: "service:dashboard"/);
    assert.match(compose, /tailscale:[\s\S]*?dashboard:\n\s+condition: service_healthy/);
    assert.match(compose, /TS_USERSPACE: "true"/);
    assert.match(compose, /TS_AUTHKEY: "file:\/run\/secrets\/tailscale_authkey"/);
    assert.match(compose, /NEBULA_TAILSCALE_CONTROL_(?:DIR|PATH):?=? \/(?:var\/)?run\/nebula-tailscale/);
    assert.doesNotMatch(compose, /tailscale:[\s\S]*?(?:cap_add|privileged:|\/dev\/net\/tun|network_mode: host)/);
    assert.doesNotMatch(compose.match(/dashboard:[\s\S]*?\n\s{2}tailscale:/)?.[0] ?? "", /NET_ADMIN|NET_RAW|SYS_ADMIN|tailscaled\.sock|\/dev\/net\/tun|docker\.sock/);
  }
  assert.match(await readFile(developmentComposeUrl, "utf8"), /dashboard:[\s\S]*?127\.0\.0\.1:\$\{DASHBOARD_PORT:-5173\}:5173/);
  assert.match(await readFile(deployComposeUrl, "utf8"), /dashboard:[\s\S]*?\$\{NEBULA_BIND_ADDRESS:-127\.0\.0\.1\}/);
});

test("supervisor starts only for the fixed marker and retains state when disabled", async () => {
  const supervisor = await readFile(supervisorUrl, "utf8");
  assert.match(supervisor, /enabled_file="\$control_dir\/enabled"/);
  assert.match(supervisor, /if \[ -f "\$enabled_file" \]/);
  assert.match(supervisor, /\/usr\/local\/bin\/containerboot/);
  assert.match(supervisor, /kill -TERM "\$child_pid"/);
  assert.match(supervisor, /Docker's restart policy/);
  assert.doesNotMatch(supervisor, /rm -rf.*var\/lib\/tailscale|eval|docker\.sock|funnel/i);
});

test("companion publishes only sanitized enrollment and connection status", async () => {
  const compose = await readFile(deployComposeUrl, "utf8");
  const supervisor = await readFile(supervisorUrl, "utf8");
  assert.match(supervisor, /https:\/\/login\\\.tailscale\\\.com\/a\/\[A-Za-z0-9\]\+/);
  assert.match(supervisor, /tailscale.*status --json[\s\S]*?"AuthURL"/);
  assert.match(supervisor, /publish_login/);
  assert.match(supervisor, /server-fqdn/);
  assert.match(supervisor, /serve-ready/);
  assert.match(supervisor, /serve-error/);
  assert.match(supervisor, /network-status\.json/);
  assert.match(supervisor, /tailscale.*serve status --json/);
  assert.match(supervisor, /tailscale.*status --json > "\$temporary"/);
  assert.match(supervisor, /262144/);
  assert.match(supervisor, /\.ts\\\.net/);
  assert.match(supervisor, /chmod 0640/);
  assert.doesNotMatch(compose, /tailscaled\.sock|docker\.sock|TS_ENABLE_METRICS/);
  assert.doesNotMatch(supervisor, /eval|curl|oauth|authkey/i);
});

test("reviewed Serve config fixes the loopback target and explicitly disables public Funnel", async () => {
  const config = JSON.parse(await readFile(serveUrl, "utf8"));
  assert.deepEqual(config.TCP, { 443: { HTTPS: true } });
  assert.deepEqual(config.Web["${TS_CERT_DOMAIN}:443"].Handlers["/"], { Proxy: "http://127.0.0.1:5173" });
  assert.equal(config.AllowFunnel["${TS_CERT_DOMAIN}:443"], false);
  assert.equal(JSON.stringify(config).toLowerCase().includes('"allowfunnel":true'), false);
});
