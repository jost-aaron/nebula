import assert from "node:assert/strict";
import test from "node:test";
import { createMusicBrainzClient } from "../server/musicbrainz.mjs";
import {
  cleanTitle,
  createMusicBrainzMetadataService,
  rankCandidates,
  selectCandidate,
  sourceHints
} from "../server/metadata/musicbrainzService.mjs";

const recordingId = "fcbcdc39-8851-4efc-a02a-ab0e13be224f";
const releaseId = "e225be8d-437d-4cca-815b-cd66e4229fec";

test("MusicBrainz client sends a bounded fielded recording query and selects front cover art", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ options, url: String(url) });
    if (String(url).includes("coverartarchive")) {
      return new Response(JSON.stringify({
        images: [{ front: true, thumbnails: { "500": "https://cover.example/500.jpg", "1200": "https://cover.example/1200.jpg" } }]
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: recordingId,
      title: "Everything in Its Right Place",
      "artist-credit": [{ artist: { id: "artist-id", name: "Radiohead" }, name: "Radiohead" }],
      releases: [{ id: releaseId, title: "Kid A", date: "2000-10-02", "release-group": { id: "group-id", title: "Kid A" } }],
      recordings: [{
        id: recordingId,
        score: 100,
        title: "Everything in Its Right Place",
        "artist-credit": [{ artist: { id: "artist-id", name: "Radiohead" }, name: "Radiohead" }],
        releases: [{ id: releaseId, title: "Kid A", date: "2000-10-02", "release-group": { id: "group-id", title: "Kid A" } }]
      }]
    }), { headers: { "content-type": "application/json" } });
  };
  const client = createMusicBrainzClient({ fetchImpl, minimumIntervalMs: 0 });
  const candidates = await client.search({ album: "Kid A", artist: "Radiohead", title: "Everything in Its Right Place" });
  const details = await client.details(recordingId, releaseId);

  assert.equal(candidates[0].recordingId, recordingId);
  assert.equal(details.posterUrl, "https://cover.example/1200.jpg");
  const searchUrl = new URL(requests[0].url);
  assert.match(searchUrl.searchParams.get("query"), /recording:"Everything in Its Right Place"/);
  assert.match(searchUrl.searchParams.get("query"), /artist:"Radiohead"/);
  assert.equal(requests[0].options.headers["user-agent"].startsWith("Nebula/"), true);
});

test("music hints prefer embedded tags and ranking rejects ambiguous candidates", () => {
  const hints = sourceHints(
    { path: "Music/Wrong Artist/Wrong Album/01 wrong.flac" },
    { metadata: { embeddedAlbum: "Kid A", embeddedArtist: "Radiohead", embeddedTitle: "Everything in Its Right Place" }, title: "wrong" }
  );
  assert.deepEqual(hints, { album: "Kid A", artist: "Radiohead", durationMs: null, title: "Everything in Its Right Place" });
  assert.equal(cleanTitle("01 - Everything.in.Its.Right.Place.flac"), "Everything in Its Right Place");
  const ranked = rankCandidates([
    { album: "Kid A", artist: "Radiohead", recordingId, score: 100, title: "Everything in Its Right Place" },
    { album: "Live", artist: "Tribute Band", recordingId: "other", score: 95, title: "Everything in Its Right Place" }
  ], hints);
  assert.equal(selectCandidate(ranked).recordingId, recordingId);
  assert.equal(selectCandidate([{ confidence: 0.89 }, { confidence: 0.86 }]), null);
  const durationRanked = rankCandidates([
    { album: "Kid A", artist: "Radiohead", durationMs: 402_853, recordingId: "live", score: 100, title: "Everything in Its Right Place" },
    { album: "Kid A", artist: "Radiohead", durationMs: 251_426, recordingId: "studio", score: 80, title: "Everything in Its Right Place" }
  ], { ...hints, durationMs: 251_426 });
  assert.equal(selectCandidate(durationRanked).recordingId, "studio");
});

test("MusicBrainz service persists metadata, queues cover caching, and skips current revisions", async () => {
  const source = {
    availability: "available", contentRevision: 4, id: "source-1", itemId: "item-1",
    mediaKind: "audio", path: "Music/Radiohead/Kid A/01 Everything in Its Right Place.flac"
  };
  const item = { id: "item-1", metadata: {}, source, title: "01 Everything in Its Right Place" };
  let persisted = null;
  const repository = {
    getItem: () => item,
    getSource: () => source,
    listItems: () => [item],
    putExternalMetadata: (_id, value) => {
      persisted = value;
      item.metadata = { ...item.metadata, ...value.fields };
    }
  };
  const client = {
    details: async () => ({
      album: "Kid A", artist: "Radiohead", artistId: "artist-id", durationMs: 251_000,
      genres: ["alternative rock"], posterUrl: "https://cover.example/kid-a.jpg", recordingId,
      releaseGroupId: "group-id", releaseId, releaseYear: "2000", title: "Everything in Its Right Place"
    }),
    search: async () => [{
      album: "Kid A", artist: "Radiohead", durationMs: 251_000, recordingId, releaseGroupId: "group-id",
      releaseId, releaseYear: "2000", score: 100, title: "Everything in Its Right Place"
    }]
  };
  const jobs = [];
  const service = createMusicBrainzMetadataService({ client, repository });
  const result = await service.refreshSource({ sourceId: source.id }, { enqueue: (job) => jobs.push(job) });

  assert.equal(result.matched, true);
  assert.deepEqual(persisted.externalIds, [{ id: recordingId, mediaType: "recording", provider: "musicbrainz" }]);
  assert.equal(persisted.fields.artist, "Radiohead");
  assert.equal(persisted.fields.musicbrainzSourceRevision, 4);
  assert.equal(jobs[0].type, "artwork");
  const queued = [];
  assert.deepEqual(service.enqueueMissing((job) => queued.push(job)), { intervalMs: 1250, queued: 0 });
});

test("embedded MusicBrainz recording IDs bypass fuzzy search", async () => {
  let searches = 0;
  let details = 0;
  const source = { availability: "available", contentRevision: 1, id: "s", itemId: "i", mediaKind: "audio", path: "Music/file.flac" };
  const repository = {
    getItem: () => ({ id: "i", metadata: { musicbrainzEmbeddedRecordingId: recordingId }, source, title: "file" }),
    getSource: () => source,
    listItems: () => [],
    putExternalMetadata: () => undefined
  };
  const service = createMusicBrainzMetadataService({
    client: {
      details: async () => { details += 1; return { recordingId, title: "Known", genres: [] }; },
      search: async () => { searches += 1; return []; }
    },
    repository
  });
  await service.refreshSource({ sourceId: "s" });
  assert.equal(searches, 0);
  assert.equal(details, 1);
});

test("manual MusicBrainz search keeps blank artist and album optional", async () => {
  const source = {
    availability: "available", contentRevision: 1, durationSeconds: 279,
    id: "source-93", itemId: "item-93", mediaKind: "audio",
    path: "Music/Zero 7/Another Late Night- Mixed by Zero 7/'93 'Til Infinity.flac"
  };
  const item = { id: "item-93", metadata: {}, source, title: "'93 'Til Infinity" };
  let requestedHints = null;
  const service = createMusicBrainzMetadataService({
    client: {
      details: async () => ({}),
      search: async (hints) => {
        requestedHints = hints;
        return [{
          album: "93 'til Infinity", artist: "Souls of Mischief", durationMs: 279_000,
          recordingId, releaseId, score: 100, title: "93 ’til Infinity"
        }];
      }
    },
    repository: {
      getItem: () => item,
      getSource: () => source,
      listItems: () => [],
      putExternalMetadata: (_id, value) => { item.metadata = { ...item.metadata, ...value.fields }; }
    }
  });

  const result = await service.searchSource({
    album: "", artist: "", query: "'93 'Til Infinity", sourceId: source.id
  });

  assert.deepEqual(requestedHints, { album: "", artist: "", title: "'93 'Til Infinity" });
  assert.equal(result.candidates[0].artist, "Souls of Mischief");
  assert.deepEqual(result.hints, { album: "", artist: "", title: "'93 'Til Infinity" });
});
