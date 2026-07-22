import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const bashUrl = new URL("../scripts/nebula-server.sh", import.meta.url);
const powershellUrl = new URL("../scripts/nebula-server.ps1", import.meta.url);
const commandUrl = new URL("../scripts/nebula-server.cmd", import.meta.url);

test("Unix deployment CLI selects safe Linux and macOS storage defaults", async () => {
  const script = await readFile(bashUrl, "utf8");
  assert.match(script, /Darwin\) PLATFORM_BASE_DIR="\$HOME\/Library\/Application Support\/Nebula"/);
  assert.match(script, /\*\) PLATFORM_BASE_DIR=\/srv\/nebula/);
  assert.match(script, /BASE_DIR=\$\{NEBULA_SERVER_BASE_DIR:-\$PLATFORM_BASE_DIR\}/);
  assert.match(script, /NEBULA_BIND_ADDRESS=.*127\.0\.0\.1/);
  assert.match(script, /NEBULA_AUTH_ALLOW_LOCALHOST="false"/);
  assert.match(script, /NEBULA_FIRST_RUN_GUEST_ENABLED="false"/);
  assert.match(script, /CONFIG_TAILSCALE_HOSTNAME=\$\{NEBULA_TAILSCALE_HOSTNAME:-nebula-\$SYSTEM_HOST_LABEL\}/);
});

test("Windows deployment CLI mirrors the safe lifecycle without host dependencies", async () => {
  const script = await readFile(powershellUrl, "utf8");
  assert.match(script, /PowerShell 7 or newer on Windows/);
  assert.match(script, /Join-Path \$env:LOCALAPPDATA "Nebula"/);
  assert.match(script, /ValidateSet\("install", "init", "validate", "up"/);
  assert.ok(script.lastIndexOf("Test-Prerequisites") < script.indexOf("switch ($Command)"));
  assert.match(script, /\[IO\.File\]::Move\(\$temporary, \$EnvFile\)/);
  assert.match(script, /NEBULA_BIND_ADDRESS=\$\(ConvertTo-EnvValue \$BindAddress\)/);
  assert.match(script, /NEBULA_AUTH_ALLOW_LOCALHOST=\"false\"/);
  assert.match(script, /NEBULA_FIRST_RUN_GUEST_ENABLED=\"false\"/);
  assert.match(script, /NEBULA_VITE_HMR=\"false\"/);
  assert.match(script, /\$TailscaleHostname = "nebula-\$machineLabel"/);
  assert.match(script, /ConvertTo-DockerPath/);
  assert.match(script, /icacls \$Path \/inheritance:r \/grant:r/);
  assert.match(script, /private path grants broad write access/);
  assert.match(script, /Tailscale state must be outside NEBULA_CONTENT_PATH/);
  assert.match(script, /-TailscaleFqdn must be one exact \*\.ts\.net hostname/);
  assert.match(script, /TS_CERT_DOMAIN/);
  assert.match(script, /Authorization = "Bearer \$token"/);
  assert.doesNotMatch(script, /NEBULA_API_TOKEN=.+\$token|--token\s+\$token/i);
});

test("Windows command shim delegates arguments to PowerShell 7", async () => {
  const script = await readFile(commandUrl, "utf8");
  assert.match(script, /where pwsh/);
  assert.match(script, /winget install Microsoft\.PowerShell/);
  assert.match(script, /pwsh -NoLogo -NoProfile -File "%~dp0nebula-server\.ps1" %\*/);
  assert.doesNotMatch(script, /ExecutionPolicy Bypass/i);
});
