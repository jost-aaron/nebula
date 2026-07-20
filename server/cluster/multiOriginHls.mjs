import { timingSafeEqual } from "node:crypto";

const MAX_ORIGINS = 4;
const MAX_SEGMENTS = 20_000;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const SEGMENT_NAME = /^segment-\d{5}\.ts$/;
const error = (code, message) => Object.assign(new Error(message), { code, status: 422, expose: true });
const same = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};

export const multiOriginHlsExperimentEnabled = (env = process.env) =>
  env.NEBULA_MULTI_ORIGIN_HLS_EXPERIMENT === "true";

const validateEndpoint = (value) => {
  let url;
  try { url = new URL(value); } catch { throw error("multi_origin_endpoint", "A replica endpoint is invalid."); }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".ts.net") || url.username || url.password
    || url.search || url.hash || url.pathname !== "/") {
    throw error("multi_origin_endpoint", "Replica endpoints must be exact credential-free Tailscale HTTPS origins.");
  }
  return url.origin;
};

const validateDigest = (value, label) => {
  if (typeof value !== "string" || !HEX_SHA256.test(value)) throw error("multi_origin_digest", `${label} must be a SHA-256 digest.`);
  return value;
};

const validateSegments = (segments) => {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > MAX_SEGMENTS) {
    throw error("multi_origin_segment_map", "The rendition segment map is missing or exceeds its bound.");
  }
  const names = new Set();
  return segments.map((segment) => {
    if (!segment || !SEGMENT_NAME.test(segment.name) || names.has(segment.name)
      || !Number.isSafeInteger(segment.byteLength) || segment.byteLength < 1) {
      throw error("multi_origin_segment_map", "The rendition segment map is invalid.");
    }
    names.add(segment.name);
    return { name: segment.name, byteLength: segment.byteLength, sha256: validateDigest(segment.sha256, "Segment digest") };
  });
};

const identityKey = (replica) => JSON.stringify({
  fingerprintAlgorithm: replica.fingerprintAlgorithm,
  fingerprintDigest: replica.fingerprintDigest,
  fingerprintByteLength: replica.fingerprintByteLength,
  sourceRevision: replica.sourceRevision,
  profileId: replica.profileId,
  profileVersion: replica.profileVersion,
  renditionDigest: replica.renditionDigest,
  playlistDigest: replica.playlistDigest,
  segments: replica.segments
});

export const createMultiOriginHlsContract = ({
  accountId, enabled = multiOriginHlsExperimentEnabled(), federatedItemId, now = Date.now(), replicas, sessionId
}) => {
  if (!enabled) return null;
  if (!Array.isArray(replicas) || replicas.length < 2 || replicas.length > MAX_ORIGINS) {
    throw error("multi_origin_replica_count", "Multi-origin HLS requires two to four verified replicas.");
  }
  const nodes = new Set();
  const normalized = replicas.map((replica) => {
    if (!replica || nodes.has(replica.nodeId)) throw error("multi_origin_replica", "Each origin must be a distinct cluster node.");
    nodes.add(replica.nodeId);
    const endpoint = validateEndpoint(replica.endpoint);
    const grant = replica.grant;
    if (!grant || grant.revoked || grant.accountId !== accountId || grant.sessionId !== sessionId
      || grant.federatedItemId !== federatedItemId || grant.nodeId !== replica.nodeId
      || grant.sourceRevision !== replica.sourceRevision || Date.parse(grant.expiresAt) <= now) {
      throw error("multi_origin_grant_scope", "A replica grant is expired, revoked, or outside the playback scope.");
    }
    if (replica.fingerprintAlgorithm !== "sha256" || !Number.isSafeInteger(replica.fingerprintByteLength)
      || replica.fingerprintByteLength < 1 || !Number.isSafeInteger(replica.sourceRevision) || replica.sourceRevision < 1
      || !Number.isSafeInteger(replica.profileVersion) || replica.profileVersion < 1) {
      throw error("multi_origin_identity", "Replica source or rendition identity is incomplete.");
    }
    const segments = validateSegments(replica.segments);
    let ticketUrl;
    try { ticketUrl = new URL(replica.ticketUrl); }
    catch { throw error("multi_origin_ticket_scope", "A replica ticket URL is not bound to its approved origin."); }
    if (ticketUrl.origin !== endpoint || ticketUrl.protocol !== "https:" || ticketUrl.username || ticketUrl.password
      || !/^\/api\/shard\/v1\/media\/[A-Za-z0-9_-]+\/hls\/master\.m3u8$/.test(ticketUrl.pathname)
      || [...ticketUrl.searchParams.keys()].length !== 1 || !ticketUrl.searchParams.get("ticket")) {
      throw error("multi_origin_ticket_scope", "A replica ticket URL is not bound to its approved origin.");
    }
    return {
      ...replica,
      endpoint,
      fingerprintDigest: validateDigest(replica.fingerprintDigest, "Source fingerprint"),
      playlistDigest: validateDigest(replica.playlistDigest, "Playlist digest"),
      renditionDigest: validateDigest(replica.renditionDigest, "Rendition digest"),
      segments,
      ticketUrl: ticketUrl.toString()
    };
  });
  const expected = identityKey(normalized[0]);
  if (normalized.some((replica) => !same(identityKey(replica), expected))) {
    throw error("multi_origin_rendition_mismatch", "Replicas do not expose the same exact rendition and segment layout.");
  }
  const first = normalized[0];
  return Object.freeze({
    accountId,
    expiresAt: new Date(Math.min(...normalized.map((entry) => Date.parse(entry.grant.expiresAt)))).toISOString(),
    federatedItemId,
    profileId: first.profileId,
    profileVersion: first.profileVersion,
    renditionDigest: first.renditionDigest,
    segmentMap: first.segments,
    sessionId,
    origins: normalized.map(({ endpoint, nodeId, ticketUrl }) => ({ endpoint, nodeId, ticketUrl }))
  });
};
