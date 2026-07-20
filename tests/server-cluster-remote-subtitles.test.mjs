import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";
import { clusterMigration, createClusterGrantService, createClusterIngressRoutes, createClusterRepository, createClusterTrustService } from "../server/cluster/index.mjs";

const capabilities = { directPlay: true, hls: true, remux: true, renditionProfiles: [], transcode: true };
const fixture = (endpoint, name, role) => {
  const database = new DatabaseSync(":memory:");
  applyDomainMigrations(database, [clusterMigration]);
  return { database, trust: createClusterTrustService({ capabilities, endpoint, name, repository: createClusterRepository(database), role }) };
};

test("ticketed remote sidecars are grant, source revision, and exact-origin bound", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-remote-subtitle-"));
  const subtitlePath = path.join(root, "fixture.en.vtt");
  await writeFile(subtitlePath, "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n");
  const coordinator = fixture("https://home.tail024251.ts.net/", "Home", "coordinator");
  const shard = fixture("https://shard.tail024251.ts.net/", "Shard", "shard");
  const acceptedPair = shard.trust.acceptPairing({
    clusterId: coordinator.trust.identity().clusterId,
    pairingCode: shard.trust.createPairingCode().pairingCode,
    requester: coordinator.trust.identity().descriptor
  });
  coordinator.trust.registerPairedNode(acceptedPair);
  const source = { availability: "available", contentRevision: 7, id: "source_fixture_01", itemId: "item_fixture_01", path: "fixture.mp4" };
  const catalog = { getSource: (id) => id === source.id ? source : null };
  const issuer = createClusterGrantService({ catalog, trust: coordinator.trust, now: () => 1_000, uuid: () => "00000000-0000-4000-8000-000000000001", random: (bytes) => Buffer.alloc(bytes, 5) });
  const validator = createClusterGrantService({ catalog, trust: shard.trust, now: () => 1_000, random: (bytes) => Buffer.alloc(bytes, 9) });
  const subtitleId = "sub_fixture_english";
  const signed = issuer.issue({
    accountId: "account_fixture_01", candidate: { localSourceId: source.id, nodeId: shard.trust.identity().descriptor.nodeId, sourceRevision: 7 },
    clientOrigin: "https://home.tail024251.ts.net", deviceId: "device_fixture_01", federatedItemId: "fitem_fixture_01",
    sessionId: "session_fixture_01", subtitleId
  });
  const accepted = validator.accept(signed);
  const subtitles = {
    resolveAsset: async (ids, requestedId) => {
      assert.deepEqual(ids, { itemId: source.itemId, sourceId: source.id });
      assert.equal(requestedId, subtitleId);
      return { contentType: "text/vtt; charset=utf-8", path: subtitlePath };
    }
  };
  const route = createClusterIngressRoutes({ contentRoot: root, grants: validator, service: shard.trust, subtitles });
  const server = createServer((request, response) => void route(request, response, new URL(request.url, "http://localhost")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    coordinator.database.close(); shard.database.close();
    await rm(root, { force: true, recursive: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const asset = `${origin}${signed.grant.assetPrefix}subtitle/${subtitleId}?ticket=${encodeURIComponent(accepted.mediaTicket)}`;
  const response = await fetch(asset, { headers: { origin: signed.grant.clientOrigin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), signed.grant.clientOrigin);
  assert.match(await response.text(), /WEBVTT/);
  assert.equal((await fetch(asset.replace(subtitleId, "sub_other_fixture"))).status, 404);
  assert.equal((await fetch(asset.replace(/\?ticket=.*/, ""))).status, 404);
  source.contentRevision = 8;
  assert.equal((await fetch(asset)).status, 404);
});
