import path from "node:path";
import { stat } from "node:fs/promises";
import { createCatalogRepository } from "../server/catalog/index.mjs";
import { openNebulaDatabase } from "../server/database.mjs";

const filename = String(process.argv[2] ?? "").trim();
if (!filename) throw new Error("Usage: node scripts/inspect-music-metadata.mjs <audio-filename-or-path>");

const dataRoot = path.resolve(process.env.NEBULA_DATA_ROOT || "./data");
const database = await openNebulaDatabase(path.join(dataRoot, "nebula.sqlite"));
try {
  const catalog = createCatalogRepository(database);
  const matches = catalog.listItems({ availability: "available", mediaKind: "audio" })
    .filter((item) => item.source.path === filename || item.source.path.endsWith(`/${filename}`));
  if (matches.length !== 1) throw new Error(`Expected one matching audio item, found ${matches.length}.`);
  const item = matches[0];
  const artwork = catalog.listArtwork(item.id);
  const localArtwork = artwork.find((entry) => entry.localPath);
  const artworkExists = localArtwork
    ? Boolean(await stat(path.join(dataRoot, ...localArtwork.localPath.split("/"))).catch(() => null))
    : false;
  const job = database.prepare(`SELECT id, state, current_stage AS progressStage, error_code AS errorCode
    FROM background_jobs WHERE type = 'metadata' AND json_extract(payload_json, '$.sourceId') = ?
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(item.source.id) ?? null;
  console.log(JSON.stringify({
    album: item.metadata?.album ?? "",
    artist: item.metadata?.artist ?? "",
    artworkExists,
    artworkLocalPath: localArtwork?.localPath ?? "",
    externalIds: catalog.listExternalIds(item.id),
    job,
    matchStatus: item.metadata?.musicbrainzMatchStatus ?? "",
    posterUrl: item.metadata?.posterUrl ?? "",
    title: item.title
  }, null, 2));
} finally {
  database.close();
}
