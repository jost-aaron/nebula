const API_BASE_STORAGE_KEY = "nebula.apiBaseUrl";
const API_TOKEN_STORAGE_KEY = "nebula.apiToken";

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

export const setApiBaseUrl = (url: string) => {
  const normalized = url.trim().replace(/\/+$/, "");

  if (normalized) {
    window.localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
  } else {
    window.localStorage.removeItem(API_BASE_STORAGE_KEY);
  }
};

export const apiUrl = (path: string) => `${configuredApiBase()}${path}`;

export const getApiToken = () => window.localStorage.getItem(API_TOKEN_STORAGE_KEY) ?? "";

export const setApiToken = (token: string) => {
  const normalized = token.trim();

  if (normalized) {
    window.localStorage.setItem(API_TOKEN_STORAGE_KEY, normalized);
  } else {
    window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
  }
};

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getApiToken();
  const headers = new Headers(init?.headers);

  if (token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`);
  }

  headers.set("content-type", headers.get("content-type") ?? "application/json");

  const response = await fetch(apiUrl(path), {
    ...init,
    headers
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}
