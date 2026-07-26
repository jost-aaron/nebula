import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  buildArtworkArguments,
  createArtworkScheduler,
  createArtworkService,
  generatedArtworkRelativePath
} from "../server/artwork/index.mjs";
import { createCinemaRoutes } from "../server/cinema.mjs";
import {
  applyCatalogMigration,
  bootstrapSharedContentRoot,
  createCatalogRepository,
  scanLocalRoot
} from "../server/catalog/index.mjs";
import { projectRepositoryItemsPage } from "../server/catalog/projections.mjs";

const setup = async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nebula-artwork-test-"));
  const contentRoot = path.join(directory, "content");
  const dataRoot = path.join(directory, "data");
  await Promise.all([mkdir(contentRoot), mkdir(dataRoot)]);
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyCatalogMigration(database);
  const repository = createCatalogRepository(database);
  const { root } = bootstrapSharedContentRoot(repository, { contentRoot });
  t.after(async () => {
    database.close();
    await rm(directory, { force: true, recursive: true });
  });
  return { contentRoot, dataRoot, repository, root };
};

test("artwork service captures and publishes a revisioned persistent title card", async (t) => {
  const { contentRoot, dataRoot, repository, root } = await setup(t);
  await writeFile(path.join(contentRoot, "Film.mp4"), "video fixture");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const source = repository.resolveContentPath("Film.mp4", root.id);
  const calls = [];
  const progress = [];
  const service = createArtworkService({
    contentRoot,
    dataRoot,
    repository,
    resolveSource: (sourceId) => repository.getSource(sourceId),
    runner: async (inputPath, outputPath, options) => {
      calls.push({ inputPath, options });
      await writeFile(outputPath, Buffer.alloc(256, 7));
    }
  });

  const result = await service.generate(
    { contentRevision: source.contentRevision, sourceId: source.id },
    { reportProgress: (value, stage) => progress.push({ stage, value }) }
  );

  assert.deepEqual(result, { contentRevision: 1, height: 480, sourceId: source.id, width: 320 });
  assert.equal(calls[0].inputPath, path.join(contentRoot, "Film.mp4"));
  assert.deepEqual(calls[0].options, { height: 480, seekSeconds: 12, width: 320 });
  assert.deepEqual(progress.map(({ stage }) => stage), ["capturing-frame", "publishing-artwork", "artwork-ready"]);
  const relativePath = generatedArtworkRelativePath(source.id, source.contentRevision);
  assert.equal((await readFile(path.join(dataRoot, ...relativePath.split("/")))).length, 256);
  assert.deepEqual(repository.listArtwork(source.itemId).map(({ localPath, provider, type }) => ({ localPath, provider, type })), [{
    localPath: relativePath,
    provider: "nebula-frame",
    type: "poster"
  }]);

  await assert.rejects(
    service.generate({ contentRevision: source.contentRevision + 1, sourceId: source.id }),
    (error) => error.code === "ARTWORK_SOURCE_CHANGED"
  );
});

test("artwork scheduler queues missing video cards and recoverable audio covers while staggering disk work", () => {
  const sources = [
    { contentRevision: 2, id: "source-missing", mediaKind: "video" },
    { contentRevision: 1, id: "source-remote", mediaKind: "video" },
    { contentRevision: 3, id: "source-current", mediaKind: "video" },
    { contentRevision: 1, id: "source-audio-cover", mediaKind: "audio" },
    { contentRevision: 1, id: "source-audio-empty", mediaKind: "audio" }
  ];
  const items = sources.map((source, index) => ({
    id: `item-${index}`,
    mediaKind: source.mediaKind,
    metadata: index === 1 || index === 3 ? { posterUrl: "https://images.example/poster.jpg" } : {},
    source
  }));
  const repository = {
    listArtwork: (itemId) => itemId === "item-2" ? [{
      localPath: generatedArtworkRelativePath("source-current", 3),
      provider: "nebula-frame",
      remoteUrl: "",
      type: "poster"
    }] : [],
    listItems: (query) => {
      assert.deepEqual(query, { availability: "available" });
      return items;
    }
  };
  const queued = [];
  const result = createArtworkScheduler({ repository }).enqueueMissing((job) => queued.push(job), {
    availableAt: 10_000,
    intervalMs: 2_500
  });

  assert.deepEqual(result, { queued: 3 });
  assert.deepEqual(queued.map(({ availableAt, dedupeKey }) => ({ availableAt, dedupeKey })), [
    { availableAt: 10_000, dedupeKey: "source-missing:2" },
    { availableAt: 12_500, dedupeKey: "source-remote:1" },
    { availableAt: 15_000, dedupeKey: "source-audio-cover:1" }
  ]);
});

test("catalog projection exposes queued, processing, and ready artwork states", async (t) => {
  const { contentRoot, repository, root } = await setup(t);
  await writeFile(path.join(contentRoot, "Film.mp4"), "video fixture");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const item = repository.listItems({ mediaKind: "video" })[0];
  const project = (state) => projectRepositoryItemsPage(repository, {
    artworkJobForSource: () => ({ state }),
    availability: "available",
    mediaKind: "video"
  }).entries[0];

  assert.equal(project("queued").artworkState, "queued");
  assert.equal(project("running").artworkState, "processing");
  repository.putGeneratedArtwork(item.source.id, {
    expectedContentRevision: item.source.contentRevision,
    height: 480,
    localPath: generatedArtworkRelativePath(item.source.id, item.source.contentRevision),
    width: 320
  });
  const ready = project("running");
  assert.equal(ready.artworkState, "processing");
  assert.match(ready.posterUrl, new RegExp(`^/api/cinema/artwork\\?sourceId=${item.source.id}&revision=1&artwork=`));
});

test("catalog page projection bulk-loads enrichment and job state", () => {
  const items = ["a", "b"].map((suffix) => ({
    id: `item-${suffix}`,
    itemType: "track",
    mediaKind: "audio",
    metadata: {},
    sortTitle: suffix,
    source: {
      availability: "available",
      contentRevision: 1,
      id: `source-${suffix}`,
      mediaKind: "audio",
      modifiedMs: 0,
      path: `${suffix}.mp3`,
      size: 1
    },
    title: suffix
  }));
  let artworkBulkCalls = 0;
  let externalBulkCalls = 0;
  let jobBulkCalls = 0;
  const repository = {
    listArtwork: () => { throw new Error("per-item artwork lookup was used"); },
    listArtworkMany: (ids) => {
      artworkBulkCalls += 1;
      return new Map(ids.map((id) => [id, []]));
    },
    listExternalIds: () => { throw new Error("per-item external ID lookup was used"); },
    listExternalIdsMany: (ids) => {
      externalBulkCalls += 1;
      return new Map(ids.map((id) => [id, []]));
    },
    listItemsPage: () => ({ items, limit: 100, offset: 0, total: 2 })
  };
  const page = projectRepositoryItemsPage(repository, {
    artworkJobsForSources: (sources) => {
      jobBulkCalls += 1;
      return [{ dedupeKey: `${sources[0].id}:1`, state: "queued" }];
    }
  });
  assert.deepEqual([artworkBulkCalls, externalBulkCalls, jobBulkCalls], [1, 1, 1]);
  assert.equal(page.entries[0].artworkState, "queued");
  assert.equal(page.entries[1].artworkState, "missing");
});

test("remote metadata promotes an existing generated frame to the provider poster", async (t) => {
  const { contentRoot, dataRoot, repository, root } = await setup(t);
  await writeFile(path.join(contentRoot, "Film.mp4"), "video fixture");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const item = repository.listItems({ mediaKind: "video" })[0];
  const service = createArtworkService({
    contentRoot,
    dataRoot,
    fetchImpl: async () => new Response(Buffer.alloc(512, 9), {
      headers: { "content-type": "image/jpeg" },
      status: 200
    }),
    repository,
    resolveSource: (sourceId) => repository.getSource(sourceId),
    runner: async (_input, output) => writeFile(output, Buffer.alloc(256, 7))
  });
  await service.generate({ contentRevision: 1, sourceId: item.source.id });
  repository.putExternalMetadata(item.id, {
    fields: { posterUrl: "https://image.tmdb.org/t/p/w500/promoted.jpg" },
    mode: "provider"
  });
  const promoted = await service.generate({ contentRevision: 1, sourceId: item.source.id });
  assert.equal(promoted.cached, true);
  const artwork = repository.listArtwork(item.id);
  assert.equal(artwork.some(({ provider }) => provider === "tmdb-cache"), true);
  assert.equal(artwork.some(({ provider }) => provider === "nebula-frame"), false);
});

test("artwork service downloads and publishes a TMDB poster for offline use", async (t) => {
  const { contentRoot, dataRoot, repository, root } = await setup(t);
  await writeFile(path.join(contentRoot, "Film.mp4"), "video fixture");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const item = repository.listItems({ mediaKind: "video" })[0];
  repository.putExternalMetadata(item.id, {
    fields: { posterUrl: "https://image.tmdb.org/t/p/w500/example.jpg" },
    mode: "provider"
  });
  const service = createArtworkService({
    contentRoot,
    dataRoot,
    fetchImpl: async () => new Response(Buffer.alloc(512, 9), {
      headers: { "content-type": "image/jpeg" },
      status: 200
    }),
    repository,
    resolveSource: (sourceId) => repository.getSource(sourceId)
  });
  const result = await service.generate({
    contentRevision: item.source.contentRevision,
    sourceId: item.source.id
  });
  assert.equal(result.cached, true);
  const cached = repository.listArtwork(item.id).find(({ provider }) => provider === "tmdb-cache");
  assert.ok(cached?.localPath.endsWith(".tmdb.jpg"));
  assert.equal((await readFile(path.join(dataRoot, ...cached.localPath.split("/")))).length, 512);
});

test("artwork service downloads MusicBrainz cover art for audio without video capture", async (t) => {
  const { contentRoot, dataRoot, repository, root } = await setup(t);
  await writeFile(path.join(contentRoot, "Track.flac"), "audio fixture");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const item = repository.listItems({ mediaKind: "audio" })[0];
  repository.putExternalMetadata(item.id, {
    fields: { posterUrl: "https://coverartarchive.org/release/example/front-500" },
    mode: "provider"
  });
  let captureCalls = 0;
  const service = createArtworkService({
    contentRoot,
    dataRoot,
    fetchImpl: async () => new Response(Buffer.alloc(512, 4), {
      headers: { "content-type": "image/jpeg" },
      status: 200
    }),
    repository,
    resolveSource: (sourceId) => repository.getSource(sourceId),
    runner: async () => { captureCalls += 1; }
  });
  const result = await service.generate({
    contentRevision: item.source.contentRevision,
    sourceId: item.source.id
  });
  assert.equal(result.cached, true);
  assert.equal(captureCalls, 0);
  assert.equal(repository.listArtwork(item.id).some(({ localPath }) => localPath), true);
});

test("shared artwork route serves locally cached MusicBrainz cover art for audio sources", async (t) => {
  const { contentRoot, dataRoot, repository, root } = await setup(t);
  await writeFile(path.join(contentRoot, "Track.flac"), "audio fixture");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const item = repository.listItems({ mediaKind: "audio" })[0];
  const relativePath = generatedArtworkRelativePath(item.source.id, item.source.contentRevision);
  const cover = Buffer.alloc(512, 4);
  await mkdir(path.dirname(path.join(dataRoot, relativePath)), { recursive: true });
  await writeFile(path.join(dataRoot, relativePath), cover);
  repository.putGeneratedArtwork(item.source.id, {
    expectedContentRevision: item.source.contentRevision,
    height: 500,
    localPath: relativePath,
    provider: "musicbrainz-cache",
    width: 500
  });
  const authorizedKinds = [];
  const route = createCinemaRoutes({ dataRoot }, {
    getWatchlist: () => new Set(),
    migrateLegacyWatchlist: () => undefined
  }, {
    catalog: { repository },
    libraryPermissions: {
      canAccessPath: (_context, _path, mediaKind) => {
        authorizedKinds.push(mediaKind);
        return true;
      }
    }
  });
  const server = createServer(async (request, response) => {
    request.nebulaAuth = { kind: "account", user: { id: "owner_01", role: "owner" } };
    const url = new URL(request.url, "http://nebula");
    try {
      if (!await route(request, response, url)) response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" }).end(error.stack ?? error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/cinema/artwork?sourceId=${encodeURIComponent(item.source.id)}&revision=${item.source.contentRevision}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), cover);
  assert.deepEqual(authorizedKinds, ["audio"]);
});

test("manual Cinema metadata edits update the canonical catalog and queue poster refresh", async (t) => {
  const { contentRoot, dataRoot, repository, root } = await setup(t);
  await writeFile(path.join(contentRoot, "Film.mp4"), "video fixture");
  await scanLocalRoot({ absoluteRoot: contentRoot, repository, rootId: root.id });
  const queued = [];
  const route = createCinemaRoutes({
    cinemaMetadataPath: path.join(contentRoot, ".cinema-metadata.json"),
    contentRoot,
    dataRoot,
    relativePath: (value) => value,
    resolveContentPath: (value) => path.resolve(contentRoot, value)
  }, {
    getWatchlist: () => new Set(),
    migrateLegacyWatchlist: () => undefined
  }, {
    catalog: { repository },
    jobs: { enqueue: (job) => queued.push(job) }
  });
  const server = createServer(async (request, response) => {
    request.nebulaAuth = { kind: "account", user: { id: "owner_01", role: "owner" } };
    const url = new URL(request.url, "http://nebula");
    try {
      if (!await route(request, response, url)) response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" }).end(error.stack ?? error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/cinema/metadata`, {
    body: JSON.stringify({
      path: "Film.mp4",
      posterUrl: "https://image.tmdb.org/t/p/w500/manual.jpg",
      title: "Manual Film"
    }),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const item = repository.listItems({ mediaKind: "video" })[0];
  assert.equal(repository.getItem(item.id).title, "Manual Film");
  assert.equal(repository.getItem(item.id).lockedFields.includes("title"), true);
  assert.equal(queued[0].type, "artwork");
});

test("FFmpeg title-card arguments capture one bounded portrait frame without a shell", () => {
  const args = buildArtworkArguments("/media/input movie.mkv", "/cache/output.jpg");
  assert.deepEqual(args.slice(0, 8), ["-nostdin", "-v", "error", "-ss", "12", "-i", "/media/input movie.mkv", "-map"]);
  assert.ok(args.includes("scale=320:480:force_original_aspect_ratio=increase,crop=320:480"));
  assert.ok(args.includes("1"));
  assert.deepEqual(args.slice(-3), ["-y", "--", "/cache/output.jpg"]);
});

test("API composition passes the shared jobs service into Cinema projections", async () => {
  const api = await readFile(new URL("../server/api.mjs", import.meta.url), "utf8");
  assert.match(api, /createCinemaRoutes\([\s\S]*?jobs: options\.jobs/);
});
