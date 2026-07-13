import { json, readBody } from "../http.mjs";
import { actorFromContext } from "../audit/service.mjs";

export const createJobsRoutes = (service, audit = null) => async (request, response, url) => {
  if (request.method === "GET" && url.pathname === "/api/jobs") {
    json(response, 200, { jobs: service.list({ limit: Number(url.searchParams.get("limit") || 50), state: url.searchParams.get("state"), type: url.searchParams.get("type") }) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/jobs") {
    const body = await readBody(request);
    try {
      if (body?.type === "rendition") throw Object.assign(new Error("Rendition jobs must be requested from a media title."), { status: 400, expose: true });
      const result = service.enqueue(body);
      audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: "job.enqueued", outcome: "success", target: { type: "job", id: result.job.id }, metadata: { created: result.created, jobType: result.job.type, requestedBy: "manual" } });
      json(response, 202, result);
    } catch (error) {
      audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: "job.enqueued", outcome: "failure", metadata: { jobType: body?.type, requestedBy: "manual" } });
      throw error;
    }
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
    audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: "job.cancel_requested", outcome: job ? "success" : "failure", target: { type: "job", id: match[1] }, metadata: job ? { jobType: job.type, requestedBy: "manual" } : { requestedBy: "manual" } });
    json(response, job ? 200 : 404, job ? { job } : { error: "Job not found." });
    return true;
  }
  return false;
};
