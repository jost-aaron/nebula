import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAccountStore } from "../server/accountStore.mjs";
import { applyCatalogMigration, bootstrapSharedContentRoot, createCatalogRepository, scanLocalRoot } from "../server/catalog/index.mjs";
import { applyDomainMigrations } from "../server/database.mjs";
import { createLibraryPermissionsService, libraryPermissionsMigration } from "../server/permissions/index.mjs";
import { createSubtitleService, subtitleMigration } from "../server/subtitles/index.mjs";

const password = "subtitle password secure";
const fixture = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-subtitles-"));
  const contentRoot = path.join(root, "content");
  await mkdir(contentRoot);
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys=ON");
  const accounts = await createAccountStore({ database }); applyCatalogMigration(database); applyDomainMigrations(database, [libraryPermissionsMigration, subtitleMigration]);
  const catalog = createCatalogRepository(database); const { root: catalogRoot } = bootstrapSharedContentRoot(catalog, { contentRoot });
  await writeFile(path.join(contentRoot, "Movie.mp4"), "video");
  await writeFile(path.join(contentRoot, "Movie.en.default.vtt"), "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n");
  await writeFile(path.join(contentRoot, "Movie.es.forced.srt"), "1\n00:00:00,000 --> 00:00:01,000\nHola\n");
  await writeFile(path.join(contentRoot, "Other.en.vtt"), "WEBVTT\n");
  await symlink(path.join(root, "outside.vtt"), path.join(contentRoot, "Movie.fr.vtt"));
  await writeFile(path.join(root, "outside.vtt"), "WEBVTT\n");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository: catalog, rootId: catalogRoot.id });
  const media = catalog.resolveContentPath("Movie.mp4", catalogRoot.id);
  const owner = await accounts.setupOwner({ clientLabel: "test", displayName: "Owner", password, username: "owner" });
  const member = await accounts.createMember({ displayName: "Member", password, username: "member" });
  const permissions = createLibraryPermissionsService({ database });
  const service = createSubtitleService({ database, contentRoot, resolveSource: ({ itemId, sourceId }, principal) => {
    const source = catalog.getSource(sourceId); return source?.itemId === itemId && permissions.canAccessItem(principal, itemId) ? source : null;
  }, probeReader: { get: () => ({ streams: [{ type: "subtitle", index: 3, codec: "ass", language: "ja", forced: false, default: false, title: "Japanese" }] }) }, canAccessItem: (principal, itemId) => permissions.canAccessItem(principal, itemId) });
  t.after(async () => { accounts.close(); database.close(); await rm(root, { recursive: true, force: true }); });
  return { service, ids: { itemId: media.item.id, sourceId: media.id }, owner: { type: "user", userId: owner.user.id }, member: { type: "user", userId: member.id }, guest: { type: "guest", sessionId: "guest-a" }, permissions, libraryId: catalogRoot.library_id };
};

test("discovers opaque stable embedded and safe sidecar tracks without paths", async (t) => {
  const f = await fixture(t); const first = await f.service.selection(f.ids, f.owner); const second = await f.service.selection(f.ids, f.owner);
  assert.equal(first.tracks.length, 3); assert.deepEqual(first.tracks, second.tracks);
  assert.deepEqual(first.tracks.map((track) => [track.kind, track.language, track.forced, track.default]), [["sidecar", "es", true, false], ["sidecar", "en", false, true], ["embedded", "ja", false, false]]);
  assert.equal(JSON.stringify(first.tracks).includes("Movie"), false); assert.ok(first.tracks.every(({ id }) => /^sub_[A-Za-z0-9_-]+$/.test(id)));
});

test("preferences are ordered, isolated, validated, and guests never persist", async (t) => {
  const f = await fixture(t); assert.deepEqual(f.service.setPreference({ mode: "preferred", languages: ["es", "en-US"] }, f.owner).languages, ["es", "en-us"]);
  assert.deepEqual(f.service.getPreference(f.member), { mode: "off", languages: [], persistent: true });
  assert.equal((await f.service.selection(f.ids, f.owner)).track.language, "es");
  assert.throws(() => f.service.setPreference({ mode: "preferred", languages: ["../../etc"] }, f.owner), { code: "invalid_language" });
  assert.throws(() => f.service.setPreference({ mode: "off", languages: [] }, f.guest), { code: "guest_non_persistent" });
  const english = (await f.service.selection(f.ids, f.guest)).tracks.find(({ language }) => language === "en");
  await f.service.setEphemeralSelection(f.ids, english.id, f.guest); assert.equal((await f.service.selection(f.ids, f.guest)).track.id, english.id);
  assert.deepEqual(f.service.getPreference(f.guest), { mode: "off", languages: [], persistent: false });
});

test("library denial and provider boundary fail closed", async (t) => {
  const f = await fixture(t); f.permissions.setMemberAccess(f.member.userId, { mode: "selected", libraryIds: [] });
  await assert.rejects(f.service.discover(f.ids, f.member), { code: "item_not_found" });
  assert.deepEqual(f.service.providerStatus().providers, []); assert.throws(() => f.service.setProviderConfig({ enabled: true }), { code: "provider_unavailable" });
});
