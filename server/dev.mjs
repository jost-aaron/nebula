import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { createApiHandler } from "./api.mjs";
import { createAuthGuard } from "./auth.mjs";
import { applyApiCorsHeaders, handleApiPreflight } from "./cors.mjs";
import { createStorage } from "./storage.mjs";
import { createAccountStore } from "./accountStore.mjs";
import { createGuestService } from "./guest/service.mjs";
import { catalogMigration, bootstrapSharedContentRoot, createCatalogRepository, importLegacyCinemaMetadata, scanLocalRoot } from "./catalog/index.mjs";
import { openNebulaDatabase, applyDomainMigrations } from "./database.mjs";
import { createPlaybackRepository } from "./playback/repository.mjs";
import { createPlaybackService } from "./playback/service.mjs";
import { PLAYBACK_MIGRATION } from "./playback/schema.mjs";
import { createJobsRepository, createJobsService, createJobsWorker, createMediaJobHandlers, jobsMigration } from "./jobs/index.mjs";
import { createProbeCatalogReader, createProbeCatalogWriter, createProbeService, probeMigration } from "./probe/index.mjs";
import { createPlaybackPlanner } from "./playback-planner/index.mjs";
import { createRemuxService } from "./remux/index.mjs";
import { createTranscodeService } from "./transcode/index.mjs";
import { createDeliveryService } from "./playback/delivery.mjs";
import { createLibraryPermissionsService, libraryPermissionsMigration } from "./permissions/index.mjs";
import { createPlaybackPolicyRepository, createPlaybackPolicyService, playbackPolicyMigration } from "./playbackPolicy/index.mjs";
import { createBackupService } from "./backup/index.mjs";
import { auditMigration, createAuditService } from "./audit/index.mjs";
import { createMediaListsService, mediaListsMigration } from "./mediaLists/index.mjs";
import {
  createCatalogCheck,
  createDatabaseCheck,
  createDirectoryCheck,
  createDiskCheck,
  createObservabilityRoutes,
  createObservabilityService,
  createWorkerCheck
} from "./observability/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = path.join(root, "content");
const dataRoot = process.env.NEBULA_DATA_ROOT ? path.resolve(process.env.NEBULA_DATA_ROOT) : path.join(root, "data");
const backupRoot = process.env.NEBULA_BACKUP_ROOT ? path.resolve(process.env.NEBULA_BACKUP_ROOT) : path.join(dataRoot, "backups");
const restoreStagingRoot = process.env.NEBULA_RESTORE_STAGING_ROOT ? path.resolve(process.env.NEBULA_RESTORE_STAGING_ROOT) : path.join(dataRoot, "restore-staging");
const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? "0.0.0.0";
const viteAllowedHosts = (process.env.NEBULA_VITE_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim()).filter(Boolean);

const storage = await createStorage({ contentRoot, dataRoot });
const database = await openNebulaDatabase(storage.accountDatabasePath);
const accountStore = await createAccountStore({ database });
const guestService = createGuestService({ accountStore });
accountStore.setOwnerCreatedHook(() => guestService.revokeAll());
applyDomainMigrations(database, [catalogMigration, PLAYBACK_MIGRATION, probeMigration, jobsMigration, libraryPermissionsMigration, playbackPolicyMigration, auditMigration, mediaListsMigration]);
const auditService = createAuditService({
  db: database,
  maxEvents: Number(process.env.NEBULA_AUDIT_MAX_EVENTS ?? 10_000),
  retentionDays: Number(process.env.NEBULA_AUDIT_RETENTION_DAYS ?? 90)
});
const catalogRepository = createCatalogRepository(database);
const libraryPermissions = createLibraryPermissionsService({ database });
const mediaLists = createMediaListsService({ database, permissions: libraryPermissions });
const probeReader = createProbeCatalogReader(database);
const { root: catalogRoot } = bootstrapSharedContentRoot(catalogRepository, { contentRoot: storage.contentRoot });
const scanCatalog = async () => {
  const scan = await scanLocalRoot({ absoluteRoot: storage.contentRoot, repository: catalogRepository, rootId: catalogRoot.id });
  await importLegacyCinemaMetadata({ metadataPath: storage.cinemaMetadataPath, repository: catalogRepository, rootId: catalogRoot.id });
  return scan;
};
const playbackRepository = createPlaybackRepository({ db: database });
const playbackService = createPlaybackService({
  identityValidator: ({ itemId, sourceId }, principal) => {
    const source = catalogRepository.getSource(sourceId);
    return source?.itemId === itemId && source.availability === "available" && libraryPermissions.canAccessItem(principal, itemId);
  },
  repository: playbackRepository,
  visibilityFilter: ({ itemId }, principal) => libraryPermissions.canAccessItem(principal, itemId)
});
const resolveCatalogSource = ({ itemId, sourceId }, principal) => {
  if (principal?.type !== "user" || !principal.userId) throw Object.assign(new Error("Account playback access is required."), { status: 403 });
  const item = catalogRepository.getItem(itemId);
  const source = catalogRepository.getSource(sourceId);
  if (!item || !source || source.itemId !== itemId || source.availability !== "available" || source.rootId !== catalogRoot.id
    || item.libraryId !== catalogRoot.library_id || !libraryPermissions.canAccessLibrary(principal, item.libraryId)) return null;
  return source;
};
const playbackPlanner = createPlaybackPlanner({ resolveMedia: async (ids, principal) => {
  const source = await resolveCatalogSource(ids, principal);
  return source ? { item: catalogRepository.getItem(ids.itemId), probe: probeReader.get(ids.sourceId), source } : null;
} });
const deliveryCacheRoot = path.join(storage.dataRoot, "delivery-cache");
const remuxService = createRemuxService({ contentRoot: storage.contentRoot, outputRoot: path.join(deliveryCacheRoot, "remux"), resolveSource: resolveCatalogSource, concurrency: 2 });
const transcodeService = createTranscodeService({ contentRoot: storage.contentRoot, outputRoot: path.join(deliveryCacheRoot, "transcode"), resolveSource: resolveCatalogSource, concurrency: 1 });
await Promise.all([remuxService.initialize(), transcodeService.initialize()]);
const playbackPolicy = createPlaybackPolicyService({ repository: createPlaybackPolicyRepository(database) });
const playbackDelivery = createDeliveryService({
  authorize: ({ itemId }, principal) => libraryPermissions.canAccessItem(principal, itemId),
  contentRoot: storage.contentRoot,
  planner: playbackPlanner,
  policy: playbackPolicy,
  remuxService,
  resolveSource: resolveCatalogSource,
  transcodeService
});
const probeService = createProbeService({
  catalogWriter: createProbeCatalogWriter(database),
  contentRoot: storage.contentRoot,
  resolveSource: (sourceId) => catalogRepository.getSource(sourceId)
});
const jobsRepository = createJobsRepository({ db: database });
const jobsService = createJobsService({ repository: jobsRepository });
const jobsWorker = createJobsWorker({
  handlers: createMediaJobHandlers({
    scanLibrary: async (_payload, context) => {
      const scan = await scanCatalog();
      for (const item of catalogRepository.listItems({ availability: "available" })) {
        context.enqueue({ type: "probe", payload: { sourceId: item.source.id }, dedupeKey: `${item.source.id}:${item.source.contentRevision}` });
      }
      return scan;
    },
    probeSource: ({ sourceId }) => probeService.probeSource(sourceId),
    refreshMetadata: async () => ({ skipped: "metadata orchestration pending" }),
    cacheArtwork: async () => ({ skipped: "artwork cache pending" }),
    cleanup: async () => ({ candidates: catalogRepository.listCleanupCandidates().length })
  }),
  repository: jobsRepository
});
const authGuard = createAuthGuard(accountStore, { audit: auditService, guestService });
const backupService = createBackupService({
  backupRoot,
  dataRoot: storage.dataRoot,
  database,
  databasePath: storage.accountDatabasePath
});
const catalogReadinessSnapshot = () => {
  const roots = database.prepare(`SELECT
      SUM(CASE WHEN scan_status = 'failed' THEN 1 ELSE 0 END) AS failed_scans,
      SUM(CASE WHEN scan_status = 'scanning' THEN 1 ELSE 0 END) AS scanning_roots,
      MAX(last_scan_completed_at) AS last_completed_at
    FROM media_library_roots`).get() ?? {};
  const probes = database.prepare(`SELECT COUNT(*) AS pending_probes
    FROM background_jobs WHERE type = 'probe' AND state IN ('queued', 'running')`).get() ?? {};
  return {
    failedScans: Number(roots.failed_scans) || 0,
    lastCompletedAt: roots.last_completed_at ? Date.parse(roots.last_completed_at) : null,
    pendingProbes: Number(probes.pending_probes) || 0,
    scanningRoots: Number(roots.scanning_roots) || 0
  };
};
const observabilityService = createObservabilityService({
  checks: [
    { name: "database", run: createDatabaseCheck({ database }) },
    { name: "content_root", run: createDirectoryCheck({ directory: storage.contentRoot, name: "content_root" }) },
    { name: "jobs_worker", run: createWorkerCheck({ snapshot: jobsWorker.snapshot }) },
    { name: "catalog", run: createCatalogCheck({ snapshot: catalogReadinessSnapshot }) },
    { name: "content_disk", run: createDiskCheck({ directory: storage.contentRoot, name: "content_disk" }) },
    { name: "cache_disk", run: createDiskCheck({ directory: deliveryCacheRoot, name: "cache_disk" }) }
  ]
});
const handleObservability = createObservabilityRoutes({
  isAdmin: (request, url) => {
    const context = authGuard.resolve(request, url);
    return context?.kind !== "media-ticket" && authGuard.hasCapability(context, "server.admin");
  },
  service: observabilityService
});
const handleApi = createApiHandler(storage, accountStore, authGuard, {
  audit: auditService,
  backup: backupService,
  catalog: { libraryPermissions, probeReader, repository: catalogRepository, scan: scanCatalog },
  jobs: jobsService,
  guestService,
  libraryPermissions,
  mediaLists,
  playback: playbackService,
  playbackPlanner,
  playbackDelivery,
  playbackPolicy
});
jobsWorker.start();
jobsService.enqueue({ type: "scan", payload: { rootId: catalogRoot.id }, dedupeKey: `startup:${catalogRoot.id}` });

const vite = await createViteServer({
  server: {
    ...(viteAllowedHosts.length > 0 ? { allowedHosts: viteAllowedHosts } : {}),
    middlewareMode: true,
    host,
    hmr: {
      host: "127.0.0.1"
    }
  },
  appType: "spa"
});

const httpServer = createHttpServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://nebula.local");

  if (await handleObservability(request, response, url)) {
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    applyApiCorsHeaders(request, response);

    if (handleApiPreflight(request, response)) {
      return;
    }

    if (!(await authGuard.authorize(request, response, url))) {
      return;
    }

    const handled = await handleApi(request, response);

    if (handled) {
      return;
    }
  }

  vite.middlewares(request, response);
});
httpServer.listen(port, host, () => {
  console.log(`Nebula Dashboard running at http://${host}:${port}`);
  console.log(`Content root: ${storage.contentRoot}`);
  console.log(`Account store: ${storage.accountDatabasePath}`);
  console.log(`Backup root: ${backupRoot}`);
  console.log(`Offline restore staging root: ${restoreStagingRoot}`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise((resolve) => httpServer.close(resolve));
  await jobsWorker.stop();
  await playbackDelivery.shutdown();
  playbackPolicy.shutdown();
  await Promise.allSettled([remuxService.shutdown(), transcodeService.shutdown(), vite.close()]);
  database.close();
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void shutdown().finally(() => process.exit(0)); });
