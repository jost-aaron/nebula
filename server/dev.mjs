import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { createApiHandler } from "./api.mjs";
import { createAuthGuard } from "./auth.mjs";
import { applyApiCorsHeaders, handleApiPreflight } from "./cors.mjs";
import { createStorage } from "./storage.mjs";
import { createAccountStore } from "./accountStore.mjs";
import { catalogMigration, bootstrapSharedContentRoot, createCatalogRepository, importLegacyCinemaMetadata, scanLocalRoot } from "./catalog/index.mjs";
import { openNebulaDatabase, applyDomainMigrations } from "./database.mjs";
import { createPlaybackRepository } from "./playback/repository.mjs";
import { createPlaybackService } from "./playback/service.mjs";
import { PLAYBACK_MIGRATION } from "./playback/schema.mjs";
import { createJobsRepository, createJobsService, createJobsWorker, createMediaJobHandlers, jobsMigration } from "./jobs/index.mjs";
import { createProbeCatalogReader, createProbeCatalogWriter, createProbeService, probeMigration } from "./probe/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = path.join(root, "content");
const dataRoot = process.env.NEBULA_DATA_ROOT ? path.resolve(process.env.NEBULA_DATA_ROOT) : path.join(root, "data");
const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? "0.0.0.0";

const storage = await createStorage({ contentRoot, dataRoot });
const database = await openNebulaDatabase(storage.accountDatabasePath);
const accountStore = await createAccountStore({ database });
applyDomainMigrations(database, [catalogMigration, PLAYBACK_MIGRATION, probeMigration, jobsMigration]);
const catalogRepository = createCatalogRepository(database);
const { root: catalogRoot } = bootstrapSharedContentRoot(catalogRepository, { contentRoot: storage.contentRoot });
const scanCatalog = async () => {
  const scan = await scanLocalRoot({ absoluteRoot: storage.contentRoot, repository: catalogRepository, rootId: catalogRoot.id });
  await importLegacyCinemaMetadata({ metadataPath: storage.cinemaMetadataPath, repository: catalogRepository, rootId: catalogRoot.id });
  return scan;
};
const playbackRepository = createPlaybackRepository({ db: database });
const playbackService = createPlaybackService({
  identityValidator: ({ itemId, sourceId }) => {
    const source = catalogRepository.getSource(sourceId);
    return source?.itemId === itemId && source.availability === "available";
  },
  repository: playbackRepository
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
const authGuard = createAuthGuard(accountStore);
const handleApi = createApiHandler(storage, accountStore, authGuard, {
  catalog: { probeReader: createProbeCatalogReader(database), repository: catalogRepository, scan: scanCatalog },
  jobs: jobsService,
  playback: playbackService
});
jobsWorker.start();
jobsService.enqueue({ type: "scan", payload: { rootId: catalogRoot.id }, dedupeKey: `startup:${catalogRoot.id}` });

const vite = await createViteServer({
  server: {
    middlewareMode: true,
    host,
    hmr: {
      host: "127.0.0.1"
    }
  },
  appType: "spa"
});

createHttpServer(async (request, response) => {
  if (request.url?.startsWith("/api/")) {
    applyApiCorsHeaders(request, response);

    if (handleApiPreflight(request, response)) {
      return;
    }

    const url = new URL(request.url ?? "/", "http://nebula.local");
    if (!(await authGuard.authorize(request, response, url))) {
      return;
    }

    const handled = await handleApi(request, response);

    if (handled) {
      return;
    }
  }

  vite.middlewares(request, response);
}).listen(port, host, () => {
  console.log(`Nebula Dashboard running at http://${host}:${port}`);
  console.log(`Content root: ${storage.contentRoot}`);
  console.log(`Account store: ${storage.accountDatabasePath}`);
});
