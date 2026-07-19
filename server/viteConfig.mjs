const exactHostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export const parseExactViteAllowedHosts = (value = "") => String(value)
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean)
  .map((host) => {
    if (!exactHostname.test(host) || host.includes("*") || host.startsWith(".")) {
      throw new Error(`NEBULA_VITE_ALLOWED_HOSTS must contain exact hostnames only: ${host}`);
    }
    return host.toLowerCase();
  });

export const createViteServerOptions = (env = process.env) => {
  const allowedHosts = parseExactViteAllowedHosts(env.NEBULA_VITE_ALLOWED_HOSTS);
  return {
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    hmr: env.NEBULA_VITE_HMR === "false" ? false : { host: "127.0.0.1" }
  };
};

const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const normalizeRequestHost = (value) => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 0 && (end === raw.length - 1 || /^:\d+$/.test(raw.slice(end + 1))) ? raw.slice(1, end) : null;
  }
  const separator = raw.lastIndexOf(":");
  const host = separator > -1 && /^\d+$/.test(raw.slice(separator + 1)) ? raw.slice(0, separator) : raw;
  if (ipv4.test(host)) return host.split(".").every((part) => Number(part) <= 255) ? host : null;
  return exactHostname.test(host) ? host : null;
};

export const createExactViteHostGuard = ({
  configuredHosts = parseExactViteAllowedHosts(process.env.NEBULA_VITE_ALLOWED_HOSTS),
  dynamicHost = () => null
} = {}) => {
  const fixed = new Set(["localhost", "127.0.0.1", "::1", ...configuredHosts]);
  return (request, response) => {
    const host = normalizeRequestHost(request.headers?.host);
    const published = dynamicHost();
    if (host && (fixed.has(host) || (published && host === published.toLowerCase()) || ipv4.test(host))) return true;
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("Blocked request. This host is not allowed.\n");
    return false;
  };
};
