import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("account bearer sessions use the native Keychain and never localStorage", async () => {
  const [http, storage, swift] = await Promise.all([
    read("src/api/http.ts"),
    read("src/native/nativeSessionStorage.ts"),
    read("ios/App/App/NativeSessionKeychainPlugin.swift")
  ]);
  assert.doesNotMatch(http, /localStorage\.(?:getItem|setItem)\([^\n]*accountSession/i);
  assert.match(storage, /registerPlugin<KeychainPlugin>\("NativeSessionKeychain"\)/);
  assert.match(storage, /removeLegacyTokens/);
  assert.match(storage, /storage\.removeItem\(key\)/);
  assert.match(swift, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
  assert.match(swift, /SecItemDelete/);
  assert.doesNotMatch(swift, /print\(|CAPLog/);
});

test("native session lifecycle is fail-closed and scoped to the selected server", async () => {
  const [http, storage, account] = await Promise.all([
    read("src/api/http.ts"),
    read("src/native/nativeSessionStorage.ts"),
    read("src/api/accountApi.ts")
  ]);
  assert.match(http, /if \(previous !== next\)[\s\S]*nativeSessionStorage\.clear\(previous\)/);
  assert.match(http, /accountSessionToken = "";[\s\S]*throw new Error\("Secure session storage is unavailable/);
  assert.match(storage, /if \(!options\.native \|\| !server\) return ""/);
  assert.match(storage, /catch \{[\s\S]*return ""/);
  assert.match(storage, /BLOCKED_PREFIX/);
  assert.match(storage, /Keep the non-secret marker and fail closed/);
  assert.match(account, /await setAccountSessionToken\(session\.sessionToken\)/);
  assert.match(account, /await setAccountSessionToken\(""\)/);
  assert.match(account, /if \(result\.currentRevoked\) await setAccountSessionToken\(""\)/);
});
