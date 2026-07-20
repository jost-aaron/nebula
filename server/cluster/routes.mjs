import { json, readBody } from "../http.mjs";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { parseByteRange } from "../ranges.mjs";
import { mimeType } from "../storage.mjs";
import { resolveRemuxSourcePath } from "../remux/index.mjs";
import path from "node:path";

const sendError = (response, error) => json(response, error.status ?? 500, {
  ...(error.code ? { code: error.code } : {}),
  error: (error.status ?? 500) >= 500 && !error.expose ? "Server operation failed." : error.message
});

export const createClusterIngressRoutes = (options) => {
  const service = options?.service ?? options;
  const manifest = options?.manifest ?? null;
  const grants = options?.grants ?? null;
  const shardDelivery = options?.shardDelivery ?? null;
  const contentRoot = options?.contentRoot ?? null;
  const subtitles = options?.subtitles ?? null;
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
      const page = await manifest.page(payload);
      json(response, 200, { envelope: service.signRequest({ body: page, method: "POST", path: url.pathname }), payload: page });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/shard/v1/playback/grants/validate" && grants) {
      json(response, 201, await grants.accept(await readBody(request, { limit: 64 * 1024 })));
      return true;
    }
    const deliveryOperation = new Map([
      ["/api/shard/v1/playback/delivery", "create"],
      ["/api/shard/v1/playback/delivery/status", "get"],
      ["/api/shard/v1/playback/delivery/cancel", "cancel"]
    ]).get(url.pathname);
    if (request.method === "POST" && deliveryOperation && shardDelivery) {
      const body = await readBody(request, { limit: 64 * 1024 });
      const peer = service.verifyRequest(body?.envelope, body?.payload, { method: request.method, path: url.pathname });
      const payload = await shardDelivery[deliveryOperation](body?.payload, peer);
      json(response, deliveryOperation === "create" ? 201 : 200, {
        envelope: service.signRequest({ body: payload, method: "POST", path: url.pathname }),
        payload
      });
      return true;
    }
    const mediaMatch = /^\/api\/shard\/v1\/media\/([A-Za-z0-9_-]+)\/(file|hls\/([^/]+)|subtitle\/([A-Za-z0-9_-]+))$/.exec(url.pathname);
    if (mediaMatch && grants && contentRoot && ["GET", "HEAD"].includes(request.method)) {
      const resolved = grants.resolve({ grantId: mediaMatch[1], method: request.method, ticket: url.searchParams.get("ticket") });
      let asset;
      let explicitType = null;
      let playlist = false;
      if (mediaMatch[4]) {
        if (!subtitles || !resolved.grant.subtitleId || mediaMatch[4] !== resolved.grant.subtitleId) throw Object.assign(new Error("Subtitle asset not found."), { status: 404, code: "subtitle_not_found", expose: true });
        const result = await subtitles.resolveAsset({ itemId: resolved.source.itemId, sourceId: resolved.source.id }, mediaMatch[4], { type: "service" });
        asset = result.path; explicitType = result.contentType;
      } else if (resolved.delivery) {
        if (!shardDelivery) throw Object.assign(new Error("Shard delivery is unavailable."), { status: 404, code: "delegated_media_not_found", expose: true });
        if (mediaMatch[2] === "file") {
          const result = await shardDelivery.resolveFile(resolved.delivery);
          asset = result.path; explicitType = result.type;
        } else {
          let assetName;
          try { assetName = decodeURIComponent(mediaMatch[3]); } catch { throw Object.assign(new Error("The requested delivery asset is invalid."), { status: 400, expose: true }); }
          asset = await shardDelivery.resolveHlsAsset(resolved.delivery, assetName);
          playlist = path.extname(asset) === ".m3u8";
          explicitType = playlist ? "application/vnd.apple.mpegurl" : "video/mp2t";
        }
      } else {
        if (mediaMatch[2] !== "file") throw Object.assign(new Error("Delegated media was not found."), { status: 404, code: "delegated_media_not_found", expose: true });
        asset = await resolveRemuxSourcePath(contentRoot, resolved.source.path);
      }
      const details = await stat(asset);
      const headers = { "accept-ranges": "bytes", "cache-control": playlist ? "no-store" : "private, no-store", "content-type": explicitType ?? mimeType(asset), "vary": "Origin" };
      if (request.headers.origin === resolved.clientOrigin) headers["access-control-allow-origin"] = resolved.clientOrigin;
      if (playlist) {
        if (details.size > 1024 * 1024) throw Object.assign(new Error("The generated playlist exceeded its size limit."), { status: 502, code: "invalid_delivery_playlist", expose: true });
        const raw = await readFile(asset, "utf8");
        const ticket = encodeURIComponent(url.searchParams.get("ticket"));
        const rewritten = raw.split("\n").map((line) => {
          if (!line) return line;
          if (line.startsWith("#")) {
            if (/URI\s*=/.test(line)) throw Object.assign(new Error("The generated playlist contains an unsupported embedded asset reference."), { status: 502, code: "invalid_delivery_playlist", expose: true });
            return line;
          }
          const parsed = new URL(line, "https://nebula.invalid/");
          if (parsed.origin !== "https://nebula.invalid" || parsed.hash || parsed.pathname.includes("..") || parsed.pathname.split("/").filter(Boolean).length !== 1) {
            throw Object.assign(new Error("The generated playlist contains an invalid asset reference."), { status: 502, code: "invalid_delivery_playlist", expose: true });
          }
          return `${line}${line.includes("?") ? "&" : "?"}ticket=${ticket}`;
        }).join("\n");
        response.writeHead(200, { ...headers, "content-length": Buffer.byteLength(rewritten) });
        response.end(request.method === "HEAD" ? undefined : rewritten);
        return true;
      }
      if (request.method === "HEAD") { response.writeHead(200, { ...headers, "content-length": details.size }); response.end(); return true; }
      const range = request.headers.range;
      if (!range) { response.writeHead(200, { ...headers, "content-length": details.size }); createReadStream(asset).pipe(response); return true; }
      const parsed = parseByteRange(range, details.size);
      if (!parsed.ok) { response.writeHead(416, { ...headers, "content-range": parsed.contentRange }); response.end(); return true; }
      response.writeHead(206, { ...headers, "content-length": parsed.end - parsed.start + 1, "content-range": `bytes ${parsed.start}-${parsed.end}/${details.size}` });
      createReadStream(asset, { start: parsed.start, end: parsed.end }).pipe(response);
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

export const createClusterAdminRoutes = ({ service, pairingClient, federation = null, sync = null, scheduler = null, audit = null }) => async (request, response, url) => {
  if (!url.pathname.startsWith("/api/admin/cluster")) return false;
  if (request.method === "GET" && url.pathname === "/api/admin/cluster") {
    const identity = service.identity();
    json(response, 200, { identity, nodes: service.listNodes({ includeLocal: true }).map((node) => ({
      ...node, load: scheduler?.nodeLoad(node.nodeId) ?? { activeStreams: 0, activeTranscodes: 0 },
      local: node.nodeId === identity.descriptor?.nodeId
    })) });
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
  if (request.method === "PATCH" && nodeMatch) {
    const node = service.updateNodeControls(nodeMatch[1], await readBody(request, { limit: 16 * 1024 }));
    audit?.recordBestEffort({ actor: { kind: "system" }, eventType: "cluster.node_controls_updated", outcome: "success", target: { type: "cluster-node", id: node.nodeId } });
    json(response, 200, { node });
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

export const createClusterPlaybackRoutes = (playback) => async (request, response, url) => {
  if (!url.pathname.startsWith("/api/cluster/playback-sessions")) return false;
  const user = request.nebulaAuth?.user;
  if (!user || user.role !== "owner") throw Object.assign(new Error("Federated playback currently requires an owner account."), { status: 403, code: "cluster_playback_denied", expose: true });
  const context = { accountId: user.id, clientOrigin: request.headers.origin ?? null };
  if (request.method === "POST" && url.pathname === "/api/cluster/playback-sessions") {
    json(response, 201, await playback.create(await readBody(request, { limit: 64 * 1024 }), context));
    return true;
  }
  const match = /^\/api\/cluster\/playback-sessions\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (match && request.method === "GET") { json(response, 200, await playback.get(match[1], context)); return true; }
  if (match && request.method === "DELETE") { await playback.release(match[1], context); response.writeHead(204); response.end(); return true; }
  const failover = /^\/api\/cluster\/playback-sessions\/([A-Za-z0-9_-]+)\/failover$/.exec(url.pathname);
  if (failover && request.method === "POST") {
    const body = await readBody(request, { limit: 8 * 1024 });
    json(response, 200, await playback.failover(failover[1], context, body?.failedNodeId));
    return true;
  }
  return false;
};
