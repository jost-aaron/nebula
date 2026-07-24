import assert from "node:assert/strict";
import test from "node:test";
import { createTmdbMetadataService, queryVariantsForSource, rankCandidates, selectCandidate } from "../server/metadata/tmdbService.mjs";

const movieFields = {
  backdropUrl: "https://image.example/backdrop.jpg",
  posterUrl: "https://image.example/poster.jpg",
  releaseYear: "2014",
  title: "A Most Wanted Man",
  tmdbId: 157849,
  tmdbMediaType: "movie"
};

test("candidate selection accepts a dominant partial-title result and rejects ambiguity", () => {
  const candidates = [
    { id: 1, title: "Example", year: "1999" },
    { id: 2, title: "Example", year: "2001" },
    { id: 3, title: "Example Returns", year: "2001" }
  ];
  assert.equal(selectCandidate(candidates, "Example", "2001").id, 2);
  assert.equal(selectCandidate(candidates, "Unrelated", "2001"), null);
  const ranked = rankCandidates([[
    { id: 1573, mediaType: "movie", rating: "7.0", title: "Die Hard 2", year: "1990" },
    { id: 99, mediaType: "movie", rating: "6.0", title: "Die Hard", year: "1988" }
  ]], ["Die Hard 2 Die Harder", "Die Hard 2"], "1990");
  assert.equal(selectCandidate(ranked, ["Die Hard 2 Die Harder", "Die Hard 2"], "1990").id, 1573);
});

test("query variants recover a bounded clean title from a noisy filename", () => {
  const normalized = queryVariantsForSource(
    "Movies/Die Hard Collection/02 Die Hard 2 Die Harder - Bruce Willis Action 1990 Eng Subs 1080p [H264-mp4].mp4",
    { title: "02 Die Hard 2 Die Harder" }
  );
  assert.equal(normalized.year, "1990");
  assert.equal(normalized.queries.includes("Die Hard 2"), true);
  assert.equal(normalized.queries.length <= 5, true);
});

test("TMDB metadata service imports a conservative movie match into catalog and legacy metadata", async () => {
  let persisted = null;
  let legacy = {};
  const artworkJobs = [];
  const source = {
    availability: "available", contentRevision: 1, id: "source-1", itemId: "item-1",
    mediaKind: "video", path: "Movies/A.Most.Wanted.Man.2014.720p.BluRay.x264.mp4"
  };
  const repository = {
    getItem: () => ({ id: "item-1", itemType: "movie" }),
    getSource: () => source,
    listItems: () => [{ id: "item-1", source }],
    putExternalMetadata: (_id, value) => { persisted = value; }
  };
  const tmdb = {
    details: async () => movieFields,
    episodeDetails: async () => { throw new Error("unexpected episode lookup"); },
    search: async (query) => {
      assert.deepEqual(query, {
        category: "movies", episodeNumber: null, query: "A Most Wanted Man",
        seasonNumber: null, year: "2014"
      });
      return [{ id: 157849, mediaType: "movie", title: "A Most Wanted Man", year: "2014" }];
    }
  };
  const service = createTmdbMetadataService({
    readLegacyMetadata: async () => legacy,
    repository,
    tmdb,
    writeLegacyMetadata: async (value) => { legacy = value; }
  });

  const result = await service.refreshSource({ sourceId: source.id }, { enqueue: (job) => artworkJobs.push(job) });

  assert.equal(result.matched, true);
  assert.deepEqual(persisted.externalIds, [{ id: 157849, mediaType: "movie", provider: "tmdb" }]);
  assert.equal(persisted.fields.posterUrl, movieFields.posterUrl);
  assert.equal(legacy[source.path].title, "A Most Wanted Man");
  assert.deepEqual(artworkJobs, [{
    availableAt: 0,
    dedupeKey: "source-1:1",
    maxAttempts: 2,
    payload: { contentRevision: 1, sourceId: "source-1" },
    type: "artwork"
  }]);
});

test("TMDB metadata service preserves unmatched titles and schedules one bounded job per video source", async () => {
  const source = { availability: "available", contentRevision: 2, id: "source-2", itemId: "item-2", mediaKind: "video", path: "Movies/Unknown.File.mp4" };
  let writes = 0;
  const repository = {
    getItem: () => ({ id: "item-2", itemType: "movie" }),
    getSource: () => source,
    listItems: () => [{ id: "item-2", source }],
    putExternalMetadata: () => { writes += 1; }
  };
  const service = createTmdbMetadataService({
    repository,
    tmdb: { details: async () => ({}), episodeDetails: async () => ({}), search: async () => [{ id: 9, mediaType: "movie", title: "Different Title", year: "" }] }
  });
  const result = await service.refreshSource({ sourceId: source.id });
  const queued = [];
  const schedule = service.enqueueAll((job) => queued.push(job), { availableAt: 1_000, batchId: "batch", intervalMs: 2_000 });

  assert.equal(result.matched, false);
  assert.equal(result.query, "Unknown File");
  assert.equal(result.reason, "no_confident_match");
  assert.equal(result.candidateCount, 1);
  assert.equal(writes, 1);
  assert.deepEqual(schedule, { intervalMs: 2_000, queued: 1 });
  assert.equal(queued[0].availableAt, 1_000);
  assert.equal(queued[0].dedupeKey, "batch:source-2:2");
  assert.equal(queued[0].maxAttempts, 1);
});
