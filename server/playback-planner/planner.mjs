import { RENDITION_PROFILES, getRenditionProfile, listRenditionProfiles, normalizeQualityPreference } from "../renditions/profiles.mjs";

const SOFTWARE_VIDEO_CODEC = "h264";
const SOFTWARE_AUDIO_CODEC = "aac";
const HLS_CONTAINER = "mpegts";

const aliases = new Map([
  ["avc", "h264"], ["avc1", "h264"], ["hevc", "h265"], ["x265", "h265"],
  ["matroska,webm", "matroska"], ["mov,mp4,m4a,3gp,3g2,mj2", "mp4"], ["subrip", "srt"]
]);

const normalize = (value) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized ? aliases.get(normalized) ?? normalized : null;
};
const finiteMin = (...values) => {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length ? Math.min(...finite) : null;
};
const fitsClient = (profile, capabilities) =>
  (capabilities.maxWidth === null || profile.maxWidth <= capabilities.maxWidth)
  && (capabilities.maxHeight === null || profile.maxHeight <= capabilities.maxHeight)
  && (capabilities.maxBitrate === null || profile.totalBitrate <= capabilities.maxBitrate);
const fitDimensions = (video, profile) => {
  if (!Number.isFinite(video?.width) || !Number.isFinite(video?.height) || video.width <= 0 || video.height <= 0) return null;
  const ratio = Math.min(1, profile.maxWidth / video.width, profile.maxHeight / video.height);
  return {
    height: Math.max(2, Math.floor((video.height * ratio) / 2) * 2),
    width: Math.max(2, Math.floor((video.width * ratio) / 2) * 2)
  };
};

const list = (values) => new Set(values.map(normalize).filter(Boolean));
const reason = (code, message, streamIndex = null) => ({ code, message, streamIndex });
const streamIndex = (stream) => Number.isInteger(stream?.index) ? stream.index : null;
const firstSelected = (streams, type) => {
  const candidates = streams.filter((stream) => stream.type === type);
  return candidates.find((stream) => stream.default) ?? candidates[0] ?? null;
};

const validateCapabilities = (capabilities) => {
  if (!capabilities || typeof capabilities !== "object") return "Capabilities must be an object.";
  for (const field of ["audioCodecs", "containers", "subtitleFormats", "videoCodecs"]) {
    if (!Array.isArray(capabilities[field]) || capabilities[field].some((entry) => !normalize(entry))) {
      return `${field} must contain non-empty strings.`;
    }
  }
  if (typeof capabilities.deviceId !== "string" || !capabilities.deviceId.trim()) return "deviceId must be a non-empty string.";
  if (typeof capabilities.supportsHls !== "boolean") return "supportsHls must be a boolean.";
  for (const field of ["maxAudioChannels", "maxBitrate", "maxHeight", "maxWidth"]) {
    const value = capabilities[field];
    if (value !== null && (!Number.isFinite(value) || value <= 0)) return `${field} must be null or a positive number.`;
  }
  return null;
};

const unsupported = (request, reasons) => ({
  decision: "unsupported", itemId: request?.itemId ?? "", sourceId: request?.sourceId ?? "",
  output: { audioCodec: null, bitrate: null, container: null, protocol: null, videoCodec: null }, reasons
});

const REMUX_COMPATIBILITY = Object.freeze({
  matroska: { audio: null, video: null },
  mp4: { audio: new Set(["aac", "ac3", "eac3", "mp3"]), video: new Set(["av1", "h264", "h265", "mpeg4"]) },
  mpegts: { audio: new Set(["aac", "ac3", "eac3", "mp3"]), video: new Set(["h264", "h265", "mpeg2video"]) },
  webm: { audio: new Set(["opus", "vorbis"]), video: new Set(["av1", "vp8", "vp9"]) }
});

const remuxContainer = (containers, video, audio) => ["mp4", "matroska", "webm", "mpegts"].find((container) => {
  if (!containers.has(container)) return false;
  const compatibility = REMUX_COMPATIBILITY[container];
  return (!video || compatibility.video === null || compatibility.video.has(normalize(video.codec)))
    && (!audio || compatibility.audio === null || compatibility.audio.has(normalize(audio.codec)));
}) ?? null;

export const planPlayback = (request, media) => {
  const malformed = validateCapabilities(request?.capabilities);
  if (malformed) return unsupported(request, [reason("MALFORMED_CAPABILITIES", malformed)]);
  const quality = normalizeQualityPreference(request?.quality);
  if (!quality) return unsupported(request, [reason("MALFORMED_QUALITY", "The requested playback quality is invalid.")]);

  if (!media || typeof media !== "object") return unsupported(request, [reason("CATALOG_SOURCE_NOT_FOUND", "The requested catalog source was not found.")]);
  if (media.item?.id !== request.itemId || media.source?.id !== request.sourceId || media.source?.itemId !== request.itemId) {
    return unsupported(request, [reason("CATALOG_ID_MISMATCH", "The item and source do not identify the same catalog media.")]);
  }
  if (media.source.availability !== "available") return unsupported(request, [reason("SOURCE_UNAVAILABLE", "The requested media source is not available.")]);
  if (!media.probe || media.probe.probeState !== "ready" || !media.probe.format) {
    return unsupported(request, [reason("PROBE_DATA_UNAVAILABLE", "Technical media data is not ready for this source.")]);
  }

  const capabilities = request.capabilities;
  const requestedProfile = quality.mode === "profile" ? getRenditionProfile(quality.profileId) : null;
  const containers = list(capabilities.containers);
  const videoCodecs = list(capabilities.videoCodecs);
  const audioCodecs = list(capabilities.audioCodecs);
  const subtitleFormats = list(capabilities.subtitleFormats);
  const streams = Array.isArray(media.probe.streams) ? media.probe.streams : [];
  const video = firstSelected(streams, "video");
  const audio = firstSelected(streams, "audio");
  const legacySubtitles = media.subtitleSelection ? [] : streams.filter((stream) => stream.type === "subtitle" && (stream.default || stream.forced));
  const subtitleSelection = media.subtitleSelection ?? { track: null, reason: "NO_SUBTITLE_MATCH" };
  const subtitle = subtitleSelection.track;
  const originalContainer = normalize(media.probe.format.name);
  const incompatibilities = [];

  if (!originalContainer) incompatibilities.push(reason("CONTAINER_UNKNOWN", "The source container is unknown."));
  else if (!containers.has(originalContainer)) incompatibilities.push(reason("CONTAINER_UNSUPPORTED", `Container ${originalContainer} is not supported by the client.`));
  if (video && !videoCodecs.has(normalize(video.codec))) incompatibilities.push(reason("VIDEO_CODEC_UNSUPPORTED", `Video codec ${normalize(video.codec) ?? "unknown"} is not supported by the client.`, streamIndex(video)));
  if (audio && !audioCodecs.has(normalize(audio.codec))) incompatibilities.push(reason("AUDIO_CODEC_UNSUPPORTED", `Audio codec ${normalize(audio.codec) ?? "unknown"} is not supported by the client.`, streamIndex(audio)));
  if (video && capabilities.maxWidth !== null && (!Number.isFinite(video.width) || video.width > capabilities.maxWidth)) incompatibilities.push(reason("VIDEO_WIDTH_EXCEEDED", `Video width ${video.width ?? "unknown"} exceeds the client limit of ${capabilities.maxWidth}.`, streamIndex(video)));
  if (video && capabilities.maxHeight !== null && (!Number.isFinite(video.height) || video.height > capabilities.maxHeight)) incompatibilities.push(reason("VIDEO_HEIGHT_EXCEEDED", `Video height ${video.height ?? "unknown"} exceeds the client limit of ${capabilities.maxHeight}.`, streamIndex(video)));
  const bitrate = media.probe.format.bitrate;
  if (capabilities.maxBitrate !== null && (!Number.isFinite(bitrate) || bitrate > capabilities.maxBitrate)) incompatibilities.push(reason("BITRATE_EXCEEDED", `Source bitrate ${bitrate ?? "unknown"} exceeds the client limit of ${capabilities.maxBitrate}.`));
  if (audio && capabilities.maxAudioChannels !== null && (!Number.isFinite(audio.channels) || audio.channels > capabilities.maxAudioChannels)) incompatibilities.push(reason("AUDIO_CHANNELS_EXCEEDED", `Audio channels ${audio.channels ?? "unknown"} exceed the client limit of ${capabilities.maxAudioChannels}.`, streamIndex(audio)));
  if (requestedProfile) incompatibilities.push(reason("QUALITY_PROFILE_REQUESTED", `The ${requestedProfile.label} rendition was requested.`));
  const subtitleFormat = normalize(subtitle?.format);
  const subtitleNative = !subtitle || (subtitle.kind === "sidecar" && subtitleFormats.has(subtitleFormat)) || (subtitle.kind === "embedded" && subtitleFormats.has(subtitleFormat));
  if (subtitle && !subtitleNative) incompatibilities.push(reason("SUBTITLE_BURN_IN_REQUIRED", `Selected subtitle format ${subtitleFormat ?? "unknown"} requires burn-in.`, subtitle.streamIndex ?? null));
  for (const legacySubtitle of legacySubtitles) if (!subtitleFormats.has(normalize(legacySubtitle.codec))) incompatibilities.push(reason("SUBTITLE_FORMAT_UNSUPPORTED", `Subtitle format ${normalize(legacySubtitle.codec) ?? "unknown"} is not supported by the client.`, streamIndex(legacySubtitle)));

  if (incompatibilities.length === 0) return {
    decision: "direct-play", itemId: request.itemId, sourceId: request.sourceId,
    output: { audioCodec: normalize(audio?.codec), bitrate: Number.isFinite(bitrate) ? bitrate : null, container: originalContainer, protocol: "file", videoCodec: normalize(video?.codec), ...(media.subtitleSelection ? { subtitle: subtitle ? { id: subtitle.id, delivery: subtitle.kind === "sidecar" ? "sidecar" : "embedded", format: subtitleFormat } : null } : {}) },
    reasons: [...(media.subtitleSelection ? [reason(subtitleSelection.reason, subtitle ? `Selected ${subtitle.label || subtitle.language || "subtitle"}.` : "No subtitle track was selected.")] : []), reason("DIRECT_PLAY_COMPATIBLE", "The original container and selected streams satisfy all client capabilities.")]
  };

  const onlyContainer = incompatibilities.every(({ code }) => code === "CONTAINER_UNSUPPORTED");
  const targetContainer = onlyContainer ? remuxContainer(containers, video, audio) : null;
  if (onlyContainer && targetContainer) return {
    decision: "remux", itemId: request.itemId, sourceId: request.sourceId,
    output: { audioCodec: normalize(audio?.codec), bitrate: Number.isFinite(bitrate) ? bitrate : null, container: targetContainer, protocol: "file", videoCodec: normalize(video?.codec), ...(media.subtitleSelection ? { subtitle: subtitle ? { id: subtitle.id, delivery: subtitle.kind === "sidecar" ? "sidecar" : "embedded", format: subtitleFormat } : null } : {}) },
    reasons: [...incompatibilities, reason("REMUX_PRESERVES_STREAMS", `The selected streams can be copied into the supported ${targetContainer} container.`)]
  };

  if (quality.mode === "original") return unsupported(request, [
    ...incompatibilities,
    reason("ORIGINAL_QUALITY_UNAVAILABLE", "Original quality cannot be delivered without changing its encoded representation.")
  ]);

  const canTranscodeVideo = !video || videoCodecs.has(SOFTWARE_VIDEO_CODEC);
  const canTranscodeAudio = !audio || audioCodecs.has(SOFTWARE_AUDIO_CODEC);
  const sourceProfiles = video ? listRenditionProfiles({ sourceHeight: video.height, sourceWidth: video.width }) : [];
  const autoPool = sourceProfiles.length ? sourceProfiles : RENDITION_PROFILES.slice(0, 1);
  const autoProfile = video ? [...autoPool].reverse().find((entry) => fitsClient(entry, capabilities)) ?? null : null;
  const transcodeProfile = requestedProfile ?? autoProfile;
  const sourceDimensionsKnown = !video || (Number.isFinite(video.width) && Number.isFinite(video.height) && video.width > 0 && video.height > 0);
  const sourceWouldUpscale = Boolean(requestedProfile && video
    && Number.isFinite(video.width) && Number.isFinite(video.height)
    && video.width < requestedProfile.maxWidth && video.height < requestedProfile.maxHeight);
  const requestedProfileUnavailable = Boolean(requestedProfile && (!video || !sourceDimensionsKnown || !fitsClient(requestedProfile, capabilities) || sourceWouldUpscale));
  if (requestedProfileUnavailable) return unsupported(request, [
    ...incompatibilities,
    reason(sourceWouldUpscale ? "QUALITY_PROFILE_UPSCALE_REQUIRED" : "QUALITY_PROFILE_UNAVAILABLE", sourceWouldUpscale
      ? "The requested rendition would upscale this source."
      : "The requested rendition exceeds this client capability.")
  ]);
  if (video && !transcodeProfile) return unsupported(request, [
    ...incompatibilities,
    reason("RENDITION_PROFILE_UNAVAILABLE", "No standard rendition profile satisfies this source and client.")
  ]);
  if (video && !sourceDimensionsKnown) return unsupported(request, [
    ...incompatibilities,
    reason("SOURCE_DIMENSIONS_UNKNOWN", "A bounded rendition cannot be produced without source dimensions.")
  ]);
  const targetDimensions = transcodeProfile && video ? fitDimensions(video, transcodeProfile) : null;
  if (capabilities.supportsHls && canTranscodeVideo && canTranscodeAudio) return {
    decision: "transcode", itemId: request.itemId, sourceId: request.sourceId,
    output: {
      audioCodec: audio ? SOFTWARE_AUDIO_CODEC : null,
      bitrate: transcodeProfile?.totalBitrate ?? finiteMin(capabilities.maxBitrate, bitrate),
      container: HLS_CONTAINER,
      ...(targetDimensions && transcodeProfile ? { ...targetDimensions, profileId: transcodeProfile.id } : {}),
      protocol: "hls",
      videoCodec: video ? SOFTWARE_VIDEO_CODEC : null,
      ...(media.subtitleSelection ? { subtitle: subtitle ? { id: subtitle.id, delivery: subtitleNative ? "sidecar" : "burn-in", format: subtitleFormat } : null } : {})
    },
    reasons: [...(media.subtitleSelection ? [reason(subtitleSelection.reason, subtitle ? `Selected ${subtitle.label || subtitle.language || "subtitle"}.` : "No subtitle track was selected.")] : []), ...incompatibilities, reason("HLS_SOFTWARE_TRANSCODE", "A software HLS rendition can satisfy the declared client capabilities.")]
  };

  const blockers = [];
  if (!capabilities.supportsHls) blockers.push(reason("HLS_UNSUPPORTED", "The client does not support HLS delivery."));
  if (!canTranscodeVideo) blockers.push(reason("TRANSCODE_VIDEO_TARGET_UNSUPPORTED", `The client does not support the software transcode target ${SOFTWARE_VIDEO_CODEC}.`));
  if (!canTranscodeAudio) blockers.push(reason("TRANSCODE_AUDIO_TARGET_UNSUPPORTED", `The client does not support the software transcode target ${SOFTWARE_AUDIO_CODEC}.`));
  if (onlyContainer && !targetContainer) blockers.push(reason("REMUX_CONTAINER_UNAVAILABLE", "The client declares no supported remux output container."));
  return unsupported(request, [...incompatibilities, ...blockers]);
};

export const createPlaybackPlanner = ({ resolveMedia }) => {
  if (typeof resolveMedia !== "function") throw new TypeError("resolveMedia must be a function.");
  return {
    async plan(request, authorizationContext) {
      const malformed = validateCapabilities(request?.capabilities);
      if (malformed) return unsupported(request, [reason("MALFORMED_CAPABILITIES", malformed)]);
      if (!normalizeQualityPreference(request?.quality)) return unsupported(request, [reason("MALFORMED_QUALITY", "The requested playback quality is invalid.")]);
      const media = await resolveMedia({ itemId: request.itemId, sourceId: request.sourceId }, authorizationContext);
      return planPlayback(request, media);
    }
  };
};
