const PROFILE_VERSION = 1;

const profile = (value) => Object.freeze({
  audioBitrate: 128_000,
  audioChannels: 2,
  audioCodec: "aac",
  container: "mpegts",
  hdrPolicy: "sdr-only",
  maxFrameRate: 60,
  pixelFormat: "yuv420p",
  protocol: "hls",
  segmentDurationSeconds: 4,
  version: PROFILE_VERSION,
  videoCodec: "h264",
  ...value
});

export const RENDITION_PROFILES = Object.freeze([
  profile({ id: "480p", label: "480p", maxHeight: 480, maxWidth: 854, totalBitrate: 2_000_000, videoBitrate: 1_800_000 }),
  profile({ id: "720p", label: "720p HD", maxHeight: 720, maxWidth: 1280, totalBitrate: 4_000_000, videoBitrate: 3_600_000 }),
  profile({ audioBitrate: 192_000, id: "1080p", label: "1080p Full HD", maxHeight: 1080, maxWidth: 1920, totalBitrate: 8_000_000, videoBitrate: 7_400_000 })
]);

const byId = new Map(RENDITION_PROFILES.map((entry) => [entry.id, entry]));

export const getRenditionProfile = (id) => byId.get(String(id ?? "")) ?? null;

export const normalizeQualityPreference = (value) => {
  if (value === undefined || value === null) return { mode: "auto" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.mode === "auto" || value.mode === "original") return { mode: value.mode };
  if (value.mode === "profile" && getRenditionProfile(value.profileId)) return { mode: "profile", profileId: value.profileId };
  return null;
};

export const listRenditionProfiles = ({ sourceHeight = null, sourceWidth = null } = {}) => {
  const widthKnown = Number.isFinite(sourceWidth) && sourceWidth > 0;
  const heightKnown = Number.isFinite(sourceHeight) && sourceHeight > 0;
  if (!widthKnown && !heightKnown) return [...RENDITION_PROFILES];
  return RENDITION_PROFILES.filter((entry) =>
    (widthKnown && sourceWidth >= entry.maxWidth) || (heightKnown && sourceHeight >= entry.maxHeight)
  );
};

export const renditionProfileVersion = PROFILE_VERSION;
