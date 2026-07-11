import { randomUUID } from "node:crypto";

export const PROBE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS media_probe_results (
  source_id TEXT PRIMARY KEY REFERENCES media_sources(id) ON DELETE CASCADE,
  format_name TEXT, format_long_name TEXT, duration_seconds REAL,
  bitrate INTEGER, size_bytes INTEGER, probed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media_streams (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
  stream_index INTEGER NOT NULL, stream_type TEXT NOT NULL,
  codec TEXT, codec_long_name TEXT, title TEXT, language TEXT,
  default_flag INTEGER NOT NULL DEFAULT 0, forced_flag INTEGER NOT NULL DEFAULT 0,
  hearing_impaired_flag INTEGER NOT NULL DEFAULT 0,
  width INTEGER, height INTEGER, frame_rate REAL, pixel_format TEXT, bit_depth INTEGER,
  hdr_format TEXT, color_primaries TEXT, color_space TEXT, color_transfer TEXT,
  channels INTEGER, channel_layout TEXT, sample_rate INTEGER, bitrate INTEGER,
  UNIQUE(source_id, stream_index)
);
CREATE INDEX IF NOT EXISTS media_streams_source_type ON media_streams(source_id, stream_type);
CREATE TABLE IF NOT EXISTS media_chapters (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL, start_seconds REAL, end_seconds REAL, title TEXT,
  UNIQUE(source_id, chapter_index)
);
CREATE INDEX IF NOT EXISTS media_chapters_source ON media_chapters(source_id, chapter_index);
`;

export const probeMigration = Object.freeze({
  domain: "probe",
  version: 1,
  id: "probe-v1",
  apply(database) { database.exec(PROBE_SCHEMA_SQL); }
});

const transaction = (database, action) => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const createProbeCatalogWriter = (database, { now = () => new Date().toISOString(), uuid = randomUUID } = {}) => ({
  putProbeResult(sourceId, result) {
    return transaction(database, () => {
      if (!database.prepare("SELECT 1 FROM media_sources WHERE id = ?").get(sourceId)) throw new Error(`Unknown catalog source: ${sourceId}`);
      const format = result.format ?? {};
      database.prepare(`INSERT INTO media_probe_results
        (source_id, format_name, format_long_name, duration_seconds, bitrate, size_bytes, probed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET
        format_name = excluded.format_name, format_long_name = excluded.format_long_name,
        duration_seconds = excluded.duration_seconds, bitrate = excluded.bitrate,
        size_bytes = excluded.size_bytes, probed_at = excluded.probed_at`)
        .run(sourceId, format.name, format.longName, format.durationSeconds, format.bitrate, format.sizeBytes, now());
      database.prepare("DELETE FROM media_streams WHERE source_id = ?").run(sourceId);
      database.prepare("DELETE FROM media_chapters WHERE source_id = ?").run(sourceId);
      const insertStream = database.prepare(`INSERT INTO media_streams
        (id, source_id, stream_index, stream_type, codec, codec_long_name, title, language,
        default_flag, forced_flag, hearing_impaired_flag, width, height, frame_rate, pixel_format,
        bit_depth, hdr_format, color_primaries, color_space, color_transfer, channels,
        channel_layout, sample_rate, bitrate) VALUES (${Array(24).fill("?").join(", ")})`);
      for (const [type, streams] of [["video", result.video], ["audio", result.audio], ["subtitle", result.subtitles]]) {
        for (const stream of streams ?? []) insertStream.run(
          uuid(), sourceId, stream.index, type, stream.codec, stream.codecLongName, stream.title, stream.language,
          stream.default ? 1 : 0, stream.forced ? 1 : 0, stream.hearingImpaired ? 1 : 0,
          stream.width ?? null, stream.height ?? null, stream.frameRate ?? null, stream.pixelFormat ?? null,
          stream.bitDepth ?? null, stream.hdr?.format ?? null, stream.hdr?.colorPrimaries ?? null,
          stream.hdr?.colorSpace ?? null, stream.hdr?.colorTransfer ?? null, stream.channels ?? null,
          stream.channelLayout ?? null, stream.sampleRate ?? null, stream.bitrate ?? null
        );
      }
      const insertChapter = database.prepare("INSERT INTO media_chapters (id, source_id, chapter_index, start_seconds, end_seconds, title) VALUES (?, ?, ?, ?, ?, ?)");
      for (const [index, chapter] of (result.chapters ?? []).entries()) {
        insertChapter.run(uuid(), sourceId, chapter.id ?? index, chapter.startSeconds, chapter.endSeconds, chapter.title);
      }
      return result;
    });
  }
});
