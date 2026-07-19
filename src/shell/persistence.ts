const SHELL_PREFERENCES_KEY = "nebula.shell.preferences";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface ShellPreferencesV2 {
  version: 2;
  principalId: string;
  focusedAppId: string;
}

interface LegacyShellPreferencesV1 {
  version: 1;
  principalId: string;
  focusedIndex: number;
}

export const loadFocusedAppId = (
  storage: StorageLike,
  principalId: string,
  appIds: readonly string[]
): string | null => {
  let parsed: unknown;

  try {
    const value = storage.getItem(SHELL_PREFERENCES_KEY);
    parsed = value ? JSON.parse(value) : null;
  } catch {
    try { storage.removeItem(SHELL_PREFERENCES_KEY); } catch { /* Storage can be unavailable in privacy modes. */ }
    return null;
  }

  if (!parsed || typeof parsed !== "object" || !("version" in parsed) || !("principalId" in parsed)) {
    return null;
  }

  const record = parsed as {
    version?: unknown;
    principalId?: unknown;
    focusedAppId?: unknown;
    focusedIndex?: unknown;
  };
  if (record.principalId !== principalId) {
    return null;
  }

  if (record.version === 2 && typeof record.focusedAppId === "string") {
    return appIds.includes(record.focusedAppId) ? record.focusedAppId : null;
  }

  if (record.version === 1 && Number.isInteger(record.focusedIndex)) {
    const focusedAppId = appIds[record.focusedIndex as number];
    if (focusedAppId) {
      saveFocusedAppId(storage, principalId, focusedAppId);
      return focusedAppId;
    }
  }

  return null;
};

export const saveFocusedAppId = (storage: StorageLike, principalId: string, focusedAppId: string) => {
  const preferences: ShellPreferencesV2 = { version: 2, principalId, focusedAppId };
  try { storage.setItem(SHELL_PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Preference persistence is best-effort. */ }
};

export const shellPreferencesKey = SHELL_PREFERENCES_KEY;
