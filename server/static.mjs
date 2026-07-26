import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"]
]);

const candidatePath = (root, pathname) => {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "");
  const resolved = path.resolve(root, relative);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
};

export const createStaticHandler = ({ root }) => {
  const staticRoot = path.resolve(root);
  const indexPath = path.join(staticRoot, "index.html");
  return async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://nebula.local");
    const requested = candidatePath(staticRoot, url.pathname);
    if (!requested) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid path.\n");
      return;
    }
    const details = await stat(requested).catch(() => null);
    const filePath = details?.isFile() ? requested : indexPath;
    const file = await stat(filePath).catch(() => null);
    if (!file?.isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Application assets are unavailable.\n");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const immutable = filePath !== indexPath && url.pathname.startsWith("/assets/");
    response.writeHead(200, {
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "content-length": file.size,
      "content-type": contentTypes.get(extension) ?? "application/octet-stream",
      "x-content-type-options": "nosniff"
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath)
      .on("error", () => response.destroy())
      .pipe(response);
  };
};
