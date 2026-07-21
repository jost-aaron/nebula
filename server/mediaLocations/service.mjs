import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

const categories = new Set(["movies", "tv", "music"]);
const fail = (status, code, message) => { throw Object.assign(new Error(message), { code, expose: true, status }); };

const normalizeContentPath = (value) => {
  const input = String(value ?? "").trim().replaceAll("\\", "/").replace(/^\/app\/content(?:\/|$)/i, "");
  const normalized = path.posix.normalize(input).replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized) || normalized === ".uploads" || normalized.startsWith(".uploads/")) {
    fail(400, "invalid_media_location", "Choose a folder beneath the Nebula content root.");
  }
  return normalized;
};

const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

export const createMediaLocationsService = ({ contentRoot, database, now = () => new Date().toISOString(), uuid = randomUUID }) => {
  const list = () => database.prepare("SELECT id, category, content_path AS contentPath, created_at AS createdAt, updated_at AS updatedAt FROM media_locations ORDER BY category, content_path, id").all();
  const add = async ({ category, contentPath }) => {
    const normalizedCategory = String(category ?? "").toLowerCase();
    if (!categories.has(normalizedCategory)) fail(400, "invalid_media_category", "Media category must be movies, tv, or music.");
    const normalizedPath = normalizeContentPath(contentPath);
    const conflicting = list().find((entry) => overlaps(entry.contentPath, normalizedPath));
    if (conflicting) fail(409, "overlapping_media_location", "That folder overlaps an existing media location.");
    const absolutePath = path.resolve(contentRoot, normalizedPath);
    const details = await stat(absolutePath).catch(() => null);
    if (!details?.isDirectory()) fail(404, "media_location_missing", "That media folder does not exist beneath the content root.");
    const timestamp = now();
    const id = uuid();
    database.prepare("INSERT INTO media_locations (id, category, content_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, normalizedCategory, normalizedPath, timestamp, timestamp);
    return list().find((entry) => entry.id === id);
  };
  const remove = (id) => {
    const current = list().find((entry) => entry.id === id);
    if (!current) fail(404, "media_location_missing", "Media location not found.");
    database.prepare("DELETE FROM media_locations WHERE id = ?").run(id);
    return current;
  };
  return { add, list, remove };
};
