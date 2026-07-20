const API_BASE_STORAGE_KEY = "nebula.apiBaseUrl";
const API_TOKEN_STORAGE_KEY = "nebula.apiToken";
import { nativeSessionStorage } from "../native/nativeSessionStorage";
let csrfToken = "";
let accountSessionToken = "";

const configuredApiBase = () => {
  const stored = window.localStorage.getItem(API_BASE_STORAGE_KEY);
  return stored ?? import.meta.env.VITE_API_BASE_URL ?? "";
};

export const getApiBaseUrl = () => configuredApiBase();

export const getAppOrigin = () => window.location.origin;

export const getEffectiveApiBaseUrl = () => {
  const configured = configuredApiBase();

  if (configured) {
    return configured;
  }

  if (window.location.protocol === "http:" || window.location.protocol === "https:") {
    return window.location.origin;
  }

  return "";
};

export const getApiConnectionMode = () => {
  if (configuredApiBase()) {
    return "Configured server";
  }

  if (window.location.protocol === "http:" || window.location.protocol === "https:") {
    return "Same origin";
  }

  return "Needs server URL";
};

export const setApiBaseUrl = async (url: string) => {
  const previous = configuredApiBase() || window.location.origin;
  const normalized = url.trim().replace(/\/+$/, "");

  if (normalized) {
    window.localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
  } else {
    window.localStorage.removeItem(API_BASE_STORAGE_KEY);
  }
  const next = configuredApiBase() || window.location.origin;
  if (previous !== next) {
    await nativeSessionStorage.clear(previous).catch(() => undefined);
    accountSessionToken = "";
  }
};

export const apiUrl = (path: string) => /^https?:\/\//i.test(path) ? path : `${configuredApiBase()}${path}`;

export const getApiToken = () => window.localStorage.getItem(API_TOKEN_STORAGE_KEY) ?? "";
const accountSessionServer = () => configuredApiBase() || window.location.origin;
export const initializeAccountSession = async () => {
  accountSessionToken = await nativeSessionStorage.initialize(accountSessionServer());
};
export const getAccountSessionToken = () => accountSessionToken;
export const setAccountSessionToken = async (token: string) => {
  accountSessionToken = token;
  try {
    await nativeSessionStorage.set(accountSessionServer(), token);
  } catch {
    accountSessionToken = "";
    throw new Error("Secure session storage is unavailable. Unlock the device and sign in again.");
  }
};
export const setCsrfToken = (token: string | null) => { csrfToken = token ?? ""; };

export const setApiToken = (token: string) => {
  const normalized = token.trim();

  if (normalized) {
    window.localStorage.setItem(API_TOKEN_STORAGE_KEY, normalized);
  } else {
    window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
  }
};

export const apiHeaders = (headers?: HeadersInit) => {
  const token = getAccountSessionToken() || getApiToken();
  const nextHeaders = new Headers(headers);

  if (token && !nextHeaders.has("authorization")) {
    nextHeaders.set("authorization", `Bearer ${token}`);
  }

  if (csrfToken && !nextHeaders.has("x-nebula-csrf")) {
    nextHeaders.set("x-nebula-csrf", csrfToken);
  }

  return nextHeaders;
};

export const apiFetch = async (path: string, init?: RequestInit) => {
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: "include",
    headers: apiHeaders(init?.headers)
  });

  if (response.status === 401 && !["/api/auth/status", "/api/auth/login", "/api/auth/setup"].includes(path)) {
    window.dispatchEvent(new CustomEvent("nebula:session-expired"));
  }
  return response;
};

export const applyApiHeadersToRequest = (request: XMLHttpRequest, headers?: HeadersInit) => {
  request.withCredentials = true;
  apiHeaders(headers).forEach((value, key) => {
    request.setRequestHeader(key, value);
  });
};

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = apiHeaders(init?.headers);
  headers.set("content-type", headers.get("content-type") ?? "application/json");

  const response = await apiFetch(path, {
    ...init,
    headers
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as { code?: string; error?: string };
    throw new ApiError(body.error ?? `API request failed: ${response.status}`, response.status, body.code);
  }

  return (await response.json()) as T;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}
