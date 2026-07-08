import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { createApiHandler } from "./api.mjs";
import { createAuthGuard } from "./auth.mjs";
import { applyApiCorsHeaders, handleApiPreflight } from "./cors.mjs";
import { createStorage } from "./storage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = path.join(root, "content");
const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? "0.0.0.0";

const storage = await createStorage({ contentRoot });
const handleApi = createApiHandler(storage);
const authGuard = createAuthGuard();

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

    if (!(await authGuard.authorize(request, response))) {
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
});
