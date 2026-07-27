import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createExactViteHostGuard, createViteServerOptions } from "./viteConfig.mjs";
import { createStaticHandler } from "./static.mjs";
import { readRuntimeConfig } from "./runtimeConfig.mjs";
import { createApiHandler } from "./api.mjs";
import { createAuthGuard } from "./auth.mjs";
import { applyApiCorsHeaders, handleApiPreflight, isApiCorsOriginAllowed } from "./cors.mjs";
import { createStorage } from "./storage.mjs";
import { createAccountStore } from "./accountStore.mjs";
import { createGuestService } from "./guest/service.mjs";
import {
  catalogMigration, catalogQueryIndexesMigration, bootstrapSharedContentRoot, createCatalogRepository, createFingerprintRepository,
  createFingerprintService, discoverLocalMedia, importLegacyCinemaMetadata, scanLocalRoot
} from "./catalog/index.mjs";
import { createMediaLocationsService, mediaLocationsMigration } from "./mediaLocations/index.mjs";
import { openNebulaDatabase, applyDomainMigrations } from "./database.mjs";
import { createPlaybackRepository } from "./playback/repository.mjs";
import { createPlaybackService } from "./playback/service.mjs";
import { PLAYBACK_MIGRATION } from "./playback/schema.mjs";
import { createJobsRepository, createJobsService, createJobsWorker, createMediaJobHandlers, jobsMigration } from "./jobs/index.mjs";
import { createProbeCatalogReader, createProbeCatalogWriter, createProbeService, probeMigrations } from "./probe/index.mjs";
import { createPlaybackPlanner } from "./playback-planner/index.mjs";
import { createRemuxService } from "./remux/index.mjs";
import { createAccelerationManager, createAccelerationProbe, createTranscodeService } from "./transcode/index.mjs";
import { createDeliveryService } from "./playback/delivery.mjs";
import { createLibraryPermissionsService, libraryPermissionsMigration } from "./permissions/index.mjs";
import { createPlaybackPolicyRepository, createPlaybackPolicyService, playbackPolicyMigration } from "./playbackPolicy/index.mjs";
import { createBackupService } from "./backup/index.mjs";
import { auditMigration, createAuditService } from "./audit/index.mjs";
import { createMediaListsService, mediaListsMigration } from "./mediaLists/index.mjs";
import { createSubtitleService, subtitleMigration } from "./subtitles/index.mjs";
import { createRenditionService, createRenditionStore, renditionsMigration } from "./renditions/index.mjs";
import { createRenditionCleanupScheduler, createRenditionPolicyRepository, createRenditionPolicyService, renditionPolicyMigrations } from "./renditionPolicy/index.mjs";
import { createTailscaleEnrollmentService } from "./tailscaleEnrollment.mjs";
import { createArtworkScheduler, createArtworkService } from "./artwork/index.mjs";
import { readMetadata, writeMetadata } from "./mediaLibrary.mjs";
import { createTmdbClient } from "./tmdb.mjs";
import { createTmdbMetadataService } from "./metadata/tmdbService.mjs";
import { createMusicBrainzClient } from "./musicbrainz.mjs";
import { createMusicBrainzMetadataService } from "./metadata/musicbrainzService.mjs";
import {
  clusterKeyRotationMigration, clusterMigration, clusterOperationsMigration, clusterFederationMigration, createClusterIngressRoutes, createClusterManifestClient,
  createClusterManifestService, createClusterPairingClient, createClusterRepository, createClusterSyncService,
  createClusterGrantClient, createClusterGrantService, createClusterPlaybackScheduler, createClusterPlaybackService,
  createClusterDeliveryClient, createClusterKeyRotationClient, createClusterKeyRotationService,
  createClusterOperationsService, createClusterShardDeliveryService,
  createClusterTrustService, createFederatedCatalogRepository, syncLocalClusterManifest
} from "./cluster/index.mjs";
import {
  createCatalogCheck,
  createClusterCheck,
  createDatabaseCheck,
  createDirectoryCheck,
  createDiskCheck,
  createRenditionStorageCheck,
  createObservabilityRoutes,
  createObservabilityService,
  createRuntimeTelemetry,
  createWorkerCheck
} from "./observability/index.mjs";
import {
  createPartyAttachmentService,
  createPartyEvents,
  createPartyRepository,
  createPartyService,
  partyLifecycleMigration,
  partyMigration
} from "./party/index.mjs";

const runtimeConfig = readRuntimeConfig();
const runtimeTelemetry = createRuntimeTelemetry();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = path.join(root, "content");
const dataRoot = process.env.NEBULA_DATA_ROOT ? path.resolve(process.env.NEBULA_DATA_ROOT) : path.join(root, "data");
const backupRoot = process.env.NEBULA_BACKUP_ROOT ? path.resolve(process.env.NEBULA_BACKUP_ROOT) : path.join(dataRoot, "backups");
const restoreStagingRoot = process.env.NEBULA_RESTORE_STAGING_ROOT ? path.resolve(process.env.NEBULA_RESTORE_STAGING_ROOT) : path.join(dataRoot, "restore-staging");
const port = runtimeConfig.port;
const host = runtimeConfig.host;

const storage = await createStorage({ contentRoot, dataRoot });
const database = await openNebulaDatabase(storage.accountDatabasePath);
const accountStore = await createAccountStore({ database });
const guestService = createGuestService({ accountStore });
const tailscaleEnrollment = createTailscaleEnrollmentService();
accountStore.setOwnerCreatedHook(() => guestService.revokeAll());
applyDomainMigrations(database, [catalogMigration, catalogQueryIndexesMigration, PLAYBACK_MIGRATION, ...probeMigrations, jobsMigration, mediaLocationsMigration, libraryPermissionsMigration, playbackPolicyMigration, auditMigration, partyMigration, partyLifecycleMigration, mediaListsMigration, subtitleMigration, renditionsMigration, ...renditionPolicyMigrations, clusterMigration, clusterOperationsMigration, clusterKeyRotationMigration, clusterFederationMigration]);
const auditService = createAuditService({
  db: database,
  maxEvents: runtimeConfig.auditMaxEvents,
  retentionDays: runtimeConfig.auditRetentionDays
});
const partyRepository = createPartyRepository({ database });
const partyAttachments = createPartyAttachmentService({
  conversationQuotaBytes: runtimeConfig.partyConversationAttachmentBytes,
  dataRoot: storage.dataRoot,
  getAttachment: partyRepository.getAttachment,
  getConversationAttachmentBytes: partyRepository.getConversationAttachmentBytes,
  isConversationMember: partyRepository.isMember
});
await partyAttachments.initialize();
const partyEvents = createPartyEvents({
  isConversationMember: partyRepository.isMember,
  isIdentityActive: ({ userId, sessionId }) =>
    accountStore.isSessionActive(userId, sessionId)
});
const partyService = createPartyService({
  audit: auditService,
  events: partyEvents,
  listUsers: accountStore.listUsers,
  maxConversationAttachmentBytes: runtimeConfig.partyConversationAttachmentBytes,
  maxGlobalAttachmentBytes: runtimeConfig.partyGlobalAttachmentBytes,
  maxUserAttachmentBytes: runtimeConfig.partyUserAttachmentBytes,
  removeStorageKeys: partyAttachments.removeStorageKeys,
  repository: partyRepository
});
const clusterEnabled = process.env.NEBULA_CLUSTER_ENABLED === "true";
const clusterRepository = createClusterRepository(database);
let clusterService = null;
let clusterScheduler = null;
let clusterShardDelivery = null;
const clusterOperations = clusterEnabled ? createClusterOperationsService({
  audit: auditService,
  deliverySnapshot: () => clusterShardDelivery?.operationsSnapshot() ?? {},
  manifestSnapshot: () => database.prepare("SELECT last_complete_at AS lastCompleteAt, last_sync_at AS lastSyncAt FROM cluster_manifest_cursors LIMIT 10000").all(),
  nodesSnapshot: () => clusterRepository.listNodes({ includeRevoked: true }),
  schedulerSnapshot: () => clusterScheduler?.operationsSnapshot() ?? {}
}) : null;
clusterService = clusterEnabled ? createClusterTrustService({
  capabilities: { directPlay: true, hls: true, remux: true, renditionProfiles: ["240p", "360p", "480p", "720p", "1080p"], transcode: true },
  endpoint: process.env.NEBULA_CLUSTER_ENDPOINT,
  name: process.env.NEBULA_CLUSTER_NODE_NAME ?? "Nebula",
  operations: clusterOperations,
  repository: clusterRepository,
  role: process.env.NEBULA_CLUSTER_ROLE ?? "hybrid"
}) : null;
const catalogRepository = createCatalogRepository(database);
const mediaLocations = createMediaLocationsService({ contentRoot: storage.contentRoot, database });
let clusterSubtitleManifest = async () => [];
const localClusterManifest = clusterService ? createClusterManifestService({
  database, nodeId: clusterService.identity().descriptor.nodeId,
  listSubtitles: (...args) => clusterSubtitleManifest(...args)
}) : null;
const federatedCatalog = clusterService ? createFederatedCatalogRepository(database, {
  localNodeId: clusterService.identity().descriptor.nodeId
}) : null;
const syncLocalProjection = clusterService ? () => syncLocalClusterManifest({
  federation: federatedCatalog,
  manifest: localClusterManifest,
  nodeId: clusterService.identity().descriptor.nodeId
}) : () => null;
const clusterSync = clusterService ? createClusterSyncService({
  client: createClusterManifestClient(), federation: federatedCatalog, trust: clusterService
}) : null;
clusterScheduler = clusterService ? createClusterPlaybackScheduler({ federation: federatedCatalog, nodePolicy: clusterService.nodePolicy }) : null;
const clusterGrantClient = clusterService ? createClusterGrantClient() : null;
const clusterDeliveryClient = clusterService ? createClusterDeliveryClient({ trust: clusterService }) : null;
const fingerprintRepository = createFingerprintRepository(database);
const fingerprintService = createFingerprintService({
  contentRoot: storage.contentRoot,
  repository: fingerprintRepository,
  resolveSource: (sourceId) => catalogRepository.getSource(sourceId)
});
const libraryPermissions = createLibraryPermissionsService({ database });
const mediaLists = createMediaListsService({ database, permissions: libraryPermissions });
const probeReader = createProbeCatalogReader(database);
const { root: catalogRoot } = bootstrapSharedContentRoot(catalogRepository, { contentRoot: storage.contentRoot });
const canAccessFederatedItem = (context, itemId) => {
  if (!clusterService || !federatedCatalog?.hasItem(itemId) || context?.kind === "guest") return false;
  if (context?.kind === "service" || context?.user?.role === "owner") return true;
  if (context?.user?.role !== "member") return false;
  return libraryPermissions.canAccessLibrary(context, catalogRoot.library_id);
};
const canAccountAccessFederatedItem = (accountId, itemId) => {
  const account = accountStore.listUsers().find((user) => user.id === accountId && !user.disabled);
  if (!account || !federatedCatalog?.hasItem(itemId)) return false;
  return account.role === "owner" || (account.role === "member" && libraryPermissions.canAccessLibrary(
    { type: "user", userId: account.id }, catalogRoot.library_id
  ));
};
const scanCatalog = async () => {
  const configuredLocations = mediaLocations.list();
  let scan;
  if (configuredLocations.length === 0) {
    scan = await scanLocalRoot({ absoluteRoot: storage.contentRoot, repository: catalogRepository, rootId: catalogRoot.id });
  } else {
    const filesByPath = new Map();
    for (const location of configuredLocations) {
      const files = await discoverLocalMedia({
        absoluteRoot: path.resolve(storage.contentRoot, location.contentPath),
        contentPathPrefix: location.contentPath,
        itemTypeOverride: location.category === "movies" ? "movie" : location.category === "tv" ? "episode" : "track",
        mediaKind: location.category === "music" ? "audio" : "video"
      });
      files.forEach((file) => filesByPath.set(file.path, file));
    }
    scan = catalogRepository.reconcileScan({ files: [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path)), rootId: catalogRoot.id, scanType: "full" });
  }
  await importLegacyCinemaMetadata({ metadataPath: storage.cinemaMetadataPath, repository: catalogRepository, rootId: catalogRoot.id });
  await syncLocalProjection();
  return scan;
};
const playbackRepository = createPlaybackRepository({ db: database });
const playbackService = createPlaybackService({
  federatedIdentityValidator: ({ itemId, sourceId }, principal) => {
    if (!clusterService || principal?.type !== "user") return false;
    return canAccountAccessFederatedItem(principal.userId, itemId) && federatedCatalog.listPlaybackSources(itemId)
      .some((source) => source.federatedSourceId === sourceId && source.availability === "available");
  },
  federatedVisibilityFilter: ({ itemId }, principal) => principal?.type === "user"
    && canAccountAccessFederatedItem(principal.userId, itemId),
  identityValidator: ({ itemId, sourceId }, principal) => {
    const source = catalogRepository.getSource(sourceId);
    return source?.itemId === itemId && source.availability === "available" && libraryPermissions.canAccessItem(principal, itemId);
  },
  repository: playbackRepository,
  visibilityFilter: ({ itemId }, principal) => libraryPermissions.canAccessItem(principal, itemId)
});
const resolveCatalogSource = ({ itemId, sourceId }, principal) => {
  if (!(["user", "guest", "service"].includes(principal?.type))) throw Object.assign(new Error("Account playback access is required."), { status: 403 });
  const item = catalogRepository.getItem(itemId);
  const source = catalogRepository.getSource(sourceId);
  if (!item || !source || source.itemId !== itemId || source.availability !== "available" || source.rootId !== catalogRoot.id
    || item.libraryId !== catalogRoot.library_id || (principal.type !== "service" && !libraryPermissions.canAccessLibrary(principal, item.libraryId))) return null;
  return source;
};
const subtitleService = createSubtitleService({
  database, contentRoot: storage.contentRoot, resolveSource: resolveCatalogSource, probeReader,
  canAccessItem: (principal, itemId) => libraryPermissions.canAccessItem(principal, itemId)
});
clusterSubtitleManifest = (ids, revision) => subtitleService.manifestTracks(ids, revision);
const playbackPlanner = createPlaybackPlanner({ resolveMedia: async (ids, principal) => {
  const source = await resolveCatalogSource(ids, principal);
  if (!source) return null;
  const subtitles = await subtitleService.selection(ids, principal);
  return { item: catalogRepository.getItem(ids.itemId), probe: probeReader.get(ids.sourceId), source, subtitleSelection: subtitles };
} });
const deliveryCacheRoot = path.join(storage.dataRoot, "delivery-cache");
const remuxService = createRemuxService({ contentRoot: storage.contentRoot, outputRoot: path.join(deliveryCacheRoot, "remux"), resolveSource: resolveCatalogSource, concurrency: 2 });
const accelerationManager = createAccelerationManager({
  mode: process.env.NEBULA_TRANSCODE_ACCELERATION ?? "software-only",
  probe: createAccelerationProbe({ accessDevice: async (backend) => { if (backend !== "vaapi") return false; try { await access("/dev/dri/renderD128"); return true; } catch { return false; } } })
});
const renditionStore = createRenditionStore({ database, dataRoot: storage.dataRoot });
const renditionPolicyRepository = createRenditionPolicyRepository(database);
const transcodeService = createTranscodeService({
  acceleration: accelerationManager, contentRoot: storage.contentRoot, outputRoot: path.join(deliveryCacheRoot, "transcode"), resolveSource: resolveCatalogSource, concurrency: 1,
  renditionStore,
  resolveSubtitle: ({ itemId, sourceId, subtitleId }, principal) => subtitleService.resolveBurnIn({ itemId, sourceId }, subtitleId, principal),
  shouldPersistRendition: ({ origin }) => origin !== "interactive" || renditionPolicyRepository.get().cacheInteractive
});
await Promise.all([remuxService.initialize(), renditionStore.initialize(), transcodeService.initialize()]);
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
const resolveClusterCatalogSource = ({ itemId, sourceId }) => {
  const item = catalogRepository.getItem(itemId);
  const source = catalogRepository.getSource(sourceId);
  if (!item || !source || source.itemId !== itemId || source.availability !== "available"
    || source.rootId !== catalogRoot.id || item.libraryId !== catalogRoot.library_id) return null;
  return source;
};
const clusterDeliveryPlanner = clusterService ? createPlaybackPlanner({ resolveMedia: async (ids, principal) => {
  const source = resolveClusterCatalogSource(ids);
  if (!source) return null;
  const subtitleSelection = await subtitleService.selection(ids, { type: "service" }, principal?.subtitleId ?? null);
  return { item: catalogRepository.getItem(ids.itemId), probe: probeReader.get(ids.sourceId), source, subtitleSelection };
} }) : null;
const clusterRemuxService = clusterService ? createRemuxService({
  contentRoot: storage.contentRoot,
  outputRoot: path.join(deliveryCacheRoot, "cluster-remux"),
  resolveSource: resolveClusterCatalogSource,
  concurrency: 2
}) : null;
const clusterTranscodeService = clusterService ? createTranscodeService({
  acceleration: accelerationManager,
  contentRoot: storage.contentRoot,
  outputRoot: path.join(deliveryCacheRoot, "cluster-transcode"),
  resolveSource: resolveClusterCatalogSource,
  concurrency: 1,
  renditionStore,
  resolveSubtitle: ({ itemId, sourceId, subtitleId }) => subtitleService.resolveBurnIn({ itemId, sourceId }, subtitleId, { type: "service" }),
  shouldPersistRendition: ({ origin }) => origin !== "interactive" || renditionPolicyRepository.get().cacheInteractive
}) : null;
if (clusterService) await Promise.all([clusterRemuxService.initialize(), clusterTranscodeService.initialize()]);
const clusterDelivery = clusterService ? createDeliveryService({
  authorize: ({ itemId, sourceId }) => Boolean(resolveClusterCatalogSource({ itemId, sourceId })),
  contentRoot: storage.contentRoot,
  planner: clusterDeliveryPlanner,
  remuxService: clusterRemuxService,
  resolveSource: resolveClusterCatalogSource,
  transcodeService: clusterTranscodeService
}) : null;
clusterShardDelivery = clusterService ? createClusterShardDeliveryService({
  catalog: catalogRepository,
  delivery: clusterDelivery,
  localNodeId: clusterService.identity().descriptor.nodeId,
  subtitles: subtitleService
}) : null;
const clusterGrantService = clusterService ? createClusterGrantService({
  catalog: catalogRepository,
  isClientOriginAllowed: isApiCorsOriginAllowed,
  shardDelivery: clusterShardDelivery,
  trust: clusterService
}) : null;
const clusterKeyRotation = clusterService ? createClusterKeyRotationService({
  client: createClusterKeyRotationClient(), repository: clusterRepository, trust: clusterService
}) : null;
const clusterIngress = clusterService ? createClusterIngressRoutes({
  contentRoot: storage.contentRoot,
  grants: clusterGrantService,
  manifest: localClusterManifest,
  keyRotation: clusterKeyRotation,
  service: clusterService,
  shardDelivery: clusterShardDelivery,
  subtitles: subtitleService
}) : null;
const clusterPlayback = clusterService ? createClusterPlaybackService({
  authorize: ({ accountId, federatedItemId }) => canAccountAccessFederatedItem(accountId, federatedItemId),
  client: clusterGrantClient,
  deliveryClient: clusterDeliveryClient,
  grants: clusterGrantService,
  localDelivery: playbackDelivery,
  playbackPolicy,
  scheduler: clusterScheduler
}) : null;
const probeService = createProbeService({
  catalogWriter: createProbeCatalogWriter(database),
  contentRoot: storage.contentRoot,
  resolveSource: (sourceId) => catalogRepository.getSource(sourceId)
});
const jobsRepository = createJobsRepository({ db: database });
const jobsService = createJobsService({ repository: jobsRepository });
const artworkService = createArtworkService({
  contentRoot: storage.contentRoot,
  dataRoot: storage.dataRoot,
  repository: catalogRepository,
  resolveSource: (sourceId) => catalogRepository.getSource(sourceId)
});
const artworkScheduler = createArtworkScheduler({ repository: catalogRepository });
const tmdbMetadata = createTmdbMetadataService({
  readLegacyMetadata: () => readMetadata(storage.cinemaMetadataPath),
  repository: catalogRepository,
  tmdb: createTmdbClient({
    tokenProvider: () => accountStore.getServerSetting("tmdb_api_token") || process.env.TMDB_API_TOKEN || ""
  }),
  writeLegacyMetadata: (metadata) => writeMetadata(storage.cinemaMetadataPath, metadata)
});
const musicMetadata = createMusicBrainzMetadataService({
  client: createMusicBrainzClient(),
  repository: catalogRepository
});
const renditionPolicy = createRenditionPolicyService({ audit: auditService, jobs: jobsService,
  repository: renditionPolicyRepository, store: renditionStore });
const renditionService = createRenditionService({
  audit: auditService,
  canAccessItem: (context, itemId) => context?.kind === "service" || libraryPermissions.canAccessItem(
    context?.kind === "account" ? { type: "user", userId: context.principalId }
      : context?.kind === "guest" ? { kind: "guest" } : null,
    itemId
  ),
  catalog: catalogRepository, jobs: jobsService, planner: playbackPlanner, policy: renditionPolicy,
  probeReader, store: renditionStore, transcode: transcodeService
});
const jobsWorker = createJobsWorker({
  handlers: createMediaJobHandlers({
    scanLibrary: async (payload, context) => {
      const purged = payload?.purgeMetadata ? catalogRepository.resetMetadata({ mediaKind: "video" }) : null;
      if (payload?.purgeMetadata) await writeMetadata(storage.cinemaMetadataPath, {});
      const scan = await scanCatalog();
      const metadata = payload?.refreshTmdb
        ? tmdbMetadata.enqueueAll(context.enqueue, {
            availableAt: Date.now() + 5_000,
            batchId: payload.batchId ?? "full-reindex"
          })
        : { intervalMs: 0, queued: 0 };
      const enrichmentStart = Date.now() + 60_000;
      const probedAudioSources = new Set();
      for (const item of catalogRepository.listItems({ availability: "available" })) {
        const probe = probeReader.get(item.source.id);
        if (probe.sourceContentRevision !== item.source.contentRevision) {
          context.enqueue({ type: "probe", payload: { sourceId: item.source.id }, dedupeKey: `${item.source.id}:${item.source.contentRevision}`, maxAttempts: 1, reuseTerminal: true, availableAt: enrichmentStart });
        } else if (item.source.mediaKind === "audio") {
          probedAudioSources.add(item.source.id);
        }
        if (clusterService) {
          const fingerprint = fingerprintRepository.get(item.source.id);
          if (fingerprint?.state !== "ready" || fingerprint.sourceRevision !== item.source.contentRevision) {
            context.enqueue({ type: "fingerprint", payload: { sourceId: item.source.id }, dedupeKey: `${item.source.id}:${item.source.contentRevision}`, availableAt: enrichmentStart });
          }
        }
      }
      const music = musicMetadata.enqueueMissing(context.enqueue, {
        availableAt: Date.now() + 60_000,
        batchId: payload.batchId ?? `scan-${Date.now()}`,
        sourceFilter: (source) => probedAudioSources.has(source.id)
      });
      const metadataActivity = jobsService.activity("metadata");
      const metadataPending = Number(metadataActivity.counts.queued ?? 0) + Number(metadataActivity.counts.running ?? 0) > 0;
      const artworkStart = payload?.refreshTmdb
        ? Date.now() + 30_000 + metadata.queued * metadata.intervalMs
        : metadataPending ? Date.now() + 60 * 60_000 : Date.now() + 30_000;
      const artwork = artworkScheduler.enqueueMissing(context.enqueue, { availableAt: artworkStart });
      return { ...scan, artworkQueued: artwork.queued, metadataQueued: metadata.queued, musicMetadataQueued: music.queued, purged };
    },
    probeSource: async ({ sourceId }, context) => {
      context.throwIfCancelled();
      const result = await probeService.probeSource(sourceId);
      context.throwIfCancelled();
      const source = catalogRepository.getSource(sourceId);
      const music = source?.mediaKind === "audio"
        ? musicMetadata.enqueueMissing(context.enqueue, {
            availableAt: Date.now() + 1_000,
            batchId: "after-probe",
            sourceFilter: (candidate) => candidate.id === sourceId
          })
        : { queued: 0 };
      await syncLocalProjection();
      return { ...result, musicMetadataQueued: music.queued };
    },
    fingerprintSource: async ({ sourceId }, context) => { const result = await fingerprintService.fingerprintSource(sourceId, context); await syncLocalProjection(); return result; },
    buildRendition: async (payload, context) => { const result = await renditionService.build(payload, context); await syncLocalProjection(); return result; },
    refreshMetadata: async (payload, context) => {
      if (payload?.sourceId) {
        const source = catalogRepository.getSource(payload.sourceId);
        return source?.mediaKind === "audio"
          ? musicMetadata.refreshSource(payload, context)
          : tmdbMetadata.refreshSource(payload, context);
      }
      const batchId = `manual-${Date.now()}`;
      const video = tmdbMetadata.enqueueAll(context.enqueue, { availableAt: Date.now() + 1_000, batchId });
      const audio = musicMetadata.enqueueMissing(context.enqueue, {
        availableAt: Date.now() + 1_000 + video.queued * video.intervalMs,
        batchId
      });
      return { audio, video };
    },
    cacheArtwork: async (payload, context) => payload?.sourceId
      ? artworkService.generate(payload, context)
      : artworkScheduler.enqueueMissing(context.enqueue, { availableAt: Date.now() + 1_000 }),
    cleanup: (payload, context) => payload?.scope === "renditions"
      ? renditionPolicy.cleanup(payload, context)
      : ({ candidates: catalogRepository.listCleanupCandidates().length })
  }),
  repository: jobsRepository,
  concurrency: runtimeConfig.jobConcurrency
});
const authGuard = createAuthGuard(accountStore, {
  audit: auditService,
  externalHttps: () => process.env.NEBULA_EXTERNAL_HTTPS === "true" || tailscaleEnrollment.isExternalHttpsActive(),
  guestService
});
const backupService = createBackupService({
  backupRoot,
  dataRoot: storage.dataRoot,
  database,
  databasePath: storage.accountDatabasePath,
  retentionMaxBackups: runtimeConfig.backupRetentionMax
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
    { name: "cache_disk", run: createDiskCheck({ directory: deliveryCacheRoot, name: "cache_disk" }) },
    { name: "backup_disk", run: createDiskCheck({ directory: backupRoot, name: "backup_disk" }) },
    { name: "rendition_storage", run: createRenditionStorageCheck({ status: renditionPolicy.status }) },
    ...(clusterOperations ? [{ name: "cluster", run: createClusterCheck({ operations: clusterOperations }) }] : [])
  ]
});
const handleObservability = createObservabilityRoutes({
  clusterMetrics: () => clusterOperations?.metrics() ?? {},
  isAdmin: (request, url) => {
    const context = authGuard.resolve(request, url);
    return context?.kind !== "media-ticket" && authGuard.hasCapability(context, "server.admin");
  },
  runtimeMetrics: runtimeTelemetry.snapshot,
  service: observabilityService,
  transcodeStatus: transcodeService.status
});
const handleApi = createApiHandler(storage, accountStore, authGuard, {
  audit: auditService,
  backup: backupService,
  catalog: { libraryPermissions, probeReader, repository: catalogRepository, scan: scanCatalog },
  ...(clusterService ? { cluster: {
    audit: auditService,
    authorizePlayback: (context, itemId) => canAccessFederatedItem(context, itemId),
    federation: federatedCatalog,
    federationAuthorization: { canAccessItem: canAccessFederatedItem },
    pairingClient: createClusterPairingClient(),
    keyRotation: clusterKeyRotation, operations: clusterOperations, playback: clusterPlayback,
    scheduler: clusterScheduler, service: clusterService, sync: clusterSync
  } } : {}),
  jobs: jobsService,
  mediaLocations,
  musicMetadata,
  guestService,
  libraryPermissions,
  mediaLists,
  onError: (error, fields) => runtimeTelemetry.recordError(error, fields),
  party: { attachments: partyAttachments, events: partyEvents, service: partyService },
  playback: playbackService,
  playbackPlanner,
  playbackDelivery,
  playbackPolicy,
  renditions: renditionService,
  renditionPolicy,
  transcodeAcceleration: { refresh: accelerationManager.refresh, setMode: accelerationManager.setMode, status: transcodeService.status },
  subtitles: subtitleService,
  tailscaleEnrollment
});
const pruneJobHistory = () => jobsService.prune({
  olderThan: Date.now() - runtimeConfig.jobHistoryDays * 24 * 60 * 60 * 1_000,
  retain: runtimeConfig.jobHistoryRetain
});
pruneJobHistory();
const jobHistoryInterval = setInterval(pruneJobHistory, 24 * 60 * 60 * 1_000);
jobHistoryInterval.unref?.();
let partyMaintenancePromise = null;
const runPartyMaintenance = () => {
  if (partyMaintenancePromise) return partyMaintenancePromise;
  partyMaintenancePromise = (async () => {
    await partyAttachments.cleanupTemporaryUploads();
    await partyService.drainAttachmentCleanup({
      limit: runtimeConfig.partyMaintenanceBatchSize
    });
    if (runtimeConfig.partyRetentionDays > 0) {
      await partyService.runRetention({
        before: new Date(
          Date.now() - runtimeConfig.partyRetentionDays * 24 * 60 * 60 * 1_000
        ).toISOString(),
        limit: runtimeConfig.partyMaintenanceBatchSize
      });
    }
  })().catch((error) => {
    runtimeTelemetry.recordError(error, { phase: "party-maintenance" });
  }).finally(() => {
    partyMaintenancePromise = null;
  });
  return partyMaintenancePromise;
};
void runPartyMaintenance();
const partyMaintenanceInterval = setInterval(
  () => void runPartyMaintenance(),
  runtimeConfig.partyMaintenanceIntervalMinutes * 60 * 1_000
);
partyMaintenanceInterval.unref?.();
jobsWorker.start();
jobsService.enqueue({
  availableAt: Date.now() + 15_000,
  dedupeKey: "artwork-backfill:v1",
  maxAttempts: 1,
  payload: { reason: "startup", scope: "missing" },
  reuseTerminal: true,
  type: "artwork"
});
const enqueueScheduledScan = (reason) => jobsService.enqueue({
  type: "scan",
  payload: { reason, rootId: catalogRoot.id },
  dedupeKey: `library:${catalogRoot.id}`,
  availableAt: Date.now() + (reason === "startup" ? runtimeConfig.startupScanDelayMs : 0)
});
enqueueScheduledScan("startup");
const libraryScanInterval = setInterval(() => enqueueScheduledScan("daily"), 24 * 60 * 60 * 1000);
libraryScanInterval.unref?.();
const renditionCleanupScheduler = createRenditionCleanupScheduler({ enqueue: renditionPolicy.enqueueCleanup, getPolicy: renditionPolicy.get });
renditionPolicy.enqueueCleanup("startup");
renditionCleanupScheduler.start();

const production = runtimeConfig.production;
const vite = production ? null : await (await import("vite")).createServer({
  cacheDir: path.join(storage.dataRoot, "vite-cache"),
  server: {
    middlewareMode: true,
    host,
    ...createViteServerOptions(),
    // Nebula performs exact validation before Vite so the sidecar-published
    // hostname can become available without weakening to a wildcard suffix.
    allowedHosts: true
  },
  appType: "spa"
});
const serveFrontend = production
  ? createStaticHandler({ root: path.join(root, "dist") })
  : (request, response) => vite.middlewares(request, response);
const viteHostGuard = createExactViteHostGuard({ dynamicHost: tailscaleEnrollment.currentFqdn });

const httpServer = createHttpServer((request, response) => {
  const startedAt = performance.now();
  response.once("finish", () => runtimeTelemetry.recordRequest({
    durationMs: performance.now() - startedAt,
    method: request.method ?? "OTHER",
    status: response.statusCode
  }));
  void (async () => {
    const url = new URL(request.url ?? "/", "http://nebula.local");
    if (!viteHostGuard(request, response)) return;
    if (await handleObservability(request, response, url)) return;
    if (url.pathname.startsWith("/api/")) {
      applyApiCorsHeaders(request, response);
      if (handleApiPreflight(request, response)) return;
      if (clusterIngress && await clusterIngress(request, response, url)) return;
      if (!(await authGuard.authorize(request, response, url))) return;
      if (await handleApi(request, response)) return;
      response.writeHead(404, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff"
      });
      response.end(JSON.stringify({ code: "not_found", error: "API route not found." }));
      return;
    }
    await serveFrontend(request, response);
  })().catch((error) => {
    runtimeTelemetry.recordError(error, { method: request.method ?? "OTHER" });
    if (!response.headersSent) {
      response.writeHead(500, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Server operation failed." }));
    } else {
      response.destroy();
    }
  });
});
httpServer.listen(port, host, () => {
  runtimeTelemetry.write("info", "server.started", { host, port, production });
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(jobHistoryInterval);
  clearInterval(libraryScanInterval);
  clearInterval(partyMaintenanceInterval);
  renditionCleanupScheduler.stop();
  partyEvents.close();
  const jobsStop = jobsWorker.stop();
  const serverClose = new Promise((resolve) => httpServer.close(resolve));
  httpServer.closeIdleConnections?.();
  await Promise.all([jobsStop, serverClose]);
  await partyMaintenancePromise;
  await clusterPlayback?.shutdown();
  await playbackDelivery.shutdown();
  await clusterShardDelivery?.shutdown();
  await clusterDelivery?.shutdown();
  clusterGrantService?.shutdown();
  playbackPolicy.shutdown();
  await Promise.allSettled([
    remuxService.shutdown(), transcodeService.shutdown(),
    clusterRemuxService?.shutdown(), clusterTranscodeService?.shutdown(),
    vite?.close()
  ]);
  database.close();
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  void shutdown().then(
    () => process.exit(0),
    (error) => {
      runtimeTelemetry.recordError(error, { phase: "shutdown" });
      process.exit(1);
    }
  );
});
