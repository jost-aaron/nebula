import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createAuthGuard } from "../server/auth.mjs";
import { applyApiCorsHeaders, handleApiPreflight } from "../server/cors.mjs";
import { readBody } from "../server/http.mjs";

const responseMock = () => ({
  headers: {},
  setHeader(name, value) { this.headers[name] = value; },
  writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
  end(body = "") { this.body = body; }
});

const authRequest = ({ address, authorization, host = "attacker.example" }) => ({
  headers: { authorization, host },
  socket: { remoteAddress: address }
});

const withAuthEnvironment = async (values, callback) => {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { await callback(); } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

test("auth ignores a forged localhost Host header", async () => {
  await withAuthEnvironment({ NEBULA_REQUIRE_AUTH: "true", NEBULA_API_TOKEN: "secret", NEBULA_AUTH_ALLOW_LOCALHOST: "true" }, async () => {
    const response = responseMock();
    assert.equal(await createAuthGuard().authorize(authRequest({ address: "10.0.0.8", host: "localhost:5173" }), response), false);
    assert.equal(response.status, 401);
  });
});

test("localhost exemption can be enabled or disabled", async () => {
  await withAuthEnvironment({ NEBULA_REQUIRE_AUTH: "true", NEBULA_API_TOKEN: "secret", NEBULA_AUTH_ALLOW_LOCALHOST: "true" }, async () => {
    assert.equal(await createAuthGuard().authorize(authRequest({ address: "::ffff:127.0.0.1" }), responseMock()), true);
  });
  await withAuthEnvironment({ NEBULA_REQUIRE_AUTH: "true", NEBULA_API_TOKEN: "secret", NEBULA_AUTH_ALLOW_LOCALHOST: "false" }, async () => {
    const response = responseMock();
    assert.equal(await createAuthGuard().authorize(authRequest({ address: "::1" }), response), false);
    assert.equal(response.status, 401);
  });
});

test("bearer tokens must match exactly", async () => {
  await withAuthEnvironment({ NEBULA_REQUIRE_AUTH: "true", NEBULA_API_TOKEN: "secret", NEBULA_AUTH_ALLOW_LOCALHOST: "false" }, async () => {
    assert.equal(await createAuthGuard().authorize(authRequest({ address: "10.0.0.8", authorization: "Bearer secret" }), responseMock()), true);
    for (const authorization of [undefined, "Bearer wrong", "secret"]) {
      const response = responseMock();
      assert.equal(await createAuthGuard().authorize(authRequest({ address: "10.0.0.8", authorization }), response), false);
      assert.equal(response.status, 401);
    }
  });
});

test("CORS allows only configured browser and Capacitor origins", () => {
  for (const origin of ["capacitor://localhost", "http://localhost:5173", "http://127.0.0.1:5173"]) {
    const response = responseMock();
    applyApiCorsHeaders({ headers: { origin } }, response);
    assert.equal(response.headers["access-control-allow-origin"], origin);
  }
  const rejected = responseMock();
  applyApiCorsHeaders({ headers: { origin: "https://attacker.example" } }, rejected);
  assert.equal(rejected.headers["access-control-allow-origin"], undefined);
});

test("CORS PATCH preflight advertises PATCH without reflecting rejected origins", () => {
  const response = responseMock();
  const request = { headers: { origin: "capacitor://localhost" }, method: "OPTIONS" };
  applyApiCorsHeaders(request, response);
  assert.equal(handleApiPreflight(request, response), true);
  assert.equal(response.status, 204);
  assert.match(response.headers["access-control-allow-methods"], /PATCH/);
});

test("JSON bodies enforce size limits and report malformed input", async () => {
  const valid = Readable.from([Buffer.from('{"ok":true}')]);
  valid.headers = {};
  assert.deepEqual(await readBody(valid, { limit: 32 }), { ok: true });

  const oversized = Readable.from([Buffer.from("12345")]);
  oversized.headers = {};
  await assert.rejects(readBody(oversized, { limit: 4 }), (error) => error.status === 413);

  const declaredOversized = Readable.from([]);
  declaredOversized.headers = { "content-length": "5" };
  await assert.rejects(readBody(declaredOversized, { limit: 4 }), (error) => error.status === 413);

  const malformed = Readable.from([Buffer.from("{")]);
  malformed.headers = {};
  await assert.rejects(readBody(malformed), (error) => error.status === 400);
});
