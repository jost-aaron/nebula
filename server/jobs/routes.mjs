import { json, readBody } from "../http.mjs";

export const createJobsRoutes = (service) => async (request, response, url) => {
  if (request.method === "GET" && url.pathname === "/api/jobs") {
    json(response, 200, { jobs: service.list({ limit: Number(url.searchParams.get("limit") || 50), state: url.searchParams.get("state"), type: url.searchParams.get("type") }) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/jobs") {
    json(response, 202, service.enqueue(await readBody(request)));
    return true;
  }
  const match = /^\/api\/jobs\/([0-9a-f-]{36})(\/cancel)?$/i.exec(url.pathname);
  if (match && request.method === "GET" && !match[2]) {
    const job = service.get(match[1]);
    json(response, job ? 200 : 404, job ? { job } : { error: "Job not found." });
    return true;
  }
  if (match && request.method === "POST" && match[2]) {
    const job = service.cancel(match[1]);
    json(response, job ? 200 : 404, job ? { job } : { error: "Job not found." });
    return true;
  }
  return false;
};
