import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApiHandler } from "../server/api.mjs";
import { createStorage } from "../server/storage.mjs";
import { createTmdbClient, normalizeMediaQuery } from "../server/tmdb.mjs";

const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers }, status });

test("TMDB filename normalization extracts titles, years, and episode markers", () => {
  assert.deepEqual(normalizeMediaQuery("South.Park.The.Streaming.Wars.2022.1080p.WEB-DL.x264.mp4"), { query: "South Park The Streaming Wars", year: "2022" });
  assert.deepEqual(normalizeMediaQuery("Severance.S02E03.2160p.WEB-DL.mkv"), { query: "Severance", year: "" });
});

test("TMDB search uses bearer auth and maps candidates without exposing credentials", async () => {
  const calls = [];
  const client = createTmdbClient({ token: "test-secret-token", fetchImpl: async (url, options) => {
    calls.push({ options, url: String(url) });
    return jsonResponse({ results: [{ id: 42, title: "Example", release_date: "2024-03-01", overview: "Plot", poster_path: "/poster.jpg", backdrop_path: null, vote_average: 7.25 }] });
  }});
  const results = await client.search({ category: "movies", query: "Example", year: "2024" });
  assert.equal(calls[0].options.headers.authorization, "Bearer test-secret-token");
  assert.match(calls[0].url, /search\/movie/);
  assert.match(calls[0].url, /primary_release_year=2024/);
  assert.deepEqual(results[0], { backdropUrl: "", id: 42, mediaType: "movie", overview: "Plot", posterUrl: "https://image.tmdb.org/t/p/w342/poster.jpg", rating: "7.3", title: "Example", year: "2024" });
  assert.equal(JSON.stringify(results).includes("test-secret-token"), false);
});

test("TMDB details maps bounded TV metadata", async () => {
  const client = createTmdbClient({ token: "token", fetchImpl: async () => jsonResponse({
    id: 7, name: "Example Show", first_air_date: "2020-01-01", vote_average: 8, overview: "Summary", tagline: "Tag",
    poster_path: "/p.jpg", backdrop_path: "/b.jpg", genres: [{ name: "Drama" }], networks: [{ name: "Network" }],
    production_companies: [], credits: { cast: Array.from({ length: 15 }, (_, index) => ({ name: `Actor ${index}` })) }
  }) });
  const result = await client.details("tv", 7);
  assert.equal(result.title, "Example Show");
  assert.equal(result.tmdbMediaType, "tv");
  assert.equal(result.studio, "Network");
  assert.equal(result.cast.split(", ").length, 12);
  assert.equal(result.backdropUrl, "https://image.tmdb.org/t/p/w1280/b.jpg");
});

test("TMDB safely maps missing configuration and upstream failures", async () => {
  await assert.rejects(() => createTmdbClient({ token: "" }).search({ query: "x" }), (error) => error.status === 503 && !error.message.includes("Bearer"));
  await assert.rejects(() => createTmdbClient({ token: "secret", fetchImpl: async () => jsonResponse({}, 401) }).search({ query: "x" }), (error) => error.status === 502 && !error.message.includes("secret"));
  await assert.rejects(() => createTmdbClient({ token: "secret", fetchImpl: async () => jsonResponse({}, 429, { "retry-after": "2" }) }).search({ query: "x" }), (error) => error.status === 503 && error.retryAfter === "2");
  await assert.rejects(() => createTmdbClient({ token: "secret", fetchImpl: async () => new Response("not json") }).search({ query: "x" }), (error) => error.status === 502);
});

test("TMDB resolves a changed server token for each request", async () => {
  let token = "first-dynamic-token-value";
  const headers = [];
  const client = createTmdbClient({ tokenProvider: () => token, fetchImpl: async (_url, options) => {
    headers.push(options.headers.authorization);
    return jsonResponse({ results: [] });
  }});
  assert.equal(client.configured, true);
  await client.search({ category: "movies", query: "Example" });
  token = "second-dynamic-token-value";
  await client.search({ category: "movies", query: "Example" });
  assert.deepEqual(headers, ["Bearer first-dynamic-token-value", "Bearer second-dynamic-token-value"]);
  token = "";
  assert.equal(client.configured, false);
});

test("Cinema TMDB routes require explicit apply before writing matched metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nebula-tmdb-route-"));
  const storage = await createStorage({ contentRoot: root });
  await writeFile(path.join(root, "Example.2024.mp4"), "video");
  const tmdbClient = {
    configured: true,
    search: async ({ query, year }) => [{ id: 42, mediaType: "movie", title: query, year, overview: "Candidate", posterUrl: "", backdropUrl: "", rating: "7.0" }],
    details: async (mediaType, id) => ({ title: "Matched Example", sortTitle: "Matched Example", releaseYear: "2024", rating: "7.0", genres: ["Drama"], studio: "Studio", collection: "", posterUrl: "", backdropUrl: "", tagline: "", cast: "Actor", summary: "Imported", tmdbId: id, tmdbMediaType: mediaType, tmdbImportedAt: "2026-01-01T00:00:00.000Z" })
  };
  const handler = createApiHandler(storage, undefined, undefined, { cinema: { tmdbClient } });
  const server = createServer(async (request, response) => { if (!(await handler(request, response))) response.writeHead(404).end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(root, { force: true, recursive: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const search = await post("/api/cinema/tmdb/search", { category: "movies", path: "Example.2024.mp4", query: "Example.2024.mp4" });
  assert.equal(search.status, 200);
  assert.equal((await search.json()).candidates.length, 1);
  await assert.rejects(() => readFile(storage.cinemaMetadataPath, "utf8"), { code: "ENOENT" });

  const apply = await post("/api/cinema/tmdb/apply", { mediaType: "movie", path: "Example.2024.mp4", tmdbId: 42 });
  assert.equal(apply.status, 200);
  const saved = JSON.parse(await readFile(storage.cinemaMetadataPath, "utf8"));
  assert.equal(saved["Example.2024.mp4"].title, "Matched Example");
  assert.equal(saved["Example.2024.mp4"].tmdbId, 42);
});
