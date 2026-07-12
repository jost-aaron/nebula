import { BackupError } from "./errors.mjs";
import { json, readBody } from "../http.mjs";
import { actorFromContext } from "../audit/service.mjs";

const summarizeManifest = (manifest) => ({
  backupId: manifest.backupId,
  createdAt: manifest.createdAt,
  databaseFile: manifest.databaseFile ?? null,
  fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
  format: manifest.format,
  formatVersion: manifest.formatVersion,
  includesContentMedia: manifest.includesContentMedia === true,
  invalid: manifest.invalid === true,
  metadataCacheFiles: Array.isArray(manifest.files) ? manifest.files.filter(({ role }) => role === "metadata-cache").length : 0,
  migrationCount: Array.isArray(manifest.migrations) ? manifest.migrations.length : 0
});

const backupErrorStatus = (error) => {
  if (!(error instanceof BackupError)) return error.status ?? 500;
  if (error.code === "already_exists") return 409;
  if (error.code === "cancelled") return 408;
  if (error.code === "invalid_id") return 400;
  return 422;
};

const rethrowRouteError = (error) => {
  if (error instanceof BackupError) {
    error.status = backupErrorStatus(error);
    error.expose = true;
  }
  throw error;
};

export const createBackupRoutes = (service, audit = null) => async (request, response, url) => {
  if (request.method === "GET" && url.pathname === "/api/admin/backups") {
    try {
      const backups = await service.list();
      json(response, 200, { backups: backups.map(summarizeManifest) });
      return true;
    } catch (error) {
      rethrowRouteError(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/admin/backups") {
    try {
      const body = await readBody(request);
      const manifest = await service.create({ backupId: body.backupId });
      audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: "backup.created", outcome: "success", target: { type: "backup", id: manifest.backupId }, metadata: { requestedBy: "manual" } });
      json(response, 201, { backup: summarizeManifest(manifest) });
      return true;
    } catch (error) {
      audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: "backup.created", outcome: "failure", metadata: { requestedBy: "manual" } });
      rethrowRouteError(error);
    }
  }

  const match = /^\/api\/admin\/backups\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u.exec(url.pathname);
  if (request.method === "GET" && match) {
    try {
      const { manifest, schema } = await service.inspect({ backupId: match[1] });
      audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: "backup.inspected", outcome: "success", target: { type: "backup", id: match[1] }, metadata: { requestedBy: "manual" } });
      json(response, 200, {
        backup: summarizeManifest(manifest),
        validation: {
          migrations: schema.migrations,
          tables: schema.tables,
          valid: true
        }
      });
      return true;
    } catch (error) {
      audit?.recordBestEffort({ actor: actorFromContext(request.nebulaAuth), eventType: "backup.inspected", outcome: "failure", target: { type: "backup", id: match[1] }, metadata: { requestedBy: "manual" } });
      rethrowRouteError(error);
    }
  }

  return false;
};
