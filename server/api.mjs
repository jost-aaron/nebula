import { json } from "./http.mjs";
import { createCinemaRoutes } from "./cinema.mjs";
import { createFilesRoutes } from "./files.mjs";
import { createMusicRoutes } from "./music.mjs";
import { createAccountRoutes } from "./accounts.mjs";

export const createApiHandler = (storage, accountStore, authGuard) => {
  const routeHandlers = [
    createAccountRoutes(accountStore, authGuard),
    createCinemaRoutes(storage, accountStore),
    createMusicRoutes(storage, accountStore),
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
          capabilities: ["cinema-library", "cinema-identify", "files", "metadata-editing", "music-library"]
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
        error: status >= 500 ? "Server operation failed." : error.message
      });
      return true;
    }
  };
};
