import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repositoryRoot, "scripts", "nebula-server.sh");
const run = (args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn("bash", [cli, ...args], { cwd: repositoryRoot, env: { ...process.env, ...options.env } });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stderr, stdout }));
});

const fixture = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-cli-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { force: true, recursive: true })));
  const bin = path.join(root, "bin"); const log = path.join(root, "commands.log");
  const envFile = path.join(root, "nebula.env"); const composeFile = path.join(root, "compose.deploy.yaml");
  await mkdir(bin); await copyFile(path.join(repositoryRoot, "compose.deploy.yaml"), composeFile);
  const docker = path.join(bin, "docker");
  await writeFile(docker, `#!/bin/sh\nprintf '%s\\n' "$*" >>"$NEBULA_TEST_COMMAND_LOG"\nexit 0\n`);
  await chmod(docker, 0o755);
  return {
    args: ["--base-dir", path.join(root, "server data"), "--env-file", envFile, "--compose-file", composeFile],
    env: { NEBULA_DOCKER_BIN: docker, NEBULA_TEST_COMMAND_LOG: log }, envFile, log, root,
  };
};

test("help and argument errors do not invoke Docker", async () => {
  const help = await run(["--help"], { env: { NEBULA_DOCKER_BIN: "/missing/docker" } });
  assert.equal(help.code, 0); assert.match(help.stdout, /install\s+Initialize safely/);
  assert.match(help.stdout, /never replaces an existing env file/);
  const invalid = await run(["--port", "70000", "validate"]);
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /--port must be between 1 and 65535/);
});

test("missing Docker fails before initialization changes the host", async (t) => {
  const scope = await fixture(t); const baseDir = path.join(scope.root, "must-not-exist");
  const result = await run(["--base-dir", baseDir, "--env-file", scope.envFile, "--compose-file", scope.args.at(-1), "init"], {
    env: { NEBULA_DOCKER_BIN: path.join(scope.root, "missing-docker") },
  });
  assert.equal(result.code, 1); assert.match(result.stderr, /Docker is not installed/);
  await assert.rejects(readFile(scope.envFile), { code: "ENOENT" });
});

test("init generates conservative quoted configuration and is no-clobber", async (t) => {
  const scope = await fixture(t);
  const first = await run([...scope.args, "--port", "5517", "init"], { env: scope.env });
  assert.equal(first.code, 0, first.stderr);
  const generated = await readFile(scope.envFile, "utf8");
  assert.match(generated, /NEBULA_BIND_ADDRESS="127\.0\.0\.1"/); assert.match(generated, /NEBULA_PORT="5517"/);
  assert.match(generated, /NEBULA_DATA_PATH="[^"]*server data\/data"/);
  assert.match(generated, /NEBULA_FIRST_RUN_GUEST_ENABLED="false"/); assert.match(generated, /NEBULA_API_TOKEN=""/);
  await writeFile(scope.envFile, `${generated}# operator edit\n`, { mode: 0o600 });
  const second = await run([...scope.args, "init"], { env: scope.env });
  assert.equal(second.code, 0, second.stderr); assert.match(second.stdout, /keeping existing configuration/);
  assert.match(await readFile(scope.envFile, "utf8"), /# operator edit/);
});

test("validate and lifecycle commands construct deploy Compose invocations", async (t) => {
  const scope = await fixture(t); assert.equal((await run([...scope.args, "init"], { env: scope.env })).code, 0);
  await writeFile(scope.log, "");
  const up = await run([...scope.args, "--no-wait", "up"], { env: scope.env }); assert.equal(up.code, 0, up.stderr);
  const logs = await run([...scope.args, "logs", "--tail", "42", "--follow"], { env: scope.env }); assert.equal(logs.code, 0, logs.stderr);
  const commands = await readFile(scope.log, "utf8");
  assert.match(commands, /compose --env-file .*nebula\.env -f .*compose\.deploy\.yaml config --quiet/);
  assert.match(commands, /compose --env-file .*nebula\.env -f .*compose\.deploy\.yaml up -d --build/);
  assert.match(commands, /compose --env-file .*nebula\.env -f .*compose\.deploy\.yaml logs --tail 42 -f dashboard/);
});

test("backup rejects missing or overly permissive token files before curl", async (t) => {
  const scope = await fixture(t); assert.equal((await run([...scope.args, "init"], { env: scope.env })).code, 0);
  const missing = await run([...scope.args, "backup"], { env: scope.env });
  assert.equal(missing.code, 1); assert.match(missing.stderr, /backup requires --token-file/);
  const tokenFile = path.join(scope.root, "token"); await writeFile(tokenFile, "super-secret", { mode: 0o644 });
  const permissive = await run([...scope.args, "backup", "--token-file", tokenFile], { env: scope.env });
  assert.equal(permissive.code, 1); assert.match(permissive.stderr, /mode 0600/);
  assert.doesNotMatch(`${permissive.stdout}${permissive.stderr}`, /super-secret/);
});

test("backup keeps the token out of argv and removes private request files", async (t) => {
  const scope = await fixture(t); assert.equal((await run([...scope.args, "init"], { env: scope.env })).code, 0);
  const tokenFile = path.join(scope.root, "token"); await writeFile(tokenFile, "super-secret", { mode: 0o600 });
  const curl = path.join(scope.root, "bin", "curl");
  await writeFile(curl, `#!/bin/sh\nprintf '%s\\n' "$*" >>"$NEBULA_TEST_COMMAND_LOG"\nprintf '{"backupId":"safe-backup"}'\n`);
  await chmod(curl, 0o755);
  const result = await run([...scope.args, "backup", "--token-file", tokenFile, "--backup-id", "safe-backup"], {
    env: { ...scope.env, NEBULA_CURL_BIN: curl, TMPDIR: scope.root },
  });
  assert.equal(result.code, 0, result.stderr); assert.doesNotMatch(`${result.stdout}${result.stderr}`, /super-secret/);
  assert.doesNotMatch(await readFile(scope.log, "utf8"), /super-secret/);
  const leftovers = await import("node:fs/promises").then(({ readdir }) => readdir(scope.root));
  assert.equal(leftovers.some((name) => name.startsWith("nebula-curl.") || name.startsWith("nebula-backup.")), false);
});
