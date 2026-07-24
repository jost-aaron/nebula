import assert from "node:assert/strict";
import test from "node:test";
import { selectCinemaProcessingActivity } from "../server/cinema.mjs";

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

test("Cinema status never presents a future artwork job as running", () => {
  const artwork = { counts: { queued: 12 }, next: { id: "future-artwork" }, running: null };
  assert.deepEqual(selectCinemaProcessingActivity({ artwork, metadata: empty() }), {
    job: null,
    kind: null,
    queued: 12,
    state: null
  });
});
