import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { createApiHandler } from "./api.mjs";
import { createAuthGuard } from "./auth.mjs";
import { applyApiCorsHeaders, handleApiPreflight } from "./cors.mjs";
import { createStorage } from "./storage.mjs";
import { createAccountStore } from "./accountStore.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = path.join(root, "content");
const dataRoot = process.env.NEBULA_DATA_ROOT ? path.resolve(process.env.NEBULA_DATA_ROOT) : path.join(root, "data");
const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? "0.0.0.0";

const storage = await createStorage({ contentRoot, dataRoot });
const accountStore = await createAccountStore({ databasePath: storage.accountDatabasePath });
const authGuard = createAuthGuard(accountStore);
const handleApi = createApiHandler(storage, accountStore, authGuard);

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
