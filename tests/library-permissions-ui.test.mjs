import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const account = await readFile(new URL("../src/account/accountUi.ts", import.meta.url), "utf8");
const permissions = await readFile(new URL("../src/account/libraryPermissionsUi.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("owner Account Settings integrates focused library permission administration", () => {
  assert.match(account, /session\.user\.role === "owner"/);
  assert.match(account, /renderLibraryPermissionsPanel\(\)/);
  assert.match(account, /bindLibraryPermissionsPanel\(container\)/);
  assert.match(permissions, /All current and future libraries/);
  assert.match(permissions, /Only selected libraries/);
  assert.match(permissions, /Files access is managed separately/);
  assert.match(permissions, /saveMemberLibraryPermissions/);
});

test("phone layout stacks member policies and library choices without horizontal overflow", () => {
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.account-library-permission-card \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.account-library-options \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.account-library-permission-card > button \{ width: 100%; \}/);
});
