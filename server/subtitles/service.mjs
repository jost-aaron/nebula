import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const MODES = new Set(["off", "forced-only", "preferred"]);
const FORMATS = new Map([[".vtt", { format: "webvtt", contentType: "text/vtt; charset=utf-8" }], [".srt", { format: "srt", contentType: "application/x-subrip; charset=utf-8" }]]);
const languagePattern = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const httpError = (status, message, code) => Object.assign(new Error(message), { status, message, code, expose: true });
const stableId = (...parts) => `sub_${createHash("sha256").update(parts.join("\0")).digest("base64url").slice(0, 24)}`;
const normalizeLanguage = (value) => {
  const language = String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
  if (!languagePattern.test(language)) throw httpError(400, "Subtitle languages must be valid BCP 47 language tags.", "invalid_language");
  return language;
};
const parsePreference = (input) => {
  if (!MODES.has(input?.mode)) throw httpError(400, "Subtitle mode is invalid.", "invalid_subtitle_mode");
  if (!Array.isArray(input.languages) || input.languages.length > 10) throw httpError(400, "Subtitle languages must be an ordered list of at most 10 entries.", "invalid_language");
  const languages = input.languages.map(normalizeLanguage);
  if (new Set(languages).size !== languages.length) throw httpError(409, "Subtitle languages must not contain duplicates.", "duplicate_language");
  return { mode: input.mode, languages };
};
const markerInfo = (mediaBase, subtitleBase) => {
  if (subtitleBase === mediaBase) return { language: null, forced: false, default: false };
  if (!subtitleBase.startsWith(`${mediaBase}.`)) return null;
  const tokens = subtitleBase.slice(mediaBase.length + 1).split(".").filter(Boolean);
  let language = null;
  let forced = false;
  let isDefault = false;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "forced") forced = true;
    else if (lower === "default") isDefault = true;
    else if (!language && languagePattern.test(lower)) language = lower;
    else return null;
  }
  return { language, forced, default: isDefault };
};

export const createSubtitleService = ({ database, contentRoot, resolveSource, probeReader, canAccessItem, now = () => new Date().toISOString() }) => {
  const ephemeral = new Map();
  const principalKey = (principal) => principal?.type === "user" ? `user:${principal.userId}` : principal?.type === "guest" ? `guest:${principal.sessionId}` : null;
  const requireAccess = (ids, principal) => {
    const authorizationPrincipal = principal?.type === "guest" ? { ...principal, kind: "guest" } : principal;
    if (!principalKey(principal) || !canAccessItem(authorizationPrincipal, ids.itemId)) throw httpError(404, "Media item not found.", "item_not_found");
    const source = resolveSource(ids, authorizationPrincipal);
    if (!source) throw httpError(404, "Media source not found.", "source_not_found");
    return source;
  };
  const discover = async (ids, principal) => {
    const source = requireAccess(ids, principal);
    const absoluteMedia = path.resolve(contentRoot, source.path);
    const rootReal = await realpath(contentRoot);
    const mediaReal = await realpath(absoluteMedia);
    if (!(mediaReal === rootReal || mediaReal.startsWith(`${rootReal}${path.sep}`))) throw httpError(404, "Media source not found.", "source_not_found");
    const directory = path.dirname(mediaReal);
    const mediaBase = path.basename(mediaReal, path.extname(mediaReal));
    const tracks = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const spec = FORMATS.get(path.extname(entry.name).toLowerCase());
      if (!spec || !entry.isFile() || entry.isSymbolicLink()) continue;
      const markers = markerInfo(mediaBase, path.basename(entry.name, path.extname(entry.name)));
      if (!markers) continue;
      const candidate = path.join(directory, entry.name);
      const details = await lstat(candidate);
      if (!details.isFile() || details.size > 10 * 1024 * 1024) continue;
      const candidateReal = await realpath(candidate);
      if (path.dirname(candidateReal) !== directory) continue;
      tracks.push({ id: stableId(ids.sourceId, entry.name), kind: "sidecar", format: spec.format, language: markers.language, forced: markers.forced, default: markers.default, label: [markers.language?.toUpperCase() ?? "Unknown", markers.forced ? "Forced" : ""].filter(Boolean).join(" · "), _path: candidateReal, _contentType: spec.contentType });
    }
    const embedded = probeReader?.get(ids.sourceId)?.streams?.filter((stream) => stream.type === "subtitle").map((stream) => ({
      id: stableId(ids.sourceId, "embedded", String(stream.index)), kind: "embedded", format: String(stream.codec ?? "unknown").toLowerCase(), language: stream.language?.toLowerCase() ?? null, forced: Boolean(stream.forced), default: Boolean(stream.default), label: stream.title ?? [stream.language?.toUpperCase() ?? "Unknown", stream.forced ? "Forced" : ""].filter(Boolean).join(" · "), streamIndex: stream.index
    })) ?? [];
    return [...embedded, ...tracks].sort((a, b) => Number(b.forced) - Number(a.forced) || Number(b.default) - Number(a.default) || a.id.localeCompare(b.id));
  };
  const getPreference = (principal) => {
    if (principal?.type !== "user") return { mode: "off", languages: [], persistent: false };
    const row = database.prepare("SELECT mode, languages_json FROM subtitle_preferences WHERE user_id = ?").get(principal.userId);
    return row ? { mode: row.mode, languages: JSON.parse(row.languages_json), persistent: true } : { mode: "off", languages: [], persistent: true };
  };
  const choose = (tracks, preference, explicitId) => {
    if (explicitId === null || preference.mode === "off" && explicitId === undefined) return { track: null, reason: "SUBTITLES_OFF" };
    if (explicitId) return { track: tracks.find((track) => track.id === explicitId) ?? null, reason: tracks.some((track) => track.id === explicitId) ? "SUBTITLE_EXPLICIT" : "SUBTITLE_NOT_FOUND" };
    const forced = tracks.filter((track) => track.forced);
    const candidates = preference.mode === "forced-only" ? forced : tracks;
    for (const language of preference.languages) {
      const match = candidates.find((track) => track.language === language || track.language?.startsWith(`${language}-`));
      if (match) return { track: match, reason: match.forced ? "SUBTITLE_FORCED_LANGUAGE" : "SUBTITLE_PREFERRED_LANGUAGE" };
    }
    const fallback = preference.mode === "forced-only" ? forced[0] : forced[0] ?? candidates.find((track) => track.default);
    return { track: fallback ?? null, reason: fallback ? "SUBTITLE_DEFAULT" : "NO_SUBTITLE_MATCH" };
  };
  return {
    discover,
    getPreference,
    setPreference(input, principal) {
      if (principal?.type !== "user") throw httpError(403, "Guests cannot persist subtitle preferences.", "guest_non_persistent");
      const value = parsePreference(input);
      database.prepare(`INSERT INTO subtitle_preferences(user_id,mode,languages_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode,languages_json=excluded.languages_json,updated_at=excluded.updated_at`).run(principal.userId, value.mode, JSON.stringify(value.languages), now());
      return { ...value, persistent: true };
    },
    async selection(ids, principal, explicitId) {
      const tracks = await discover(ids, principal);
      const key = principalKey(principal);
      const sessionChoice = explicitId === undefined ? ephemeral.get(`${key}:${ids.itemId}:${ids.sourceId}`) : explicitId;
      return { tracks: tracks.map(({ _path, _contentType, ...track }) => track), ...choose(tracks, getPreference(principal), sessionChoice) };
    },
    async setEphemeralSelection(ids, subtitleId, principal) {
      const tracks = await discover(ids, principal);
      if (subtitleId !== null && !tracks.some((track) => track.id === subtitleId)) throw httpError(404, "Subtitle track not found.", "subtitle_not_found");
      ephemeral.set(`${principalKey(principal)}:${ids.itemId}:${ids.sourceId}`, subtitleId);
      return { selectedSubtitleId: subtitleId };
    },
    async resolveAsset(ids, subtitleId, principal) {
      const track = (await discover(ids, principal)).find((candidate) => candidate.id === subtitleId);
      if (!track || track.kind !== "sidecar") throw httpError(404, "Subtitle asset not found.", "subtitle_not_found");
      const contents = await readFile(track._path);
      if (contents.includes(0)) throw httpError(422, "Subtitle encoding is unsupported.", "unsupported_encoding");
      const text = contents.toString("utf8").replace(/^\uFEFF/, "");
      if (track.format === "webvtt" && !/^WEBVTT(?:\s|$)/.test(text)) throw httpError(422, "WebVTT content is malformed.", "invalid_subtitle_content");
      if (track.format === "srt" && !/\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[,.]\d{3}/.test(text)) throw httpError(422, "SRT content is malformed.", "invalid_subtitle_content");
      return { path: track._path, contentType: track._contentType };
    },
    providerStatus() { return { acquisitionEnabled: false, providers: [], reason: "No allowlisted subtitle acquisition provider is configured." }; },
    setProviderConfig(input) { if (input?.enabled !== false) throw httpError(400, "No allowlisted subtitle provider is available.", "provider_unavailable"); return this.providerStatus(); }
  };
};
