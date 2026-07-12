import { json } from "./http.mjs";
import { createCinemaRoutes } from "./cinema.mjs";
import { createFilesRoutes } from "./files.mjs";
import { createMusicRoutes } from "./music.mjs";
import { createAccountRoutes } from "./accounts.mjs";
import { createCatalogRoutes } from "./catalog/routes.mjs";
import { createPlaybackRoutes } from "./playback/routes.mjs";
import { createJobsRoutes } from "./jobs/routes.mjs";
import { createBackupRoutes } from "./backup/routes.mjs";
import { createPlaybackPolicyRoutes } from "./playbackPolicy/routes.mjs";
import { createAuditRoutes } from "./audit/routes.mjs";
import { createMediaListsRoutes } from "./mediaLists/routes.mjs";

export const createApiHandler = (storage, accountStore, authGuard, options = {}) => {
  const routeHandlers = [
    createAccountRoutes(accountStore, authGuard, options.libraryPermissions, options.audit),
    ...(options.audit ? [createAuditRoutes(options.audit)] : []),
    ...(options.backup ? [createBackupRoutes(options.backup, options.audit)] : []),
    ...(options.playbackPolicy ? [createPlaybackPolicyRoutes(options.playbackPolicy)] : []),
    ...(options.catalog ? [createCatalogRoutes(options.catalog, options.audit)] : []),
    ...(options.mediaLists ? [createMediaListsRoutes(options.mediaLists, options.audit)] : []),
    ...(options.playback ? [createPlaybackRoutes(options.playback, options.playbackPlanner, options.playbackDelivery)] : []),
    ...(options.jobs ? [createJobsRoutes(options.jobs, options.audit)] : []),
    createCinemaRoutes(storage, accountStore, { ...options.cinema, libraryPermissions: options.libraryPermissions }),
    createMusicRoutes(storage, accountStore, { libraryPermissions: options.libraryPermissions }),
    createFilesRoutes(storage)
  ];

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://nebula.local");

    try {
      if (request.method === "GET" && url.pathname === "/api/server/info") {
        json(response, 200, {
          name: "Nebula Server",
          status: "online",
          serverTime: new Date().toISOString(),
          capabilities: ["audit-history", "background-jobs", "catalog", "cinema-library", "cinema-identify", "collections", "files", "library-permissions", "metadata-editing", "music-library", "playback-delivery", "playback-policy", "playback-state", "playlists", "probe"]
        });
        return true;
      }

      for (const routeHandler of routeHandlers) {
        if (await routeHandler(request, response, url)) {
          return true;
        }
      }

      return false;
    } catch (error) {
      const status = error.status ?? 500;
      json(response, status, {
        ...(error.code ? { code: error.code } : {}),
        error: status >= 500 && !error.expose ? "Server operation failed." : error.message
      });
      return true;
    }
  };
};
