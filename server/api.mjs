import { json } from "./http.mjs";
import { createCinemaRoutes } from "./cinema.mjs";
import { createFilesRoutes } from "./files.mjs";

export const createApiHandler = (storage) => {
  const routeHandlers = [
    createCinemaRoutes(storage),
    createFilesRoutes(storage)
  ];

  return async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    try {
      if (request.method === "GET" && url.pathname === "/api/server/info") {
        json(response, 200, {
          name: "Nebula Server",
          status: "online",
          serverTime: new Date().toISOString(),
          capabilities: ["cinema-library", "cinema-identify", "files", "metadata-editing"]
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
      json(response, error.status ?? 500, {
        error: error.message || "File operation failed."
      });
      return true;
    }
  };
};
