const apiMethods = "GET,POST,PUT,DELETE,OPTIONS";
const apiHeaders = "authorization,content-type,range";

export const applyApiCorsHeaders = (request, response) => {
  const origin = request.headers.origin;

  if (!origin) {
    return;
  }

  response.setHeader("access-control-allow-origin", origin);
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
