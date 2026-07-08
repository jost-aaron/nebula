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

export const apiHeaders = (headers?: HeadersInit) => {
  const token = getApiToken();
  const nextHeaders = new Headers(headers);

  if (token && !nextHeaders.has("authorization")) {
    nextHeaders.set("authorization", `Bearer ${token}`);
  }

  return nextHeaders;
};

export const apiFetch = (path: string, init?: RequestInit) =>
  fetch(apiUrl(path), {
    ...init,
    headers: apiHeaders(init?.headers)
  });

export const applyApiHeadersToRequest = (request: XMLHttpRequest, headers?: HeadersInit) => {
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
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(body.error ?? `API request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}
