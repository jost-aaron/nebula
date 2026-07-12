import { Capacitor, registerPlugin } from "@capacitor/core";

const LEGACY_PREFIX = "nebula.accountSessionToken:";
const BLOCKED_PREFIX = "nebula.accountSessionBlocked:";

type KeychainResult = { value?: string };
type KeychainPlugin = {
  get(options: { account: string }): Promise<KeychainResult>;
  remove(options: { account: string }): Promise<void>;
  set(options: { account: string; value: string }): Promise<void>;
};

const NativeSessionKeychain = registerPlugin<KeychainPlugin>("NativeSessionKeychain");

export type NativeSessionStorage = {
  clear(server: string): Promise<void>;
  initialize(server: string): Promise<string>;
  set(server: string, token: string): Promise<void>;
};

export const isNativeSessionClient = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";

const removeLegacyTokens = (storage: Storage) => {
  const tokens = new Map<string, string>();
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key?.startsWith(LEGACY_PREFIX)) continue;
    tokens.set(key.slice(LEGACY_PREFIX.length), storage.getItem(key) ?? "");
    storage.removeItem(key);
  }
  return tokens;
};

export const createNativeSessionStorage = (options: {
  keychain: KeychainPlugin;
  native: boolean;
  storage: Storage;
}): NativeSessionStorage => ({
  async clear(server) {
    if (!options.native || !server) return;
    const blockedKey = `${BLOCKED_PREFIX}${server}`;
    options.storage.setItem(blockedKey, "1");
    await options.keychain.remove({ account: server });
    options.storage.removeItem(blockedKey);
  },
  async initialize(server) {
    const legacy = removeLegacyTokens(options.storage);
    if (!options.native || !server) return "";
    const blockedKey = `${BLOCKED_PREFIX}${server}`;
    if (options.storage.getItem(blockedKey)) {
      try {
        await options.keychain.remove({ account: server });
        options.storage.removeItem(blockedKey);
      } catch { /* Keep the non-secret marker and fail closed. */ }
      return "";
    }
    const oldToken = legacy.get(server) ?? "";
    if (oldToken) {
      try {
        await options.keychain.set({ account: server, value: oldToken });
      } catch {
        // The insecure copy has already been removed. Fail closed and require sign-in.
        return "";
      }
    }
    try {
      return (await options.keychain.get({ account: server })).value ?? "";
    } catch {
      return "";
    }
  },
  async set(server, token) {
    if (!options.native || !server) return;
    if (token) {
      await options.keychain.set({ account: server, value: token });
      options.storage.removeItem(`${BLOCKED_PREFIX}${server}`);
    } else {
      const blockedKey = `${BLOCKED_PREFIX}${server}`;
      options.storage.setItem(blockedKey, "1");
      await options.keychain.remove({ account: server });
      options.storage.removeItem(blockedKey);
    }
  }
});

export const nativeSessionStorage = createNativeSessionStorage({
  keychain: NativeSessionKeychain,
  native: isNativeSessionClient(),
  storage: window.localStorage
});
