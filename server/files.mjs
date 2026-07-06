import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { json, readBody } from "./http.mjs";
import { isMediaFile, mimeType, safeFileName } from "./storage.mjs";

export const createFilesRoutes = (storage) => {
  const uploadSessionPath = (id) => {
    if (!/^[a-f0-9-]{36}$/i.test(id)) {
      throw Object.assign(new Error("Upload session not found."), { status: 404 });
    }

    return path.join(storage.uploadRoot, id);
  };

  const readUploadSession = async (id) => {
    const sessionPath = uploadSessionPath(id);
    const metadata = JSON.parse(await readFile(path.join(sessionPath, "metadata.json"), "utf8"));
    return { metadata, sessionPath };
  };

  const uploadedParts = async (sessionPath) => {
    const chunksPath = path.join(sessionPath, "chunks");
    const names = await readdir(chunksPath).catch(() => []);
    const parts = await Promise.all(
      names
        .filter((name) => /^part-\d+$/.test(name))
        .map(async (name) => {
          const index = Number(name.replace("part-", ""));
          const partStats = await stat(path.join(chunksPath, name));
          return { index, size: partStats.size };
        })
    );

    return parts.sort((a, b) => a.index - b.index);
  };

  const entryType = (stats) => {
    if (stats.isDirectory()) {
      return "folder";
    }

    return "file";
  };

  const listDirectory = async (request, response, url) => {
    const requestedPath = url.searchParams.get("path") ?? "";
    const absolutePath = storage.resolveContentPath(requestedPath);
    const stats = await stat(absolutePath).catch(() => null);

    if (!stats || !stats.isDirectory()) {
      json(response, 404, { error: "Folder not found." });
      return;
    }

    const entries = await Promise.all(
      (await readdir(absolutePath)).filter((name) => name !== ".uploads").map(async (name) => {
        const entryPath = path.join(absolutePath, name);
        const entryStats = await stat(entryPath);

        return {
          modifiedAt: entryStats.mtime.toISOString(),
          name,
          path: storage.toContentPath(entryPath),
          size: entryStats.size,
          type: entryType(entryStats)
        };
      })
    );

    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "folder" ? -1 : 1;
      }

      return a.name.localeCompare(b.name);
    });

    json(response, 200, {
      entries,
      path: storage.toContentPath(absolutePath)
    });
  };

  const readContentFile = async (request, response, url) => {
    const requestedPath = url.searchParams.get("path") ?? "";
    const absolutePath = storage.resolveContentPath(requestedPath);
    const stats = await stat(absolutePath).catch(() => null);

    if (!stats || !stats.isFile()) {
      json(response, 404, { error: "File not found." });
      return;
    }

    if (stats.size > 1024 * 1024) {
      json(response, 413, { error: "Preview supports files up to 1 MB." });
      return;
    }

    response.writeHead(200, {
      "content-type": mimeType(absolutePath)
    });
    response.end(await readFile(absolutePath));
  };

  const downloadContentFile = async (request, response, url) => {
    const requestedPath = url.searchParams.get("path") ?? "";
    const absolutePath = storage.resolveContentPath(requestedPath);
    const stats = await stat(absolutePath).catch(() => null);

    if (!stats || !stats.isFile()) {
      json(response, 404, { error: "File not found." });
      return;
    }

    response.writeHead(200, {
      "content-disposition": `attachment; filename="${path.basename(absolutePath).replaceAll('"', "")}"`,
      "content-length": stats.size,
      "content-type": mimeType(absolutePath)
    });
    createReadStream(absolutePath).pipe(response);
  };

  const createFolder = async (request, response) => {
    const body = await readBody(request);
    const absolutePath = storage.resolveContentPath(path.join(body.path ?? "", body.name ?? ""));
    await mkdir(absolutePath, { recursive: false });
    json(response, 201, { ok: true, path: storage.toContentPath(absolutePath) });
  };

  const createTextFile = async (request, response) => {
    const body = await readBody(request);
    const absolutePath = storage.resolveContentPath(path.join(body.path ?? "", body.name ?? ""));
    await writeFile(absolutePath, body.content ?? "", { flag: "wx" });
    json(response, 201, { ok: true, path: storage.toContentPath(absolutePath) });
  };

  const uploadFile = async (request, response) => {
    const body = await readBody(request);
    const absolutePath = storage.resolveContentPath(path.join(body.path ?? "", body.name ?? ""));
    await writeFile(absolutePath, Buffer.from(body.contentBase64 ?? "", "base64"), { flag: "wx" });
    json(response, 201, { ok: true, path: storage.toContentPath(absolutePath) });
  };

  const uploadFileStream = async (request, response, url) => {
    const requestedPath = url.searchParams.get("path") ?? "";
    const name = url.searchParams.get("name") ?? "";

    if (!safeFileName(name)) {
      json(response, 400, { error: "A file name is required." });
      return;
    }

    const absolutePath = storage.resolveContentPath(path.join(requestedPath, name));
    const stream = createWriteStream(absolutePath, { flags: "wx" });

    try {
      await new Promise((resolve, reject) => {
        request.on("aborted", () => reject(Object.assign(new Error("Upload cancelled."), { aborted: true })));
        request.on("error", reject);
        stream.on("error", reject);
        stream.on("finish", resolve);
        request.pipe(stream);
      });

      json(response, 201, { ok: true, path: storage.toContentPath(absolutePath) });
    } catch (error) {
      stream.destroy();
      await rm(absolutePath, { force: true }).catch(() => {});

      if (error.aborted) {
        return;
      }

      throw error;
    }
  };

  const createUploadSession = async (request, response) => {
    const body = await readBody(request);
    const name = body.name ?? "";
    const requestedPath = body.path ?? "";
    const size = Number(body.size ?? 0);
    const chunkSize = Number(body.chunkSize ?? 0);

    if (!safeFileName(name)) {
      json(response, 400, { error: "A file name is required." });
      return;
    }

    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      json(response, 400, { error: "Upload size and chunk size are required." });
      return;
    }

    const targetPath = storage.resolveContentPath(path.join(requestedPath, name));
    const existing = await stat(targetPath).catch(() => null);

    if (existing) {
      json(response, 409, { error: "A file with that name already exists." });
      return;
    }

    const id = randomUUID();
    const sessionPath = uploadSessionPath(id);
    const now = new Date().toISOString();
    const metadata = {
      chunkSize,
      createdAt: now,
      id,
      name,
      path: storage.relativePath(requestedPath),
      size,
      target: storage.toContentPath(targetPath),
      type: body.type ?? "",
      updatedAt: now
    };

    await mkdir(path.join(sessionPath, "chunks"), { recursive: true });
    await writeFile(path.join(sessionPath, "metadata.json"), JSON.stringify(metadata, null, 2));
    json(response, 201, { ...metadata, uploadedParts: [] });
  };

  const getUploadSession = async (request, response, id) => {
    const { metadata, sessionPath } = await readUploadSession(id);
    json(response, 200, { ...metadata, uploadedParts: await uploadedParts(sessionPath) });
  };

  const uploadChunk = async (request, response, id, partIndex) => {
    const index = Number(partIndex);

    if (!Number.isSafeInteger(index) || index < 0) {
      json(response, 400, { error: "Chunk index is invalid." });
      return;
    }

    const { metadata, sessionPath } = await readUploadSession(id);
    const chunksPath = path.join(sessionPath, "chunks");
    const partPath = path.join(chunksPath, `part-${String(index).padStart(8, "0")}`);
    const tempPath = `${partPath}.tmp-${randomUUID()}`;

    try {
      await pipeline(request, createWriteStream(tempPath, { flags: "wx" }));
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }

    const partStats = await stat(tempPath);
    const expectedSize =
      index === Math.ceil(metadata.size / metadata.chunkSize) - 1
        ? metadata.size - metadata.chunkSize * index
        : metadata.chunkSize;

    if (partStats.size !== expectedSize) {
      await rm(tempPath, { force: true });
      json(response, 400, { error: "Chunk size does not match upload metadata." });
      return;
    }

    await rename(tempPath, partPath);
    metadata.updatedAt = new Date().toISOString();
    await writeFile(path.join(sessionPath, "metadata.json"), JSON.stringify(metadata, null, 2));
    json(response, 200, { ok: true, part: { index, size: partStats.size } });
  };

  const appendFileToStream = async (filePath, output) => {
    await new Promise((resolve, reject) => {
      const input = createReadStream(filePath);
      const fail = (error) => {
        input.off("error", fail);
        output.off("error", fail);
        reject(error);
      };
      input.on("error", fail);
      output.on("error", fail);
      input.on("end", () => {
        input.off("error", fail);
        output.off("error", fail);
        resolve();
      });
      input.pipe(output, { end: false });
    });
  };

  const completeUploadSession = async (request, response, id) => {
    const { metadata, sessionPath } = await readUploadSession(id);
    const chunksPath = path.join(sessionPath, "chunks");
    const targetPath = storage.resolveContentPath(metadata.target);
    const partCount = Math.ceil(metadata.size / metadata.chunkSize);
    const tempTarget = `${targetPath}.uploading-${id}`;
    const output = createWriteStream(tempTarget, { flags: "wx" });

    try {
      for (let index = 0; index < partCount; index += 1) {
        const partPath = path.join(chunksPath, `part-${String(index).padStart(8, "0")}`);
        const partStats = await stat(partPath).catch(() => null);

        if (!partStats) {
          throw Object.assign(new Error(`Missing chunk ${index + 1} of ${partCount}.`), { status: 409 });
        }

        await appendFileToStream(partPath, output);
      }

      await new Promise((resolve, reject) => {
        output.on("error", reject);
        output.end(resolve);
      });

      const finalStats = await stat(tempTarget);

      if (finalStats.size !== metadata.size) {
        throw Object.assign(new Error("Completed file size does not match upload metadata."), { status: 409 });
      }

      await rename(tempTarget, targetPath);
      await rm(sessionPath, { force: true, recursive: true });
      json(response, 201, { ok: true, path: storage.toContentPath(targetPath) });
    } catch (error) {
      output.destroy();
      await rm(tempTarget, { force: true }).catch(() => {});
      throw error;
    }
  };

  const cancelUploadSession = async (request, response, id) => {
    await rm(uploadSessionPath(id), { force: true, recursive: true });
    json(response, 200, { ok: true });
  };

  const renameEntry = async (request, response) => {
    const body = await readBody(request);
    const from = storage.resolveContentPath(body.path ?? "");
    const to = storage.resolveContentPath(path.join(path.dirname(body.path ?? ""), body.name ?? ""));
    await rename(from, to);
    json(response, 200, { ok: true, path: storage.toContentPath(to) });
  };

  const deleteEntry = async (request, response, url) => {
    const absolutePath = storage.resolveContentPath(url.searchParams.get("path") ?? "");

    if (absolutePath === storage.contentRoot) {
      json(response, 400, { error: "Cannot delete content root." });
      return;
    }

    await rm(absolutePath, { force: false, recursive: true });
    json(response, 200, { ok: true });
  };

  return async (request, response, url) => {
    if (request.method === "GET" && url.pathname === "/api/files") {
      await listDirectory(request, response, url);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/files/read") {
      await readContentFile(request, response, url);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/files/download") {
      await downloadContentFile(request, response, url);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/files/folder") {
      await createFolder(request, response);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/files/text") {
      await createTextFile(request, response);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/files/upload") {
      await uploadFile(request, response);
      return true;
    }

    if (request.method === "PUT" && url.pathname === "/api/files/upload") {
      await uploadFileStream(request, response, url);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/files/uploads") {
      await createUploadSession(request, response);
      return true;
    }

    const uploadMatch = url.pathname.match(/^\/api\/files\/uploads\/([^/]+)(?:\/chunks\/([^/]+)|\/complete)?$/);

    if (uploadMatch) {
      const [, id, partIndex] = uploadMatch;

      if (request.method === "GET" && partIndex === undefined && !url.pathname.endsWith("/complete")) {
        await getUploadSession(request, response, id);
        return true;
      }

      if (request.method === "PUT" && partIndex !== undefined) {
        await uploadChunk(request, response, id, partIndex);
        return true;
      }

      if (request.method === "POST" && url.pathname.endsWith("/complete")) {
        await completeUploadSession(request, response, id);
        return true;
      }

      if (request.method === "DELETE" && partIndex === undefined && !url.pathname.endsWith("/complete")) {
        await cancelUploadSession(request, response, id);
        return true;
      }
    }

    if (request.method === "POST" && url.pathname === "/api/files/rename") {
      await renameEntry(request, response);
      return true;
    }

    if (request.method === "DELETE" && url.pathname === "/api/files") {
      await deleteEntry(request, response, url);
      return true;
    }

    return false;
  };
};
