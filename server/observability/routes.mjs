import { renderPrometheusMetrics, renderTranscodeAccelerationMetrics } from "./metrics.mjs";

const json = (response, status, body) => {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

const forbidden = (response) => json(response, 403, { error: "Admin authorization required." });

export const createObservabilityRoutes = ({ service, isAdmin = () => false, transcodeStatus = async () => ({}) } = {}) => async (request, response, url) => {
  if (request.method === "GET" && url.pathname === "/healthz") {
    json(response, 200, service.liveness());
    return true;
  }
  if (request.method === "GET" && url.pathname === "/readyz") {
    const state = await service.readiness();
    json(response, state.ready ? 200 : 503, { ready: state.ready });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/admin/observability/readiness") {
    if (!await isAdmin(request, url)) { forbidden(response); return true; }
    const state = await service.readiness();
    json(response, state.ready ? 200 : 503, state);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/metrics") {
    if (!await isAdmin(request, url)) { forbidden(response); return true; }
    const readiness = await service.readiness();
    response.writeHead(200, { "cache-control": "no-store", "content-type": "text/plain; version=0.0.4; charset=utf-8" });
    response.end(renderPrometheusMetrics({ readiness, uptimeSeconds: service.uptimeSeconds() }) + renderTranscodeAccelerationMetrics(await transcodeStatus().catch(() => ({}))));
    return true;
  }
  return false;
};
