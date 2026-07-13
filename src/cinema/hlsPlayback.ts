import Hls, { ErrorTypes, Events, type ErrorData, type HlsConfig } from "hls.js";

const HLS_MIME_TYPE = "application/vnd.apple.mpegurl";

export type HlsPlaybackMode = "native" | "hls.js";
export type HlsPlaybackErrorKind = "network" | "media" | "other";

export interface HlsPlaybackError {
  fatal: true;
  kind: HlsPlaybackErrorKind;
  message: string;
}

export interface HlsPlaybackHandle {
  mode: HlsPlaybackMode;
  ready: Promise<void>;
  destroy(): void;
}

type HlsInstance = Pick<Hls, "attachMedia" | "destroy" | "loadSource" | "on" | "recoverMediaError">;

export interface HlsConstructor {
  new (config?: Partial<HlsConfig>): HlsInstance;
  isSupported(): boolean;
}

export interface CreateHlsPlaybackOptions {
  media: HTMLMediaElement;
  manifestUrl: string;
  onReady?: () => void;
  onError?: (error: HlsPlaybackError) => void;
  hlsConstructor?: HlsConstructor;
  pageUrl?: string;
}

export function supportsHlsPlayback(
  media: Pick<HTMLMediaElement, "canPlayType">,
  hlsConstructor: HlsConstructor = Hls
): boolean {
  return Boolean(media.canPlayType(HLS_MIME_TYPE)) || hlsConstructor.isSupported();
}

function isSameOrigin(manifestUrl: string, pageUrl?: string): boolean {
  const baseUrl = pageUrl ?? globalThis.location?.href;
  if (!baseUrl) return true;

  try {
    return new URL(manifestUrl, baseUrl).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function classifyError(data: Pick<ErrorData, "type">): HlsPlaybackError {
  if (data.type === ErrorTypes.NETWORK_ERROR) {
    return { fatal: true, kind: "network", message: "The HLS stream could not be loaded." };
  }
  if (data.type === ErrorTypes.MEDIA_ERROR) {
    return { fatal: true, kind: "media", message: "The HLS stream could not be decoded." };
  }
  return { fatal: true, kind: "other", message: "HLS playback failed." };
}

export function createHlsPlayback(options: CreateHlsPlaybackOptions): HlsPlaybackHandle {
  const { media, manifestUrl, onReady, onError, pageUrl } = options;
  const HlsImplementation = options.hlsConstructor ?? Hls;
  const nativeSupported = Boolean(media.canPlayType(HLS_MIME_TYPE));
  const previousSrc = media.getAttribute("src");
  let destroyed = false;
  let settled = false;
  let hls: HlsInstance | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (error: HlsPlaybackError) => void;

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const finishReady = () => {
    if (destroyed || settled) return;
    settled = true;
    onReady?.();
    resolveReady();
  };

  const finishError = (error: HlsPlaybackError) => {
    if (destroyed || settled) return;
    settled = true;
    onError?.(error);
    rejectReady(error);
  };

  const onNativeError = () => {
    finishError({ fatal: true, kind: "media", message: "Native HLS playback failed." });
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (!settled) {
      settled = true;
      rejectReady({ fatal: true, kind: "other", message: "HLS playback was stopped." });
    }
    media.removeEventListener("loadedmetadata", finishReady);
    media.removeEventListener("error", onNativeError);
    hls?.destroy();
    hls = null;
    if (previousSrc === null) media.removeAttribute("src");
    else media.setAttribute("src", previousSrc);
    media.load();
  };

  if (nativeSupported) {
    media.addEventListener("loadedmetadata", finishReady, { once: true });
    media.addEventListener("error", onNativeError, { once: true });
    media.src = manifestUrl;
    media.load();
    return { mode: "native", ready, destroy };
  }

  if (!HlsImplementation.isSupported()) {
    finishError({ fatal: true, kind: "other", message: "HLS playback is not supported." });
    return { mode: "hls.js", ready, destroy };
  }

  const credentialed = isSameOrigin(manifestUrl, pageUrl);
  hls = new HlsImplementation({
    fetchSetup: (context, initParams) =>
      new Request(context.url, { ...initParams, credentials: "same-origin" }),
    xhrSetup: (xhr) => {
      if (credentialed) xhr.withCredentials = true;
    }
  });

  let mediaRecoveryAttempted = false;
  hls.on(Events.MANIFEST_PARSED, finishReady);
  hls.on(Events.ERROR, (_event, data: ErrorData) => {
    if (!data.fatal || destroyed || settled) return;
    if (data.type === ErrorTypes.MEDIA_ERROR && !mediaRecoveryAttempted) {
      mediaRecoveryAttempted = true;
      hls?.recoverMediaError();
      return;
    }
    finishError(classifyError(data));
  });
  hls.loadSource(manifestUrl);
  hls.attachMedia(media);

  return { mode: "hls.js", ready, destroy };
}
