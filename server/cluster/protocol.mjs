import { CLUSTER_PROTOCOL_SUPPORT, isClusterProtocolCompatible } from "./compatibility.mjs";

export const CLUSTER_PROTOCOL_VERSION = CLUSTER_PROTOCOL_SUPPORT.current;
export const CLUSTER_MANIFEST_PAGE_LIMIT = 500;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const HEX_256_PATTERN = /^[a-f0-9]{64}$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PATCH", "DELETE"]);
const MEDIA_METHODS = new Set(["GET", "HEAD"]);
const NODE_ROLES = new Set(["coordinator", "shard", "hybrid"]);
const ITEM_KINDS = new Set(["movie", "show", "season", "episode", "artist", "album", "track"]);
const MEDIA_KINDS = new Set(["video", "audio"]);
const FINGERPRINT_ALGORITHMS = new Set(["sha256", "blake3"]);
const FINGERPRINT_STATES = new Set(["pending", "ready", "failed"]);
const RENDITION_STATES = new Set(["pending", "ready", "failed"]);
const SUBTITLE_FORMATS = new Set(["webvtt", "srt"]);
const MANIFEST_AVAILABILITY = new Set(["available", "tombstone"]);
const PROFILE_IDS = new Set(["auto", "original", "240p", "360p", "480p", "720p", "1080p"]);

export class ClusterProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ClusterProtocolError";
    this.code = code;
    this.status = 400;
    this.expose = true;
  }
}

const fail = (code, message) => { throw new ClusterProtocolError(code, message); };
const plainObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("invalid_shape", `${label} must be a plain object.`);
  }
  return value;
};
const exactKeys = (value, allowed, label) => {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("unknown_field", `${label} contains unknown field ${key}.`);
};
const requiredString = (value, label, max = 256) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("invalid_string", `${label} must be a non-empty string of at most ${max} characters.`);
  return value;
};
const id = (value, label) => {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail("invalid_id", `${label} is not a valid opaque identifier.`);
  return value;
};
const integer = (value, label, { min = 0 } = {}) => {
  if (!Number.isSafeInteger(value) || value < min) fail("invalid_number", `${label} must be a safe integer greater than or equal to ${min}.`);
  return value;
};
const nullableNumber = (value, label) => {
  if (value !== null && (!Number.isFinite(value) || value < 0)) fail("invalid_number", `${label} must be null or a non-negative finite number.`);
  return value;
};
const timestamp = (value, label) => {
  requiredString(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a UTC ISO timestamp.`);
  }
  return value;
};
const protocolVersion = (value) => {
  if (!isClusterProtocolCompatible(value)) fail("unsupported_protocol", `Cluster protocol version ${String(value)} is not supported.`);
};
const base64UrlBytes = (value, label, bytes) => {
  requiredString(value, label, 256);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail("invalid_encoding", `${label} must use unpadded base64url.`);
  let decoded;
  try { decoded = Buffer.from(value, "base64url"); } catch { fail("invalid_encoding", `${label} is not valid base64url.`); }
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) fail("invalid_encoding", `${label} must encode exactly ${bytes} bytes.`);
  return value;
};

export const validateClusterEndpoint = (value) => {
  requiredString(value, "endpoint", 512);
  let endpoint;
  try { endpoint = new URL(value); } catch { fail("invalid_endpoint", "endpoint must be an absolute HTTPS URL."); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.port && endpoint.port !== "443")) {
    fail("invalid_endpoint", "endpoint must be a credential-free HTTPS origin without query or fragment data.");
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (!hostname.endsWith(".ts.net") || hostname === ".ts.net") fail("invalid_endpoint", "endpoint must use an exact Tailscale HTTPS hostname.");
  if (endpoint.pathname !== "/") fail("invalid_endpoint", "endpoint must not contain an application-controlled path.");
  return endpoint.origin;
};

const validateCapabilities = (input) => {
  const value = plainObject(input, "capabilities");
  exactKeys(value, new Set(["directPlay", "hls", "remux", "renditionProfiles", "transcode"]), "capabilities");
  for (const key of ["directPlay", "hls", "remux", "transcode"]) if (typeof value[key] !== "boolean") fail("invalid_capability", `capabilities.${key} must be a boolean.`);
  if (!Array.isArray(value.renditionProfiles) || value.renditionProfiles.length > 16 || value.renditionProfiles.some((entry) => !PROFILE_IDS.has(entry) || entry === "auto" || entry === "original")) {
    fail("invalid_capability", "capabilities.renditionProfiles contains an unsupported profile.");
  }
  return value;
};

export const validateClusterNodeDescriptor = (input) => {
  const value = plainObject(input, "node descriptor");
  exactKeys(value, new Set(["capabilities", "endpoint", "name", "nodeId", "protocolVersion", "publicKey", "role"]), "node descriptor");
  protocolVersion(value.protocolVersion);
  id(value.nodeId, "nodeId");
  requiredString(value.name, "name", 80);
  if (!NODE_ROLES.has(value.role)) fail("invalid_role", "role is not supported.");
  validateClusterEndpoint(value.endpoint);
  base64UrlBytes(value.publicKey, "publicKey", 32);
  validateCapabilities(value.capabilities);
  return value;
};

export const validateClusterPairingRequest = (input) => {
  const value = plainObject(input, "pairing request");
  exactKeys(value, new Set(["clusterId", "pairingCode", "requester"]), "pairing request");
  if (typeof value.clusterId !== "string" || !/^cluster_[A-Za-z0-9_-]{8,127}$/.test(value.clusterId)) fail("invalid_cluster", "clusterId is invalid.");
  if (typeof value.pairingCode !== "string" || !TOKEN_PATTERN.test(value.pairingCode)) fail("invalid_pairing_code", "pairingCode is invalid.");
  validateClusterNodeDescriptor(value.requester);
  return value;
};

export const validateClusterPairingResponse = (input) => {
  const value = plainObject(input, "pairing response");
  exactKeys(value, new Set(["clusterId", "node"]), "pairing response");
  if (typeof value.clusterId !== "string" || !/^cluster_[A-Za-z0-9_-]{8,127}$/.test(value.clusterId)) fail("invalid_cluster", "clusterId is invalid.");
  validateClusterNodeDescriptor(value.node);
  return value;
};

export const validateClusterKeyRotationPayload = (input) => {
  const value = plainObject(input, "key rotation payload");
  exactKeys(value, new Set([
    "clusterId", "expiresAt", "newKeyVersion", "newPublicKey", "nodeId",
    "oldKeyVersion", "oldPublicKey", "rotationId"
  ]), "key rotation payload");
  if (typeof value.clusterId !== "string" || !/^cluster_[A-Za-z0-9_-]{8,127}$/.test(value.clusterId)) fail("invalid_cluster", "clusterId is invalid.");
  id(value.nodeId, "nodeId");
  id(value.rotationId, "rotationId");
  integer(value.oldKeyVersion, "oldKeyVersion", { min: 1 });
  integer(value.newKeyVersion, "newKeyVersion", { min: 2 });
  if (value.newKeyVersion !== value.oldKeyVersion + 1) fail("invalid_key_version", "newKeyVersion must immediately follow oldKeyVersion.");
  base64UrlBytes(value.oldPublicKey, "oldPublicKey", 32);
  base64UrlBytes(value.newPublicKey, "newPublicKey", 32);
  if (value.oldPublicKey === value.newPublicKey) fail("invalid_key_rotation", "The replacement key must be distinct.");
  timestamp(value.expiresAt, "expiresAt");
  return value;
};

export const validateClusterKeyRotationAck = (input) => {
  const value = plainObject(input, "key rotation acknowledgement");
  exactKeys(value, new Set(["keyVersion", "nodeId", "rotationId", "state"]), "key rotation acknowledgement");
  id(value.nodeId, "nodeId");
  id(value.rotationId, "rotationId");
  integer(value.keyVersion, "keyVersion", { min: 1 });
  if (!new Set(["prepared", "committed"]).has(value.state)) fail("invalid_rotation_state", "The key rotation acknowledgement state is invalid.");
  return value;
};

const validateExternalIdentity = (input, index) => {
  const value = plainObject(input, `externalIds[${index}]`);
  exactKeys(value, new Set(["mediaType", "provider", "providerItemId"]), `externalIds[${index}]`);
  requiredString(value.provider, `externalIds[${index}].provider`, 64);
  requiredString(value.providerItemId, `externalIds[${index}].providerItemId`, 128);
  requiredString(value.mediaType, `externalIds[${index}].mediaType`, 64);
};
const validateFingerprint = (input, sourceRevision) => {
  const value = plainObject(input, "fingerprint");
  exactKeys(value, new Set(["algorithm", "digest", "sourceRevision", "state"]), "fingerprint");
  if (!FINGERPRINT_ALGORITHMS.has(value.algorithm)) fail("invalid_fingerprint", "fingerprint.algorithm is unsupported.");
  if (!FINGERPRINT_STATES.has(value.state)) fail("invalid_fingerprint", "fingerprint.state is unsupported.");
  integer(value.sourceRevision, "fingerprint.sourceRevision", { min: 1 });
  if (value.sourceRevision !== sourceRevision) fail("revision_mismatch", "fingerprint.sourceRevision must match sourceRevision.");
  if (value.state === "ready") {
    if (typeof value.digest !== "string" || !HEX_256_PATTERN.test(value.digest)) fail("invalid_fingerprint", "A ready fingerprint requires a lowercase 256-bit hex digest.");
  } else if (value.digest !== null) fail("invalid_fingerprint", "A non-ready fingerprint must not include a digest.");
};
const validateRendition = (input, index) => {
  const value = plainObject(input, `renditions[${index}]`);
  exactKeys(value, new Set(["profileId", "revision", "state"]), `renditions[${index}]`);
  if (!PROFILE_IDS.has(value.profileId) || value.profileId === "auto" || value.profileId === "original") fail("invalid_rendition", "rendition profile is unsupported.");
  integer(value.revision, `renditions[${index}].revision`, { min: 1 });
  if (!RENDITION_STATES.has(value.state)) fail("invalid_rendition", "rendition state is unsupported.");
};
const validateManifestSubtitle = (input, index) => {
  const label = `subtitles[${index}]`;
  const value = plainObject(input, label);
  exactKeys(value, new Set(["default", "forced", "format", "id", "kind", "label", "language"]), label);
  id(value.id, `${label}.id`);
  if (value.kind !== "sidecar" || !SUBTITLE_FORMATS.has(value.format)) fail("invalid_subtitle", `${label} is not an eligible sidecar subtitle.`);
  if (value.language !== null) requiredString(value.language, `${label}.language`, 32);
  requiredString(value.label, `${label}.label`, 80);
  if (typeof value.forced !== "boolean" || typeof value.default !== "boolean") fail("invalid_subtitle", `${label} flags are invalid.`);
};
const validateManifestSource = (input, index) => {
  const label = `sources[${index}]`;
  const value = plainObject(input, label);
  exactKeys(value, new Set(["availability", "bitrate", "durationSeconds", "externalIds", "fingerprint", "height", "itemKind", "localItemId", "localSourceId", "mediaKind", "removedAt", "renditions", "sizeBytes", "sourceRevision", "subtitles", "title", "width", "year"]), label);
  id(value.localItemId, `${label}.localItemId`);
  id(value.localSourceId, `${label}.localSourceId`);
  if (!ITEM_KINDS.has(value.itemKind)) fail("invalid_media", `${label}.itemKind is unsupported.`);
  if (!MEDIA_KINDS.has(value.mediaKind)) fail("invalid_media", `${label}.mediaKind is unsupported.`);
  if (!MANIFEST_AVAILABILITY.has(value.availability)) fail("invalid_media", `${label}.availability is unsupported.`);
  if (value.availability === "tombstone") timestamp(value.removedAt, `${label}.removedAt`);
  else if (value.removedAt !== null) fail("invalid_media", `${label}.removedAt must be null for available sources.`);
  requiredString(value.title, `${label}.title`, 512);
  integer(value.sizeBytes, `${label}.sizeBytes`);
  integer(value.sourceRevision, `${label}.sourceRevision`, { min: 1 });
  nullableNumber(value.durationSeconds, `${label}.durationSeconds`);
  nullableNumber(value.bitrate, `${label}.bitrate`);
  nullableNumber(value.width, `${label}.width`);
  nullableNumber(value.height, `${label}.height`);
  if (value.year !== null && (!Number.isSafeInteger(value.year) || value.year < 1800 || value.year > 3000)) fail("invalid_media", `${label}.year is invalid.`);
  if (!Array.isArray(value.externalIds) || value.externalIds.length > 16) fail("manifest_limit", `${label}.externalIds exceeds its limit.`);
  value.externalIds.forEach(validateExternalIdentity);
  if (!Array.isArray(value.renditions) || value.renditions.length > 16) fail("manifest_limit", `${label}.renditions exceeds its limit.`);
  value.renditions.forEach(validateRendition);
  if (value.subtitles !== undefined) {
    if (!Array.isArray(value.subtitles) || value.subtitles.length > 32) fail("manifest_limit", `${label}.subtitles exceeds its limit.`);
    value.subtitles.forEach(validateManifestSubtitle);
  }
  validateFingerprint(value.fingerprint, value.sourceRevision);
};

export const validateClusterManifestPage = (input) => {
  const value = plainObject(input, "manifest page");
  exactKeys(value, new Set(["complete", "cursor", "manifestRevision", "nodeId", "protocolVersion", "sources"]), "manifest page");
  protocolVersion(value.protocolVersion);
  id(value.nodeId, "nodeId");
  integer(value.manifestRevision, "manifestRevision", { min: 1 });
  if (typeof value.complete !== "boolean") fail("invalid_manifest", "complete must be a boolean.");
  if (value.cursor !== null && (typeof value.cursor !== "string" || !TOKEN_PATTERN.test(value.cursor))) fail("invalid_cursor", "cursor is invalid.");
  if (!Array.isArray(value.sources) || value.sources.length > CLUSTER_MANIFEST_PAGE_LIMIT) fail("manifest_limit", `sources must contain at most ${CLUSTER_MANIFEST_PAGE_LIMIT} entries.`);
  value.sources.forEach(validateManifestSource);
  return value;
};

export const validateClusterSignedEnvelope = (input) => {
  const value = plainObject(input, "signed envelope");
  exactKeys(value, new Set(["bodyDigest", "method", "nodeId", "nonce", "path", "protocolVersion", "signature", "timestamp"]), "signed envelope");
  protocolVersion(value.protocolVersion);
  id(value.nodeId, "nodeId");
  if (!METHODS.has(value.method)) fail("invalid_method", "method is not supported.");
  if (typeof value.path !== "string" || !/^\/api\/shard\/v1\/[A-Za-z0-9/_-]*$/.test(value.path) || value.path.includes("//") || value.path.includes("..")) fail("invalid_path", "path must be a canonical shard API path.");
  if (typeof value.bodyDigest !== "string" || !HEX_256_PATTERN.test(value.bodyDigest)) fail("invalid_digest", "bodyDigest must be a lowercase SHA-256 digest.");
  if (typeof value.nonce !== "string" || !TOKEN_PATTERN.test(value.nonce)) fail("invalid_nonce", "nonce is invalid.");
  timestamp(value.timestamp, "timestamp");
  base64UrlBytes(value.signature, "signature", 64);
  return value;
};

export const validateClusterDelegatedMediaGrant = (input) => {
  const value = plainObject(input, "delegated media grant");
  exactKeys(value, new Set(["accountId", "assetPrefix", "clientOrigin", "clusterId", "deliveryId", "deliveryProtocol", "deviceId", "expiresAt", "federatedItemId", "grantId", "issuedAt", "localSourceId", "methods", "nodeId", "nonce", "profileId", "protocolVersion", "sessionId", "sourceRevision", "subtitleId"]), "delegated media grant");
  protocolVersion(value.protocolVersion);
  for (const key of ["accountId", "clusterId", "deviceId", "federatedItemId", "grantId", "localSourceId", "nodeId", "sessionId"]) id(value[key], key);
  if (value.deliveryId !== null) id(value.deliveryId, "deliveryId");
  if (value.subtitleId !== null && value.subtitleId !== undefined) id(value.subtitleId, "subtitleId");
  if (!new Set(["file", "hls"]).has(value.deliveryProtocol) || (value.deliveryId === null && value.deliveryProtocol !== "file")) fail("invalid_delivery", "The delegated delivery scope is invalid.");
  if (!Array.isArray(value.methods) || value.methods.length === 0 || value.methods.length > 2 || value.methods.some((entry) => !MEDIA_METHODS.has(entry))) fail("invalid_method", "methods may contain only GET and HEAD.");
  if (typeof value.assetPrefix !== "string" || !/^\/api\/shard\/v1\/media\/[A-Za-z0-9_-]+\/$/.test(value.assetPrefix)) fail("invalid_path", "assetPrefix must be a scoped shard media prefix.");
  if (value.clientOrigin !== "capacitor://localhost") {
    let clientOrigin;
    try { clientOrigin = new URL(value.clientOrigin); } catch { fail("invalid_origin", "clientOrigin must be an exact supported origin."); }
    if (!new Set(["http:", "https:"]).has(clientOrigin.protocol) || clientOrigin.username || clientOrigin.password
      || clientOrigin.pathname !== "/" || clientOrigin.search || clientOrigin.hash || clientOrigin.origin !== value.clientOrigin) {
      fail("invalid_origin", "clientOrigin must be an exact supported origin.");
    }
  }
  if (!PROFILE_IDS.has(value.profileId)) fail("invalid_profile", "profileId is unsupported.");
  integer(value.sourceRevision, "sourceRevision", { min: 1 });
  if (typeof value.nonce !== "string" || !TOKEN_PATTERN.test(value.nonce)) fail("invalid_nonce", "nonce is invalid.");
  const issuedAt = Date.parse(timestamp(value.issuedAt, "issuedAt"));
  const expiresAt = Date.parse(timestamp(value.expiresAt, "expiresAt"));
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 30 * 60 * 1000) fail("invalid_expiry", "grant expiry must be after issuance and no more than 30 minutes later.");
  return value;
};
