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
  assert.deepEqual(normalizeMediaQuery("South.Park.The.Streaming.Wars.2022.1080p.WEB-DL.x264.mp4"), { episodeNumber: null, query: "South Park The Streaming Wars", seasonNumber: null, year: "2022" });
  assert.deepEqual(normalizeMediaQuery("Severance.S02E03.2160p.WEB-DL.mkv"), { episodeNumber: 3, query: "Severance", seasonNumber: 2, year: "" });
  assert.deepEqual(normalizeMediaQuery("The.Bear.3x07.1080p.mkv"), { episodeNumber: 7, query: "The Bear", seasonNumber: 3, year: "" });
  assert.deepEqual(normalizeMediaQuery("Breaking.Bad.S02e08.BDMux.H264.SD.by.Fratposa.mkv"), { episodeNumber: 8, query: "Breaking Bad", seasonNumber: 2, year: "" });
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
  assert.deepEqual(results[0], { backdropUrl: "", episodeNumber: null, id: 42, mediaType: "movie", overview: "Plot", posterUrl: "https://image.tmdb.org/t/p/w342/poster.jpg", rating: "7.3", seasonNumber: null, title: "Example", year: "2024" });
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

test("TMDB episode details combine series and episode metadata", async () => {
  const requests = [];
  const client = createTmdbClient({ token: "token", fetchImpl: async (url) => {
    requests.push(String(url));
    return String(url).includes("/season/2/episode/3")
      ? jsonResponse({ id: 203, name: "The Episode", air_date: "2025-02-03", overview: "Episode plot", still_path: "/still.jpg", vote_average: 8.4, credits: { cast: [{ name: "Guest" }] } })
      : jsonResponse({ id: 7, name: "The Series", backdrop_path: "/series-bg.jpg", poster_path: "/series.jpg", genres: [{ name: "Drama" }], networks: [{ name: "Network" }], production_companies: [] });
  }});
  const result = await client.episodeDetails(7, 2, 3);
  assert.equal(requests.some((url) => url.includes("/tv/7/season/2/episode/3")), true);
  assert.equal(result.title, "The Episode");
  assert.deepEqual(result.episode, { airDate: "2025-02-03", episodeNumber: 3, seasonNumber: 2, seriesTitle: "The Series" });
  assert.equal(result.backdropUrl, "https://image.tmdb.org/t/p/w1280/still.jpg");
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
  await writeFile(path.join(root, "Example.Show.S02E03.mp4"), "episode");
  const tmdbClient = {
    configured: true,
    search: async ({ category, episodeNumber, query, seasonNumber, year }) => [{ id: 42, mediaType: category === "tv" ? "tv" : "movie", title: query, year, overview: "Candidate", posterUrl: "", backdropUrl: "", rating: "7.0", episodeNumber, seasonNumber }],
    details: async (mediaType, id) => ({ title: "Matched Example", sortTitle: "Matched Example", releaseYear: "2024", rating: "7.0", genres: ["Drama"], studio: "Studio", collection: "", posterUrl: "", backdropUrl: "", tagline: "", cast: "Actor", summary: "Imported", tmdbId: id, tmdbMediaType: mediaType, tmdbImportedAt: "2026-01-01T00:00:00.000Z" }),
    episodeDetails: async (id, seasonNumber, episodeNumber) => ({ title: "Episode Three", sortTitle: "Example Show S02E03", releaseYear: "2025", rating: "8.0", genres: ["Drama"], studio: "Studio", collection: "Example Show", posterUrl: "", backdropUrl: "", tagline: "", cast: "Guest", summary: "Episode import", episode: { airDate: "2025-02-03", episodeNumber, seasonNumber, seriesTitle: "Example Show" }, tmdbId: id, tmdbMediaType: "tv", tmdbImportedAt: "2026-01-01T00:00:00.000Z" })
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

  const episodeSearch = await post("/api/cinema/tmdb/search", { category: "tv", path: "Example.Show.S02E03.mp4", query: "Example.Show.S02E03.mp4" });
  const episodeCandidate = (await episodeSearch.json()).candidates[0];
  assert.equal(episodeCandidate.seasonNumber, 2);
  assert.equal(episodeCandidate.episodeNumber, 3);
  const episodeApply = await post("/api/cinema/tmdb/apply", { episodeNumber: 3, mediaType: "tv", path: "Example.Show.S02E03.mp4", seasonNumber: 2, tmdbId: 42 });
  assert.equal(episodeApply.status, 200);
  const episodeSaved = JSON.parse(await readFile(storage.cinemaMetadataPath, "utf8"));
  assert.equal(episodeSaved["Example.Show.S02E03.mp4"].title, "Episode Three");
  assert.deepEqual(episodeSaved["Example.Show.S02E03.mp4"].episode, { airDate: "2025-02-03", episodeNumber: 3, seasonNumber: 2, seriesTitle: "Example Show" });
});
