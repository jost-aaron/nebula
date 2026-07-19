import { json, readBody } from "../http.mjs";

const sendError = (response, error) => json(response, error.status ?? 500, {
  ...(error.code ? { code: error.code } : {}),
  error: (error.status ?? 500) >= 500 && !error.expose ? "Server operation failed." : error.message
});

export const createClusterIngressRoutes = (options) => {
  const service = options?.service ?? options;
  const manifest = options?.manifest ?? null;
  return async (request, response, url) => {
  if (!url.pathname.startsWith("/api/shard/v1/")) return false;
  try {
    if (request.method === "POST" && url.pathname === "/api/shard/v1/pair") {
      json(response, 201, service.acceptPairing(await readBody(request, { limit: 64 * 1024 })));
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/shard/v1/health") {
      const body = await readBody(request, { limit: 64 * 1024 });
      const peer = service.verifyRequest(body.envelope, body.payload, { method: request.method, path: url.pathname });
      json(response, 200, { clusterId: service.identity().clusterId, node: service.identity().descriptor, peer: { nodeId: peer.nodeId }, status: "online" });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/shard/v1/manifest" && manifest) {
      const body = await readBody(request, { limit: 64 * 1024 });
      const payload = body?.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || Object.keys(payload).some((key) => !new Set(["cursor", "limit"]).has(key))) {
        throw Object.assign(new Error("Manifest request is invalid."), { status: 400, code: "invalid_manifest_request", expose: true });
      }
      service.verifyRequest(body.envelope, payload, { method: request.method, path: url.pathname });
      const page = manifest.page(payload);
      json(response, 200, { envelope: service.signRequest({ body: page, method: "POST", path: url.pathname }), payload: page });
      return true;
    }
    json(response, 404, { code: "shard_route_not_found", error: "Shard route not found." });
    return true;
  } catch (error) {
    sendError(response, error);
    return true;
  }
  };
};

export const createClusterAdminRoutes = ({ service, pairingClient, federation = null, sync = null, audit = null }) => async (request, response, url) => {
  if (!url.pathname.startsWith("/api/admin/cluster")) return false;
  if (request.method === "GET" && url.pathname === "/api/admin/cluster") {
    json(response, 200, { identity: service.identity(), nodes: service.listNodes() });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/admin/cluster/items" && federation) {
    json(response, 200, { items: federation.listItems({ mediaKind: url.searchParams.get("mediaKind") || undefined }) });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/admin/cluster/dedupe-conflicts" && federation) {
    json(response, 200, { conflicts: federation.listConflicts() });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/admin/cluster/dedupe-overrides" && federation) {
    const result = federation.setOverride(await readBody(request, { limit: 16 * 1024 }));
    audit?.recordBestEffort({ actor: { kind: "system" }, eventType: "cluster.dedupe_override", outcome: "success", target: { type: "federated-item", id: result.targetItemId }, metadata: { action: result.action } });
    json(response, 201, result);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/admin/cluster/pairing-code") {
    const result = service.createPairingCode();
    audit?.recordBestEffort({ actor: { kind: "system" }, eventType: "cluster.pairing_code_created", outcome: "success" });
    json(response, 201, result);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/admin/cluster/nodes") {
    const body = await readBody(request, { limit: 16 * 1024 });
    const accepted = await pairingClient.pair({ endpoint: body.endpoint, pairingCode: body.pairingCode, localIdentity: service.identity() });
    const node = service.registerPairedNode(accepted);
    audit?.recordBestEffort({ actor: { kind: "system" }, eventType: "cluster.node_paired", outcome: "success", target: { type: "cluster-node", id: node.nodeId } });
    json(response, 201, { node });
    return true;
  }
  const nodeMatch = /^\/api\/admin\/cluster\/nodes\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  const syncMatch = /^\/api\/admin\/cluster\/nodes\/([A-Za-z0-9_-]+)\/sync$/.exec(url.pathname);
  if (request.method === "POST" && syncMatch && sync) {
    const result = await sync.syncNode(syncMatch[1]);
    audit?.recordBestEffort({ actor: { kind: "system" }, eventType: "cluster.manifest_synced", outcome: "success", target: { type: "cluster-node", id: syncMatch[1] }, metadata: { manifestRevision: result.manifestRevision } });
    json(response, 200, result);
    return true;
  }
  if (request.method === "DELETE" && nodeMatch) {
    service.revokeNode(nodeMatch[1]);
    audit?.recordBestEffort({ actor: { kind: "system" }, eventType: "cluster.node_revoked", outcome: "success", target: { type: "cluster-node", id: nodeMatch[1] } });
    response.writeHead(204); response.end();
    return true;
  }
  return false;
};
