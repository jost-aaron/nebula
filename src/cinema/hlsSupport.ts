const HLS_MIME_TYPE = "application/vnd.apple.mpegurl";

type MediaSourceCapability = {
  isTypeSupported?: (mimeType: string) => boolean;
};

type SourceBufferCapability = {
  prototype?: {
    appendBuffer?: unknown;
    remove?: unknown;
  };
};

export interface HlsSupportEnvironment {
  ManagedMediaSource?: MediaSourceCapability;
  MediaSource?: MediaSourceCapability;
  SourceBuffer?: SourceBufferCapability;
  WebKitMediaSource?: MediaSourceCapability;
  WebKitSourceBuffer?: SourceBufferCapability;
}

export function supportsHlsPlayback(
  media: Pick<HTMLMediaElement, "canPlayType">,
  environment: HlsSupportEnvironment = globalThis
): boolean {
  if (Boolean(media.canPlayType(HLS_MIME_TYPE))) return true;

  const mediaSource = environment.ManagedMediaSource
    ?? environment.MediaSource
    ?? environment.WebKitMediaSource;
  if (!mediaSource || typeof mediaSource.isTypeSupported !== "function") return false;

  const sourceBuffer = environment.SourceBuffer ?? environment.WebKitSourceBuffer;
  const sourceBufferSupported = !sourceBuffer || Boolean(
    sourceBuffer.prototype
    && typeof sourceBuffer.prototype.appendBuffer === "function"
    && typeof sourceBuffer.prototype.remove === "function"
  );
  if (!sourceBufferSupported) return false;

  return [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4;codecs="av01.0.01M.08"',
    'video/mp4;codecs="vp09.00.50.08"',
    'audio/mp4;codecs="mp4a.40.2"',
    'audio/mp4;codecs="fLaC"'
  ].some((mimeType) => mediaSource.isTypeSupported!(mimeType));
}
