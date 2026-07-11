const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const integer = (value) => {
  const parsed = number(value);
  return parsed === null ? null : Math.trunc(parsed);
};

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

const frameRate = (value) => {
  if (!value || value === "0/0") return null;
  const [top, bottom] = String(value).split("/").map(Number);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return number(value);
  return top / bottom;
};

const bitDepth = (stream) => integer(stream.bits_per_raw_sample)
  ?? integer(stream.bits_per_sample)
  ?? integer(/(?:p|gbrp)(\d{2})(?:le|be)?$/i.exec(stream.pix_fmt ?? "")?.[1]);

const hdr = (stream) => {
  const transfer = text(stream.color_transfer)?.toLowerCase() ?? null;
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  const dolbyVision = sideData.some((entry) => /dovi|dolby vision/i.test(entry.side_data_type ?? ""));
  const format = dolbyVision ? "dolby_vision"
    : transfer === "smpte2084" ? "hdr10"
      : transfer === "arib-std-b67" ? "hlg"
        : null;
  return {
    format,
    colorPrimaries: text(stream.color_primaries),
    colorSpace: text(stream.color_space),
    colorTransfer: text(stream.color_transfer)
  };
};

const disposition = (stream, key) => Boolean(integer(stream.disposition?.[key]));
const common = (stream) => ({
  index: integer(stream.index),
  codec: text(stream.codec_name),
  codecLongName: text(stream.codec_long_name),
  title: text(stream.tags?.title),
  language: text(stream.tags?.language)
});

export const normalizeFfprobe = (raw) => {
  if (!raw || typeof raw !== "object") throw new TypeError("FFprobe result must be an object.");
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  return {
    format: {
      name: text(raw.format?.format_name),
      longName: text(raw.format?.format_long_name),
      durationSeconds: number(raw.format?.duration),
      bitrate: integer(raw.format?.bit_rate),
      sizeBytes: integer(raw.format?.size)
    },
    video: streams.filter((stream) => stream.codec_type === "video").map((stream) => ({
      ...common(stream),
      width: integer(stream.width),
      height: integer(stream.height),
      frameRate: frameRate(stream.avg_frame_rate || stream.r_frame_rate),
      pixelFormat: text(stream.pix_fmt),
      bitDepth: bitDepth(stream),
      hdr: hdr(stream),
      default: disposition(stream, "default")
    })),
    audio: streams.filter((stream) => stream.codec_type === "audio").map((stream) => ({
      ...common(stream),
      channels: integer(stream.channels),
      channelLayout: text(stream.channel_layout),
      sampleRate: integer(stream.sample_rate),
      bitrate: integer(stream.bit_rate),
      default: disposition(stream, "default")
    })),
    subtitles: streams.filter((stream) => stream.codec_type === "subtitle").map((stream) => ({
      ...common(stream),
      default: disposition(stream, "default"),
      forced: disposition(stream, "forced"),
      hearingImpaired: disposition(stream, "hearing_impaired")
    })),
    chapters: (Array.isArray(raw.chapters) ? raw.chapters : []).map((chapter) => ({
      id: integer(chapter.id),
      startSeconds: number(chapter.start_time),
      endSeconds: number(chapter.end_time),
      title: text(chapter.tags?.title)
    }))
  };
};
