import assert from "node:assert/strict";
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

test("artwork scheduler queues only videos without current posters and staggers disk work", () => {
  const sources = [
    { contentRevision: 2, id: "source-missing" },
    { contentRevision: 1, id: "source-remote" },
    { contentRevision: 3, id: "source-current" }
  ];
  const items = sources.map((source, index) => ({
    id: `item-${index}`,
    mediaKind: "video",
    metadata: index === 1 ? { posterUrl: "https://images.example/poster.jpg" } : {},
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
      assert.deepEqual(query, { availability: "available", mediaKind: "video" });
      return items;
    }
  };
  const queued = [];
  const result = createArtworkScheduler({ repository }).enqueueMissing((job) => queued.push(job), {
    availableAt: 10_000,
    intervalMs: 2_500
  });

  assert.deepEqual(result, { queued: 2 });
  assert.deepEqual(queued.map(({ availableAt, dedupeKey }) => ({ availableAt, dedupeKey })), [
    { availableAt: 10_000, dedupeKey: "source-missing:2" },
    { availableAt: 12_500, dedupeKey: "source-remote:1" }
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
  assert.equal(ready.posterUrl, `/api/cinema/artwork?sourceId=${item.source.id}&revision=1`);
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
