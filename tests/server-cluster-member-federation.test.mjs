import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClusterPlaybackRoutes } from "../server/cluster/index.mjs";
import { createCinemaRoutes } from "../server/cinema.mjs";
import { createMusicRoutes } from "../server/music.mjs";
import { createStorage } from "../server/storage.mjs";

const listen = async (playback, authorize) => {
  const route = createClusterPlaybackRoutes(playback, { authorize });
  const server = createServer(async (request, response) => {
    const role = request.headers["x-test-role"];
    request.nebulaAuth = role === "guest"
      ? { kind: "guest", user: null }
      : { kind: "account", user: { id: `account_${role}_01`, role } };
    try {
      if (!await route(request, response, new URL(request.url, "http://nebula"))) response.writeHead(404).end();
    } catch (error) {
      response.writeHead(error.status ?? 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: error.code, error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { close: () => new Promise((resolve) => server.close(resolve)), origin: `http://127.0.0.1:${server.address().port}` };
};

test("cluster routes admit authorized members while denied members and guests fail closed", async (t) => {
  const created = [];
  const playback = { create: async (request, context) => {
    created.push({ context, request });
    return { session: { id: "cluster_session_01" } };
  } };
  const server = await listen(playback, (_context, itemId) => itemId === "fitem_allowed_01");
  t.after(server.close);
  const post = (role, federatedItemId) => fetch(`${server.origin}/api/cluster/playback-sessions`, {
    body: JSON.stringify({ capabilities: { deviceId: "device_fixture_01" }, federatedItemId }),
    headers: { "content-type": "application/json", "x-test-role": role }, method: "POST"
  });

  assert.equal((await post("member", "fitem_allowed_01")).status, 201);
  const denied = await post("member", "fitem_denied_01");
  assert.equal(denied.status, 404);
  assert.equal((await denied.json()).code, "cluster_item_not_found");
  assert.equal((await post("guest", "fitem_allowed_01")).status, 403);
  assert.equal((await post("owner", "fitem_denied_01")).status, 201);
  assert.equal(created.length, 2);
  assert.deepEqual(created.map(({ context }) => context.accountId), ["account_member_01", "account_owner_01"]);
});

test("Cinema and Studio expose only coordinator-authorized federated items to members", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-member-federation-"));
  const storage = await createStorage({ contentRoot: path.join(root, "content"), dataRoot: path.join(root, "data") });
  const source = {
    availability: "available", capabilities: { directPlay: true, renditionProfiles: [], transcode: true },
    id: "fsource_remote_01", local: false, localItemId: "item_remote_01", localSourceId: "source_remote_01",
    nodeName: "Remote", nodeState: "online", renditions: [], sourceRevision: 1, subtitles: []
  };
  const items = [
    { availability: "available", id: "fitem_allowed_01", itemKind: "movie", mediaKind: "video", nodeCount: 1, sourceCount: 1, sources: [source], title: "Allowed Film", year: 2026 },
    { availability: "available", id: "fitem_denied_01", itemKind: "movie", mediaKind: "video", nodeCount: 1, sourceCount: 1, sources: [source], title: "Denied Film", year: 2026 },
    { availability: "available", id: "fitem_audio_allowed_01", itemKind: "track", mediaKind: "audio", nodeCount: 1, sourceCount: 1, sources: [source], title: "Allowed Song", year: 2026 }
  ];
  let listCalls = 0;
  const federation = { listItems: ({ authorizeItem, mediaKind }) => {
    listCalls += 1;
    return items.filter((item) => item.mediaKind === mediaKind && (!authorizeItem || authorizeItem(item.id)));
  } };
  const authorization = { canAccessItem: (context, itemId) => context?.user?.id === "member_allowed_01" && itemId.includes("allowed") };
  const accounts = { getWatchlist: () => new Set(), migrateLegacyWatchlist: () => undefined };
  const cinema = createCinemaRoutes(storage, accounts, { federation, federationAuthorization: authorization });
  const music = createMusicRoutes(storage, accounts, { federation, federationAuthorization: authorization });
  const server = createServer(async (request, response) => {
    const role = request.headers["x-test-role"];
    request.nebulaAuth = role === "guest" ? { kind: "guest", user: null }
      : { kind: "account", user: { id: role === "allowed" ? "member_allowed_01" : "member_denied_01", role: "member" } };
    const url = new URL(request.url, "http://nebula");
    if (!await cinema(request, response, url) && !await music(request, response, url)) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });

  const library = (route, role) => fetch(`${origin}${route}`, { headers: { "x-test-role": role } }).then((response) => response.json());
  assert.deepEqual((await library("/api/cinema/library", "allowed")).entries.map(({ title }) => title), ["Allowed Film"]);
  assert.deepEqual((await library("/api/cinema/library", "denied")).entries, []);
  assert.deepEqual((await library("/api/music/library", "allowed")).entries.map(({ title }) => title), ["Allowed Song"]);
  const callsBeforeGuest = listCalls;
  assert.deepEqual((await library("/api/cinema/library", "guest")).entries, []);
  assert.equal(listCalls, callsBeforeGuest, "guest browsing must not query the federated projection");
});
