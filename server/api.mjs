import { json } from "./http.mjs";
import { createCinemaRoutes } from "./cinema.mjs";
import { createFilesRoutes } from "./files.mjs";
import { createMusicRoutes } from "./music.mjs";
import { createAccountRoutes } from "./accounts.mjs";
import { createCatalogRoutes } from "./catalog/routes.mjs";
import { createPlaybackRoutes } from "./playback/routes.mjs";
import { createJobsRoutes } from "./jobs/routes.mjs";
import { createBackupRoutes } from "./backup/routes.mjs";

export const createApiHandler = (storage, accountStore, authGuard, options = {}) => {
  const routeHandlers = [
    createAccountRoutes(accountStore, authGuard, options.libraryPermissions),
    ...(options.backup ? [createBackupRoutes(options.backup)] : []),
    ...(options.catalog ? [createCatalogRoutes(options.catalog)] : []),
    ...(options.playback ? [createPlaybackRoutes(options.playback, options.playbackPlanner, options.playbackDelivery)] : []),
    ...(options.jobs ? [createJobsRoutes(options.jobs)] : []),
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
          capabilities: ["background-jobs", "catalog", "cinema-library", "cinema-identify", "files", "library-permissions", "metadata-editing", "music-library", "playback-delivery", "playback-state", "probe"]
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
        error: status >= 500 && !error.expose ? "Server operation failed." : error.message
      });
      return true;
    }
  };
};
