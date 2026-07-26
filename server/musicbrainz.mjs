const MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2";
const COVER_ART_BASE_URL = "https://coverartarchive.org";
const DEFAULT_USER_AGENT = "Nebula/0.1.0 (https://github.com/jost-aaron/nebula)";

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : "";
const year = (value) => /^\d{4}/.exec(text(value))?.[0] ?? "";
const artistCredit = (value) => Array.isArray(value)
  ? value.map((credit) => text(credit?.name) || text(credit?.artist?.name)).filter(Boolean).join("")
  : "";
const firstRelease = (recording) => (Array.isArray(recording?.releases) ? recording.releases : [])
  .find((release) => release?.id) ?? null;
const releaseGroup = (release) => release?.["release-group"] ?? null;
const uniqueGenres = (recording) => [
  ...(Array.isArray(recording?.genres) ? recording.genres : []),
  ...(Array.isArray(recording?.tags) ? recording.tags : [])
].map((entry) => text(entry?.name)).filter(Boolean)
  .filter((name, index, values) => values.findIndex((value) => value.toLowerCase() === name.toLowerCase()) === index)
  .slice(0, 8);

const quoteQuery = (value) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const normalizedCandidate = (recording, providerScore = 0) => {
  const release = firstRelease(recording);
  const group = releaseGroup(release);
  const artist = Array.isArray(recording?.["artist-credit"]) ? recording["artist-credit"][0]?.artist : null;
  return {
    album: text(release?.title) || text(group?.title),
    artist: artistCredit(recording?.["artist-credit"]),
    artistId: text(artist?.id),
    durationMs: Number.isFinite(Number(recording?.length)) ? Number(recording.length) : null,
    genres: uniqueGenres(recording),
    recordingId: text(recording?.id),
    releaseGroupId: text(group?.id),
    releaseId: text(release?.id),
    releaseYear: year(release?.date) || year(group?.["first-release-date"]) || year(recording?.["first-release-date"]),
    score: Math.max(0, Math.min(100, Number(providerScore) || 0)),
    title: text(recording?.title)
  };
};

const abortableFetch = async (fetchImpl, url, options = {}, timeoutMs = 15_000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

export const createMusicBrainzClient = ({
  baseUrl = MUSICBRAINZ_BASE_URL,
  coverArtBaseUrl = COVER_ART_BASE_URL,
  fetchImpl = globalThis.fetch,
  minimumIntervalMs = 1_100,
  userAgent = DEFAULT_USER_AGENT
} = {}) => {
  let nextRequestAt = 0;
  let requestChain = Promise.resolve();

  const request = async (pathname, query = {}) => {
    const run = async () => {
      const waitMs = Math.max(0, nextRequestAt - Date.now());
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      nextRequestAt = Date.now() + minimumIntervalMs;
      const url = new URL(`${baseUrl}${pathname}`);
      Object.entries({ ...query, fmt: "json" }).forEach(([key, value]) => {
        if (value !== null && value !== undefined && String(value)) url.searchParams.set(key, String(value));
      });
      const response = await abortableFetch(fetchImpl, url, {
        headers: { accept: "application/json", "user-agent": userAgent }
      });
      if (!response.ok) {
        throw Object.assign(new Error(`MusicBrainz request failed with HTTP ${response.status}.`), {
          code: "MUSICBRAINZ_REQUEST_FAILED",
          retryable: response.status === 429 || response.status >= 500,
          status: 502
        });
      }
      return response.json();
    };
    const pending = requestChain.then(run, run);
    requestChain = pending.catch(() => undefined);
    return pending;
  };

  const coverArt = async (releaseId) => {
    if (!releaseId) return "";
    const response = await abortableFetch(fetchImpl, `${coverArtBaseUrl}/release/${encodeURIComponent(releaseId)}`, {
      headers: { accept: "application/json", "user-agent": userAgent }
    }).catch(() => null);
    if (!response?.ok) return "";
    const body = await response.json().catch(() => ({}));
    const images = Array.isArray(body.images) ? body.images : [];
    const front = images.find((image) => image.front) ?? images[0];
    const imageUrl = text(front?.thumbnails?.["1200"]) || text(front?.thumbnails?.["500"]) || text(front?.image);
    return imageUrl.replace(/^http:\/\/coverartarchive\.org\//i, "https://coverartarchive.org/");
  };

  const search = async ({ album = "", artist = "", title, limit = 8 }) => {
    const clauses = [`recording:${quoteQuery(title)}`];
    if (artist) clauses.push(`artist:${quoteQuery(artist)}`);
    if (album) clauses.push(`release:${quoteQuery(album)}`);
    const body = await request("/recording", {
      inc: "artist-credits+releases+release-groups+genres+tags",
      limit: Math.max(1, Math.min(12, Number(limit) || 8)),
      query: clauses.join(" AND ")
    });
    return (Array.isArray(body.recordings) ? body.recordings : [])
      .map((recording) => normalizedCandidate(recording, recording.score))
      .filter((candidate) => candidate.recordingId && candidate.title);
  };

  const details = async (recordingId, preferredReleaseId = "") => {
    const recording = await request(`/recording/${encodeURIComponent(recordingId)}`, {
      inc: "artist-credits+releases+release-groups+genres+tags"
    });
    if (preferredReleaseId && Array.isArray(recording.releases)) {
      recording.releases.sort((left, right) =>
        Number(right.id === preferredReleaseId) - Number(left.id === preferredReleaseId)
      );
    }
    const candidate = normalizedCandidate(recording, 100);
    return {
      ...candidate,
      posterUrl: await coverArt(candidate.releaseId)
    };
  };

  return {
    attribution: "Music metadata from MusicBrainz; cover art from the Cover Art Archive.",
    configured: true,
    coverArt,
    details,
    search
  };
};

export { artistCredit, normalizedCandidate };
