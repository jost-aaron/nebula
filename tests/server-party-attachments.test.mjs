import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  createPartyAttachmentService,
  sanitizePartyAttachmentName
} from "../server/party/attachments.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64"
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
const conversationId = "00000000-0000-4000-8000-000000000101";
const memberId = "00000000-0000-4000-8000-000000000201";
const strangerId = "00000000-0000-4000-8000-000000000202";

const uuidSequence = () => {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
};

const streamRequest = (bytes, {
  contentLength = String(bytes.length),
  contentType = "application/octet-stream",
  chunks = [bytes]
} = {}) => {
  const request = Readable.from(chunks);
  request.headers = {
    ...(contentLength === null ? {} : { "content-length": contentLength }),
    ...(contentType === null ? {} : { "content-type": contentType })
  };
  return request;
};

const setup = async (t, options = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-party-attachments-"));
  const dataRoot = path.join(root, "data");
  const attachments = new Map();
  const members = new Set([memberId]);
  let usage = options.usage ?? 0;
  const service = createPartyAttachmentService({
    conversationQuotaBytes: options.conversationQuotaBytes ?? 1024 * 1024,
    dataRoot,
    getAttachment: async ({ attachmentId }) => attachments.get(attachmentId) ?? null,
    getConversationAttachmentBytes: async () => usage,
    isConversationMember: async ({ conversationId: requestedConversationId, userId }) =>
      requestedConversationId === conversationId && members.has(userId),
    maxFileBytes: options.maxFileBytes ?? 1024 * 1024,
    now: options.now ?? (() => new Date("2026-07-25T12:00:00.000Z")),
    tempMaxAgeMs: options.tempMaxAgeMs ?? 60_000,
    uuid: uuidSequence()
  });
  const commit = async (metadata) => {
    attachments.set(metadata.id, metadata);
    usage += metadata.sizeBytes;
    return {
      message: {
        attachments: [{
          id: metadata.id,
          name: metadata.displayName,
          mimeType: metadata.mimeType,
          size: metadata.sizeBytes
        }],
        id: "message-1"
      }
    };
  };
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  return {
    attachments,
    commit,
    dataRoot,
    member: (userId, enabled) => enabled ? members.add(userId) : members.delete(userId),
    service,
    usage: () => usage
  };
};

const allFiles = async (root) => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
};

test("startup removes only stale generated upload temporaries", async (t) => {
  const scope = await setup(t, {
    now: () => new Date("2026-07-25T12:00:00.000Z"),
    tempMaxAgeMs: 60_000
  });
  await mkdir(scope.service.tempRoot, { recursive: true });
  const stale = path.join(scope.service.tempRoot, "00000000-0000-4000-8000-000000000901.upload");
  const fresh = path.join(scope.service.tempRoot, "00000000-0000-4000-8000-000000000902.upload");
  const unrelated = path.join(scope.service.tempRoot, "operator-note.txt");
  await Promise.all([writeFile(stale, "old"), writeFile(fresh, "new"), writeFile(unrelated, "keep")]);
  await utimes(stale, new Date("2026-07-25T11:00:00.000Z"), new Date("2026-07-25T11:00:00.000Z"));
  await utimes(fresh, new Date("2026-07-25T11:59:30.000Z"), new Date("2026-07-25T11:59:30.000Z"));

  assert.deepEqual(await scope.service.initialize(), { inspected: 3, removed: 1 });
  assert.deepEqual((await readdir(scope.service.tempRoot)).sort(), [
    "00000000-0000-4000-8000-000000000902.upload",
    "operator-note.txt"
  ]);
});

test("raw upload sanitizes metadata, detects content, hashes bytes, and publishes under the private data root", async (t) => {
  const scope = await setup(t);
  await scope.service.initialize();
  let committed;
  const result = await scope.service.upload({
    clientMessageId: "client-1",
    commit: async (metadata, context) => {
      committed = { context, metadata };
      return scope.commit(metadata);
    },
    conversationId,
    declaredMimeType: "application/octet-stream",
    displayName: "../\u202e family/photo?.png ",
    request: streamRequest(PNG, { chunks: [PNG.subarray(0, 9), PNG.subarray(9)] }),
    userId: memberId
  });

  assert.equal(result.message.attachments[0].mimeType, "image/png");
  assert.equal(committed.metadata.displayName, "_ family_photo_.png");
  assert.equal(committed.metadata.sha256, createHash("sha256").update(PNG).digest("hex"));
  assert.equal(committed.metadata.sizeBytes, PNG.length);
  assert.equal(committed.metadata.uploaderUserId, memberId);
  assert.match(committed.metadata.storageKey, /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f-]{36}\.blob$/);
  assert.deepEqual(committed.context, {
    clientMessageId: "client-1",
    conversationQuotaBytes: 1024 * 1024
  });
  const filePath = scope.service.resolveStorageKey(committed.metadata.storageKey);
  assert.equal(path.relative(scope.dataRoot, filePath).startsWith("party-attachments"), true);
  assert.deepEqual(await readFile(filePath), PNG);
  assert.deepEqual(await readdir(scope.service.tempRoot), []);
});

test("serving reauthorizes GET, HEAD, download, and single byte ranges without leaking denied attachments", async (t) => {
  const scope = await setup(t);
  await scope.service.initialize();
  let metadata;
  await scope.service.upload({
    commit: async (value) => {
      metadata = value;
      return scope.commit(value);
    },
    conversationId,
    declaredMimeType: "application/pdf",
    displayName: "family archive.pdf",
    request: streamRequest(PDF, { contentType: "application/pdf" }),
    userId: memberId
  });

  const server = createServer(async (request, response) => {
    try {
      await scope.service.serve({
        attachmentId: request.url.split("?", 1)[0].slice(1),
        download: new URL(request.url, "http://nebula").searchParams.get("download") === "1",
        request,
        response,
        userId: request.headers["x-user"] ?? memberId
      });
    } catch (error) {
      response.writeHead(error.status ?? 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const full = await fetch(`${origin}/${metadata.id}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "application/pdf");
  assert.match(full.headers.get("content-disposition"), /^inline;/);
  assert.equal(full.headers.get("x-content-type-options"), "nosniff");
  assert.equal(full.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), PDF);

  const head = await fetch(`${origin}/${metadata.id}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(PDF.length));
  assert.equal(await head.text(), "");

  const range = await fetch(`${origin}/${metadata.id}`, { headers: { range: "bytes=5-13" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 5-13/${PDF.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), PDF.subarray(5, 14));

  const invalidRange = await fetch(`${origin}/${metadata.id}`, { headers: { range: "bytes=0-1,4-5" } });
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get("content-range"), `bytes */${PDF.length}`);

  const download = await fetch(`${origin}/${metadata.id}?download=1`);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);

  const denied = await fetch(`${origin}/${metadata.id}`, { headers: { "x-user": strangerId } });
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { error: "Attachment not found." });
});

test("strict storage keys and realpath checks prevent traversal and cross-root reads", async (t) => {
  const scope = await setup(t);
  await scope.service.initialize();
  const outside = path.join(scope.dataRoot, "outside-secret.txt");
  await writeFile(outside, "do not expose");
  scope.attachments.set("00000000-0000-4000-8000-000000000777", {
    conversationId,
    displayName: "secret.txt",
    id: "00000000-0000-4000-8000-000000000777",
    mimeType: "text/plain",
    sizeBytes: 13,
    storageKey: "../../outside-secret.txt"
  });
  assert.throws(
    () => scope.service.resolveStorageKey("../../outside-secret.txt"),
    (error) => error.status === 404 && error.code === "PARTY_ATTACHMENT_NOT_FOUND"
  );

  const request = { headers: {}, method: "GET" };
  const response = { end: () => {}, writeHead: () => {} };
  await assert.rejects(
    scope.service.serve({
      attachmentId: "00000000-0000-4000-8000-000000000777",
      request,
      response,
      userId: memberId
    }),
    (error) => error.status === 404 && error.code === "PARTY_ATTACHMENT_NOT_FOUND"
  );
  assert.equal(await readFile(outside, "utf8"), "do not expose");
});

test("uploads reject missing lengths, quota excess, unsafe active content, and common MIME mismatches", async (t) => {
  const scope = await setup(t, { conversationQuotaBytes: PNG.length - 1 });
  await scope.service.initialize();
  const upload = (request, declaredMimeType = request.headers["content-type"]) => scope.service.upload({
    commit: scope.commit,
    conversationId,
    declaredMimeType,
    displayName: "fixture.bin",
    request,
    userId: memberId
  });

  await assert.rejects(
    upload(streamRequest(PNG, { contentLength: null })),
    (error) => error.status === 411 && error.code === "PARTY_ATTACHMENT_LENGTH_REQUIRED"
  );
  await assert.rejects(
    upload(streamRequest(PNG)),
    (error) => error.status === 413 && error.code === "PARTY_ATTACHMENT_QUOTA_EXCEEDED"
  );

  const relaxed = await setup(t);
  await relaxed.service.initialize();
  const rejected = (bytes, contentType) => relaxed.service.upload({
    commit: relaxed.commit,
    conversationId,
    declaredMimeType: contentType,
    displayName: "fixture",
    request: streamRequest(bytes, { contentType }),
    userId: memberId
  });
  await assert.rejects(
    rejected(PNG, "image/jpeg"),
    (error) => error.status === 415 && error.code === "PARTY_ATTACHMENT_MIME_MISMATCH"
  );
  await assert.rejects(
    rejected(Buffer.from("<!doctype html><script>alert(1)</script>"), "application/octet-stream"),
    (error) => error.status === 415 && error.code === "PARTY_ATTACHMENT_MIME_MISMATCH"
  );
  await assert.rejects(
    rejected(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml"),
    (error) => error.status === 415 && error.code === "PARTY_ATTACHMENT_TYPE_DENIED"
  );
  assert.deepEqual(await allFiles(relaxed.service.tempRoot), []);
});

test("abort and transactional commit failures remove temporary and published bytes", async (t) => {
  const scope = await setup(t);
  await scope.service.initialize();
  const failedRequest = Readable.from((async function* () {
    yield PNG.subarray(0, 8);
    throw new Error("client disconnected");
  })());
  failedRequest.headers = {
    "content-length": String(PNG.length),
    "content-type": "image/png"
  };
  Object.defineProperty(failedRequest, "aborted", { value: true });
  await assert.rejects(
    scope.service.upload({
      commit: scope.commit,
      conversationId,
      declaredMimeType: "image/png",
      displayName: "cancelled.png",
      request: failedRequest,
      userId: memberId
    }),
    (error) => error.code === "PARTY_ATTACHMENT_ABORTED"
  );
  assert.deepEqual(await allFiles(scope.service.attachmentRoot), []);

  await assert.rejects(
    scope.service.upload({
      commit: async () => { throw Object.assign(new Error("database rolled back"), { status: 409 }); },
      conversationId,
      declaredMimeType: "image/png",
      displayName: "rollback.png",
      request: streamRequest(PNG, { contentType: "image/png" }),
      userId: memberId
    }),
    /database rolled back/
  );
  assert.deepEqual(await allFiles(scope.service.attachmentRoot), []);
});

test("display-name sanitization never treats caller names as storage paths", () => {
  assert.equal(sanitizePartyAttachmentName("../../"), "attachment");
  assert.equal(sanitizePartyAttachmentName("line\r\nbreak\u202ename.txt"), "linebreakname.txt");
  assert.equal(sanitizePartyAttachmentName(" family / plans?.zip "), "family _ plans_.zip");
});
