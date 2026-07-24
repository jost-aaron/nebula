import assert from "node:assert/strict";
import test from "node:test";
import { groupTelevisionEntries, selectCinemaProcessingActivity } from "../server/cinema.mjs";

const empty = () => ({ counts: {}, next: null, running: null });

test("Cinema status follows active metadata instead of a future artwork title", () => {
  const artwork = { counts: { queued: 688 }, next: { id: "future-artwork" }, running: null };
  const metadata = { counts: { queued: 932 }, next: { id: "next-match" }, running: { id: "active-match" } };
  assert.deepEqual(selectCinemaProcessingActivity({ artwork, metadata }), {
    job: metadata.running,
    kind: "metadata",
    queued: 932,
    state: "running"
  });
});

test("Cinema status shows the next rapidly scheduled metadata match between requests", () => {
  const metadata = { counts: { queued: 10 }, next: { id: "next-match" }, running: null };
  assert.deepEqual(selectCinemaProcessingActivity({ artwork: empty(), metadata }), {
    job: metadata.next,
    kind: "metadata",
    queued: 10,
    state: "preparing"
  });
});

test("Cinema status prefers genuinely running artwork over a queued metadata match", () => {
  const artwork = { counts: { queued: 12 }, next: { id: "next-artwork" }, running: { id: "active-artwork" } };
  const metadata = { counts: { queued: 10 }, next: { id: "next-match" }, running: null };
  assert.deepEqual(selectCinemaProcessingActivity({ artwork, metadata }), {
    job: artwork.running,
    kind: "artwork",
    queued: 12,
    state: "running"
  });
});

test("Cinema status never presents a future artwork job as running", () => {
  const artwork = { counts: { queued: 12 }, next: { id: "future-artwork" }, running: null };
  assert.deepEqual(selectCinemaProcessingActivity({ artwork, metadata: empty() }), {
    job: null,
    kind: null,
    queued: 12,
    state: null
  });
});

test("identified television episodes collapse into series with ordered seasons", () => {
  const episode = (id, seasonNumber, episodeNumber) => ({
    category: "tv",
    episode: { episodeNumber, seasonNumber, seriesTitle: "Breaking Bad" },
    id,
    path: `${id}.mkv`,
    posterUrl: "",
    sortTitle: id,
    title: id,
    tmdbId: 1396
  });
  const grouped = groupTelevisionEntries([
    episode("second", 2, 1),
    episode("pilot", 1, 1)
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Breaking Bad");
  assert.deepEqual(grouped[0].series, {
    episodeCount: 2,
    key: "tmdb:1396",
    seasonCount: 2,
    seasons: [1, 2]
  });
});
