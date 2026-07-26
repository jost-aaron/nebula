import path from "node:path";
import { createCatalogRepository } from "../server/catalog/index.mjs";
import { openNebulaDatabase } from "../server/database.mjs";
import { createJobsRepository, createJobsService } from "../server/jobs/index.mjs";

const contentPath = String(process.argv[2] ?? "").trim();
if (!contentPath) throw new Error("Usage: node scripts/enqueue-music-metadata.mjs <content-relative-audio-path>");

const dataRoot = path.resolve(process.env.NEBULA_DATA_ROOT || "./data");
const database = await openNebulaDatabase(path.join(dataRoot, "nebula.sqlite"));
try {
  const catalog = createCatalogRepository(database);
  let resolved = catalog.resolveContentPath(contentPath);
  if (!resolved?.source) {
    const matches = catalog.listItems({ availability: "available", mediaKind: "audio" })
      .filter((item) => item.source.path === contentPath || item.source.path.endsWith(`/${contentPath}`) || contentPath.endsWith(`/${item.source.path}`));
    if (matches.length === 1) resolved = { item: matches[0], source: matches[0].source };
  }
  if (!resolved?.source || resolved.source.mediaKind !== "audio") {
    throw new Error("The requested audio source is not present in the catalog.");
  }
  const jobs = createJobsService({ repository: createJobsRepository({ db: database }) });
  const job = jobs.enqueue({
    availableAt: Date.now(),
    dedupeKey: `manual-music:${resolved.source.id}:${resolved.source.contentRevision}:${Date.now()}`,
    maxAttempts: 1,
    payload: { sourceId: resolved.source.id },
    type: "metadata"
  });
  console.log(JSON.stringify({ contentPath, jobId: job.id, sourceId: resolved.source.id }));
} finally {
  database.close();
}
