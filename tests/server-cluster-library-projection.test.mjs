import assert from "node:assert/strict";
import test from "node:test";
import { canBrowseFederatedLibrary, projectUnifiedLibrary } from "../server/cluster/index.mjs";

const localEntry = {
  category: "movies", id: "item_local", mediaKind: "video", path: "Movies/local.mp4",
  playable: true, sourceId: "source_local", streamUrl: "/api/cinema/media?path=Movies%2Flocal.mp4", title: "Shared Film"
};

const source = (overrides = {}) => ({
  availability: "available",
  capabilities: { directPlay: true, renditionProfiles: [], transcode: true },
  height: 1080,
  id: "federated_source_1",
  local: false,
  localItemId: "item_remote",
  localSourceId: "source_remote",
  nodeName: "Basement",
  nodeState: "online",
  renditions: [],
  sourceRevision: 2,
  width: 1920,
  ...overrides
});

const item = (overrides = {}) => ({
  availability: "available",
  id: "federated_item_1",
  itemKind: "movie",
  mediaKind: "video",
  nodeCount: 1,
  sourceCount: 1,
  sources: [source()],
  title: "Remote Film",
  year: 2025,
  ...overrides
});

test("unified projection deduplicates local media and retains every shard source", () => {
  const shared = item({
    id: "federated_shared",
    nodeCount: 2,
    sourceCount: 2,
    sources: [
      source({ id: "federated_source_local", local: true, localItemId: "item_local", localSourceId: "source_local", nodeName: "Home" }),
      source({ id: "federated_source_remote" })
    ],
    title: "Shared Film"
  });
  const projected = projectUnifiedLibrary({ entries: [localEntry], federation: { listItems: () => [shared] }, mediaKind: "video" });
  assert.equal(projected.length, 1);
  assert.equal(projected[0].path, localEntry.path);
  assert.equal(projected[0].playable, true);
  assert.equal(projected[0].federation.nodeCount, 2);
  assert.deepEqual(projected[0].federation.sources.map(({ nodeName }) => nodeName), ["Home", "Basement"]);
});

test("remote-only direct media is playable without manufacturing a stream URL", () => {
  const projected = projectUnifiedLibrary({ entries: [], federation: { listItems: () => [item()] }, mediaKind: "video" });
  assert.equal(projected.length, 1);
  assert.equal(projected[0].path, "federated:federated_item_1");
  assert.equal(projected[0].playable, true);
  assert.equal(projected[0].streamUrl, "");
  assert.equal(projected[0].sourceId, undefined);
  assert.doesNotMatch(JSON.stringify(projected), /https?:\/\/|\/private|digest|publicKey/i);
});

test("standalone libraries pass through and federation browsing is role gated", () => {
  const entries = [localEntry];
  assert.strictEqual(projectUnifiedLibrary({ entries, federation: null, mediaKind: "video" }), entries);
  assert.equal(canBrowseFederatedLibrary({ kind: "account", user: { role: "owner" } }), true);
  assert.equal(canBrowseFederatedLibrary({ kind: "service" }), true);
  assert.equal(canBrowseFederatedLibrary({ kind: "account", user: { role: "member" } }), false);
  assert.equal(canBrowseFederatedLibrary({ kind: "account", user: { role: "member" } }, () => true), true);
  assert.equal(canBrowseFederatedLibrary({ kind: "guest" }), false);
});

test("member projection authorizes logical items before loading source details", () => {
  const requested = [];
  const federation = {
    listItems({ authorizeItem }) {
      return [item({ id: "allowed_item_01" }), item({ id: "denied_item_01", title: "Secret title" })].filter((value) => {
        requested.push(value.id);
        return authorizeItem(value.id);
      });
    }
  };
  const projected = projectUnifiedLibrary({
    authorizeItem: (itemId) => itemId === "allowed_item_01",
    entries: [], federation, mediaKind: "video"
  });
  assert.deepEqual(requested, ["allowed_item_01", "denied_item_01"]);
  assert.deepEqual(projected.map(({ id }) => id), ["allowed_item_01"]);
  assert.doesNotMatch(JSON.stringify(projected), /Secret title|denied_item_01/);
});
