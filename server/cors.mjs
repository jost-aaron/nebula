const apiMethods = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
const apiHeaders = "authorization,content-type,range,x-nebula-csrf";
const defaultAllowedOrigins = [
  "capacitor://localhost",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

const allowedOrigins = () => new Set([
  ...defaultAllowedOrigins,
  ...(process.env.NEBULA_CORS_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean)
]);

export const applyApiCorsHeaders = (request, response) => {
  const origin = request.headers.origin;

  if (!origin || !allowedOrigins().has(origin)) {
    return;
  }

  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-allow-methods", apiMethods);
  response.setHeader("access-control-allow-headers", apiHeaders);
  response.setHeader("access-control-expose-headers", "content-length,content-range,content-type");
  response.setHeader("vary", "Origin");
};

export const handleApiPreflight = (request, response) => {
  if (request.method !== "OPTIONS") {
    return false;
  }

  response.writeHead(204);
  response.end();
  return true;
};
