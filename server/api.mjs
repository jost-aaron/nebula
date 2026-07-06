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
