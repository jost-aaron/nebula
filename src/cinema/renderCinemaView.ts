import { createElement, icons } from "lucide";
import { apiUrl, getApiConnectionMode, getEffectiveApiBaseUrl, getApiToken } from "../api/http";
import {
  getCinemaCatalogItem,
  cancelCinemaDelivery,
  completeCinemaDelivery,
  createCinemaDelivery,
  getCinemaDelivery,
  identifyCinemaFrames,
  listCinemaCatalog,
  listCinemaContinueWatching,
  listCinemaLibrary,
  reportCinemaPlayback,
  scanCinemaCatalog,
  updateCinemaMetadata,
  updateCinemaWatched,
  updateCinemaWatchlist
} from "../api/cinemaApi";
import { createCinemaTmdbController, renderTmdbPanel } from "./tmdbUi";
import type {
  CinemaCategory,
  CinemaEntry,
  CinemaIdentificationFrame,
  CinemaIdentifyResponse,
  CinemaMetadataUpdateRequest,
  CinemaWatchlistUpdateRequest
} from "../shared/cinemaTypes";
import type { CinemaTmdbCandidate, CinemaTmdbStatusResponse } from "../shared/cinemaTmdbTypes";
import type { MediaChapter } from "../shared/catalogTypes";
import type { ContinueWatchingEntry, PlaybackEventKind } from "../shared/playbackTypes";
import { addMediaListItem, createMediaList, listMediaLists } from "../api/mediaListsApi";
import type { MediaList } from "../shared/mediaListTypes";
import { getSubtitlePreference, listSubtitleTracks, saveSubtitlePreference, selectSubtitleTrack, subtitleAssetUrl } from "../api/subtitleApi";
import type { SubtitlePreference, SubtitleTracksResponse } from "../shared/subtitleTypes";
import { buildItemRenditions, deleteRendition, listItemRenditions, listRenditionProfiles, setRenditionRetention } from "../api/renditionsApi";
import type { MediaRendition, PlaybackQualityPreference, RenditionProfile, RenditionProfileId } from "../shared/renditionTypes";
import type { PlaybackPlanResponse } from "../shared/playbackPlanTypes";
import { createHlsPlayback, supportsHlsPlayback, type HlsPlaybackHandle } from "./hlsPlayback";

type CinemaView = "library" | "watchlist" | "title-detail" | "player" | "metadata-editor" | "servers" | "identify";

interface CinemaServerInfo {
  address: string;
  authState: string;
  mode: string;
  name: string;
  online: boolean;
}

const categories: Array<{ id: CinemaCategory; label: string; empty: string }> = [
  { empty: "Upload movie files with Files.", id: "movies", label: "Movies" },
  { empty: "Put episode files in a TV, Shows, or Series folder.", id: "tv", label: "TV Shows" }
];

interface CinemaCatalogState {
  chapters: MediaChapter[];
  probeState: string;
}

interface PendingCinemaPlayback {
  entry: CinemaEntry;
  fullscreen: boolean;
  resume: ContinueWatchingEntry;
}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const formatSize = (size: number) => {
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatTime = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
};

const fallbackRenditionProfiles: RenditionProfile[] = [
  { audioBitrate: 128_000, audioChannels: 2, audioCodec: "aac", container: "mpegts", hdrPolicy: "sdr-only", id: "480p", label: "480p", maxFrameRate: 60, maxHeight: 480, maxWidth: 854, pixelFormat: "yuv420p", protocol: "hls", segmentDurationSeconds: 4, totalBitrate: 2_000_000, version: 1, videoBitrate: 1_800_000, videoCodec: "h264" },
  { audioBitrate: 128_000, audioChannels: 2, audioCodec: "aac", container: "mpegts", hdrPolicy: "sdr-only", id: "720p", label: "720p HD", maxFrameRate: 60, maxHeight: 720, maxWidth: 1280, pixelFormat: "yuv420p", protocol: "hls", segmentDurationSeconds: 4, totalBitrate: 4_000_000, version: 1, videoBitrate: 3_600_000, videoCodec: "h264" },
  { audioBitrate: 192_000, audioChannels: 2, audioCodec: "aac", container: "mpegts", hdrPolicy: "sdr-only", id: "1080p", label: "1080p Full HD", maxFrameRate: 60, maxHeight: 1080, maxWidth: 1920, pixelFormat: "yuv420p", protocol: "hls", segmentDurationSeconds: 4, totalBitrate: 8_000_000, version: 1, videoBitrate: 7_400_000, videoCodec: "h264" }
];

const qualityValue = (preference: PlaybackQualityPreference) => preference.mode === "profile" ? preference.profileId : preference.mode;
const parseQualityValue = (value: string): PlaybackQualityPreference => value === "original"
  ? { mode: "original" }
  : (["480p", "720p", "1080p"] as RenditionProfileId[]).includes(value as RenditionProfileId)
    ? { mode: "profile", profileId: value as RenditionProfileId }
    : { mode: "auto" };
const qualityResultLabel = (preference: PlaybackQualityPreference, plan?: PlaybackPlanResponse) => {
  if (!plan) return preference.mode === "profile" ? preference.profileId : preference.mode === "original" ? "Original" : "Auto";
  const result = plan.output.profileId ?? (plan.decision === "direct-play" ? "Original" : plan.decision === "remux" ? "Original · Remux" : "Compatible");
  return preference.mode === "auto" ? `Auto · ${result}` : result;
};

const estimateRuntime = (_entry: CinemaEntry) => "Runtime pending";

const categoryLabel = (category: CinemaCategory) =>
  categories.find((candidate) => candidate.id === category)?.label ?? "Movies";

const searchUrl = (query: string) => `https://www.google.com/search?q=${encodeURIComponent(query)}`;

const metadataLine = (entry: CinemaEntry) =>
  [entry.episode ? `S${entry.episode.seasonNumber} E${entry.episode.episodeNumber}` : "", entry.releaseYear, entry.rating, entry.genres.slice(0, 3).join(", "), estimateRuntime(entry)].filter(Boolean).join(" / ");

const displayTitle = (entry: CinemaEntry) => entry.episode
  ? `${entry.episode.seriesTitle} · S${String(entry.episode.seasonNumber).padStart(2, "0")}E${String(entry.episode.episodeNumber).padStart(2, "0")} · ${entry.title}`
  : entry.title;

const currentServerInfo = (): CinemaServerInfo => ({
  address: getEffectiveApiBaseUrl() || "No server URL",
  authState: getApiToken() ? "Token saved" : "Local unauthenticated",
  mode: getApiConnectionMode(),
  name: getApiConnectionMode() === "Same origin" ? "Nebula Local" : "Nebula Server",
  online: getApiConnectionMode() !== "Needs server URL"
});

const renderPosterFallback = (entry: CinemaEntry) => `
  <div class="cinema-poster-fallback">
    <span>${escapeHtml(entry.title.slice(0, 1).toUpperCase())}</span>
  </div>
`;

const posterStyle = (entry: CinemaEntry) =>
  entry.posterUrl ? ` style="background-image: url('${escapeHtml(entry.posterUrl)}')"` : "";

const backdropStyle = (entry: CinemaEntry) =>
  entry.backdropUrl || entry.posterUrl ? ` style="background-image: url('${escapeHtml(entry.backdropUrl || entry.posterUrl)}')"` : "";

const renderCinemaIcon = (iconName: keyof typeof icons, className = "cinema-ui-icon") => {
  const node = createElement(icons[iconName] ?? icons.Circle);
  node.setAttribute("class", className);
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("focusable", "false");
  return node.outerHTML;
};

const renderTopNav = (view: CinemaView) => `
  <header class="cinema-top-nav">
    <button class="cinema-brand" type="button" data-cinema-action="library" aria-label="Cinema library">
      <span class="cinema-brand-mark">
        <svg viewBox="0 0 44 44" aria-hidden="true" focusable="false">
          <path class="cinema-brand-orbit" d="M7 26 C10 11 28 5 37 15 C46 25 31 42 16 36 C5 32 6 18 18 9" />
          <path class="cinema-brand-glyph" d="M13 31 V13 L31 31 V13" />
          <circle cx="35" cy="10" r="2.4" />
        </svg>
      </span>
      <span>
        <strong>Nebula Cinema</strong>
      </span>
    </button>
    <nav class="cinema-nav-tabs" aria-label="Cinema sections">
      <button class="${view === "library" || view === "title-detail" || view === "player" ? "active" : ""}" type="button" data-cinema-action="library"${view === "library" || view === "title-detail" || view === "player" ? ' aria-current="page"' : ""}>Library</button>
      <button class="${view === "watchlist" ? "active" : ""}" type="button" data-cinema-action="watchlist"${view === "watchlist" ? ' aria-current="page"' : ""}>Watchlist</button>
      <button class="${view === "identify" ? "active" : ""}" type="button" data-cinema-action="identify-nav"${view === "identify" ? ' aria-current="page"' : ""}>Identify</button>
      <button class="${view === "servers" ? "active" : ""}" type="button" data-cinema-action="servers"${view === "servers" ? ' aria-current="page"' : ""}>Servers</button>
    </nav>
    <label class="cinema-global-search">
      <span>${renderCinemaIcon("Search")} Search</span>
      <input type="search" data-cinema-search placeholder="Search library" />
    </label>
    <div class="cinema-dashboard-actions">
      <button class="cinema-dashboard-command" type="button" data-cinema-action="home">
        ${renderCinemaIcon("ArrowLeft")} Dashboard
      </button>
      <button class="cinema-mobile-more" type="button" data-cinema-action="more" aria-label="Title options">${renderCinemaIcon("MoreHorizontal")}</button>
    </div>
  </header>
`;

const renderServerCard = (server: CinemaServerInfo, compact = false) => `
  <button class="cinema-server-card ${compact ? "compact" : ""}" type="button" data-cinema-action="servers">
    <span class="cinema-server-icon">${renderCinemaIcon("Server")}</span>
    <span class="cinema-status-dot ${server.online ? "online" : "offline"}"></span>
    <span>
      <small>${server.online ? "Server Online" : "Server Offline"}</small>
      <strong>${escapeHtml(server.name)}</strong>
    </span>
    <span>
      <small>${escapeHtml(server.mode)}</small>
      <strong>${escapeHtml(server.address)}</strong>
    </span>
    <span class="cinema-signal-icon">${renderCinemaIcon("SignalHigh")}</span>
    ${renderCinemaIcon("ChevronRight", "cinema-chevron-icon")}
  </button>
`;

const renderPlaybackSettings = (_entry: CinemaEntry, subtitles?: SubtitleTracksResponse, preference?: SubtitlePreference) => `
  <section class="cinema-playback-settings" aria-label="Playback settings">
    <button type="button"><span>${renderCinemaIcon("BadgeCheck")} Quality</span><strong>Auto · Select in player</strong>${renderCinemaIcon("ChevronRight", "cinema-chevron-icon")}</button>
    <button type="button"><span>${renderCinemaIcon("Languages")} Audio</span><strong>English (Source)</strong>${renderCinemaIcon("ChevronRight", "cinema-chevron-icon")}</button>
    <label class="cinema-subtitle-setting"><span>${renderCinemaIcon("Captions")} Subtitles</span><select data-cinema-subtitle-select aria-label="Subtitle track"><option value="">Off</option>${subtitles?.tracks.map((track) => `<option value="${escapeHtml(track.id)}"${track.id === subtitles.selectedSubtitleId ? " selected" : ""}>${escapeHtml(track.label || track.language || "Unknown")} · ${escapeHtml(track.format)}</option>`).join("") ?? ""}</select></label>
  </section>
  <form class="cinema-subtitle-preferences" data-cinema-subtitle-preferences>
    <strong>Subtitle defaults</strong>
    <label>Mode <select name="mode"><option value="off"${preference?.mode === "off" ? " selected" : ""}>Off</option><option value="forced-only"${preference?.mode === "forced-only" ? " selected" : ""}>Forced only</option><option value="preferred"${preference?.mode === "preferred" ? " selected" : ""}>Preferred languages</option></select></label>
    <label>Languages in priority order <input name="languages" value="${escapeHtml(preference?.languages.join(", ") ?? "")}" placeholder="en, es, fr" /></label>
    <button type="submit"${preference && !preference.persistent ? " disabled" : ""}>${preference && !preference.persistent ? "Guest choices are session-only" : "Save defaults"}</button>
  </form>
`;

const renderWatchlistButton = (entry: CinemaEntry) => `
  <button class="${entry.watchlisted ? "active" : ""}" type="button" data-cinema-action="queue" data-cinema-watchlist-path="${escapeHtml(entry.path)}">
    ${renderCinemaIcon(entry.watchlisted ? "Check" : "Plus")}
    ${entry.watchlisted ? "In Watchlist" : "Add to Watchlist"}
  </button>
`;

const renderPlaybackControls = (entry: CinemaEntry, server: CinemaServerInfo, playback?: ContinueWatchingEntry, chapters: MediaChapter[] = []) => `
  <div class="cinema-player-overlay">
    <div class="cinema-preview-badges">
      <span><i class="cinema-status-dot ${server.online ? "online" : "offline"}"></i>${escapeHtml(server.mode)}</span>
      <span class="cinema-quality-badge">Original</span>
    </div>
    <button class="cinema-play-orb" type="button" data-cinema-action="play" aria-label="Play">${renderCinemaIcon("Play", "cinema-play-icon")}</button>
    <div class="cinema-preview-transport" aria-hidden="true">
      <span>${renderCinemaIcon("Play")} ${playback ? formatTime(playback.positionSeconds) : "0:00"}</span>
      <div class="cinema-preview-timeline">
        <i style="width: ${Math.round((playback?.progress ?? 0) * 100)}%"></i>
        ${chapters.map((chapter, index) => `<b title="${escapeHtml(chapter.title)}" style="--chapter-position: ${(index / Math.max(1, chapters.length - 1)) * 100}%"></b>`).join("")}
      </div>
      <span>${estimateRuntime(entry)}</span>
    </div>
  </div>
`;

const renderCinemaCards = (entries: CinemaEntry[], category: CinemaCategory, playback: Map<string, ContinueWatchingEntry> = new Map()) => {
  if (entries.length === 0) {
    return `
      <div class="cinema-empty">
        <strong>No ${categoryLabel(category).toLowerCase()} found</strong>
        <span>${escapeHtml(categories.find((candidate) => candidate.id === category)?.empty ?? "")}</span>
      </div>
    `;
  }

  return entries
    .map(
      (entry) => {
        const state = entry.id ? playback.get(entry.id) : undefined;
        return `
        <button class="cinema-card" type="button" data-cinema-path="${escapeHtml(entry.path)}">
          <span class="cinema-poster" data-cinema-poster="${escapeHtml(entry.path)}"${posterStyle(entry)}>
            ${entry.posterUrl ? "" : renderPosterFallback(entry)}
            <span class="cinema-poster-scrim"></span>
            <span class="cinema-card-badge">${escapeHtml(entry.category === "tv" ? "Series" : "Movie")}</span>
            <span class="cinema-card-play">${renderCinemaIcon("Play", "cinema-play-icon")}</span>
            ${state ? `<span class="cinema-card-progress"><i style="width:${Math.round(state.progress * 100)}%"></i></span>` : ""}
          </span>
          <span class="cinema-card-copy">
            <strong>${escapeHtml(displayTitle(entry))}</strong>
            <small>${escapeHtml([entry.releaseYear, entry.genres[0] || entry.folder || "Local media"].filter(Boolean).join(" · "))}</small>
          </span>
        </button>
      `;
      }
    )
    .join("");
};

const renderChapterStrip = (entry: CinemaEntry, chapters: MediaChapter[]) => chapters.length > 0 ? `
  <section class="cinema-chapter-strip" aria-label="Chapters">
    <header>
      <strong>Chapters</strong>
      <button type="button" data-cinema-action="view-chapters">View All Chapters</button>
    </header>
    <div class="cinema-chapter-cards">
      ${renderChapterCards(entry, chapters, "rail")}
    </div>
  </section>
` : `<section class="cinema-catalog-note"><strong>Chapters pending</strong><span>Embedded chapters will appear after this source is probed.</span></section>`;

const renderChapterCards = (entry: CinemaEntry, chapters: MediaChapter[], mode: "rail" | "expanded") =>
  chapters
    .map(
      (chapter, index) => `
        <button class="${index === 0 ? "active" : ""}" type="button" data-cinema-action="chapter" data-cinema-chapter-time="${chapter.startSeconds}">
          <span class="cinema-chapter-thumb" data-cinema-backdrop="${escapeHtml(entry.path)}" data-cinema-frame-time="${chapter.startSeconds}"${posterStyle(entry)}>${entry.posterUrl ? "" : renderPosterFallback(entry)}</span>
          <strong>${index + 1}. ${escapeHtml(chapter.title || `Chapter ${index + 1}`)}</strong>
          <small>${formatTime(chapter.startSeconds)}${mode === "expanded" ? " / Embedded chapter" : ""}</small>
        </button>
      `
    )
    .join("");

const queueEntries = (entries: CinemaEntry[], selected: CinemaEntry | null) => {
  const watchlistedQueue = entries.filter((entry) => entry.watchlisted && entry.path !== selected?.path);
  return (watchlistedQueue.length > 0 ? watchlistedQueue : entries.filter((entry) => entry.path !== selected?.path)).slice(0, 8);
};

const renderNextUpQueue = (entries: CinemaEntry[], selected: CinemaEntry | null) => {
  const queue = queueEntries(entries, selected);

  return `
    <section class="cinema-next-up">
      <header>
        <strong>Next Up</strong>
        <button type="button" data-cinema-action="view-queue">View Queue</button>
      </header>
      <div>
        ${
          queue.length > 0
            ? queue
                .map(
                  (entry) => `
                    <button type="button" data-cinema-path="${escapeHtml(entry.path)}">
                      <span class="cinema-next-thumb" data-cinema-backdrop="${escapeHtml(entry.path)}"${posterStyle(entry)}>${entry.posterUrl ? "" : renderPosterFallback(entry)}</span>
                      <span>
                        <small>${escapeHtml(entry.category === "tv" ? "S1 / E2" : categoryLabel(entry.category))}</small>
                        <strong>${escapeHtml(entry.title)}</strong>
                        <small>22:06</small>
                      </span>
                    </button>
                  `
                )
                .join("")
            : `<p>No queued titles yet.</p>`
        }
      </div>
    </section>
  `;
};

const renderQueueCards = (entries: CinemaEntry[]) =>
  entries
    .map(
      (entry) => `
        <button type="button" data-cinema-path="${escapeHtml(entry.path)}">
          <span class="cinema-next-thumb" data-cinema-backdrop="${escapeHtml(entry.path)}"${posterStyle(entry)}>${entry.posterUrl ? "" : renderPosterFallback(entry)}</span>
          <span>
            <small>${escapeHtml(categoryLabel(entry.category))}</small>
            <strong>${escapeHtml(entry.title)}</strong>
            <small>${metadataLine(entry) || "Ready to play"}</small>
          </span>
        </button>
      `
    )
    .join("");

const renderContinueWatching = (entries: CinemaEntry[], playback: Map<string, ContinueWatchingEntry>) => {
  const continuing = [...playback.values()].map((state) => entries.find((entry) => entry.id === state.itemId)).filter((entry): entry is CinemaEntry => Boolean(entry));
  return continuing.length ? `<section class="cinema-continue"><header><div><p class="eyebrow">For You</p><h3>Continue Watching</h3></div><span>${continuing.length} in progress</span></header><div class="cinema-grid">${renderCinemaCards(continuing, "movies", playback)}</div></section>` : "";
};

const renderLibrary = (entries: CinemaEntry[], activeCategory: CinemaCategory, query: string, selected: CinemaEntry | null, playback: Map<string, ContinueWatchingEntry>, catalogMessage: string) => {
  const categoryEntries = entries.filter((entry) => entry.category === activeCategory);
  const visibleEntries = query
    ? categoryEntries.filter((entry) =>
        `${entry.title} ${entry.name} ${entry.folder} ${entry.genres.join(" ")} ${entry.cast}`.toLowerCase().includes(query.toLowerCase())
      )
    : categoryEntries;

  return `
    <main class="cinema-library browsing" data-cinema-view="library">
      ${!query ? renderContinueWatching(entries, playback) : ""}
      <div class="cinema-catalog-status">${renderCinemaIcon(catalogMessage.includes("fallback") ? "HardDrive" : "RefreshCw")}<span>${escapeHtml(catalogMessage)}</span><button type="button" data-cinema-action="scan-catalog">Scan library</button></div>
      <section class="cinema-library-row">
        <header>
          <div class="cinema-library-heading">
            <p class="eyebrow">Library</p>
            <h3>${escapeHtml(categoryLabel(activeCategory))}</h3>
            <span>${visibleEntries.length} ${visibleEntries.length === 1 ? "title" : "titles"}</span>
          </div>
          <div class="cinema-library-tools">
            <nav class="cinema-category-segments" aria-label="Media categories">
              ${categories
                .map(
                  (category) => `
                    <button class="${category.id === activeCategory ? "active" : ""}" type="button" data-cinema-category="${category.id}">
                      ${category.label}
                      <span>${entries.filter((entry) => entry.category === category.id).length}</span>
                    </button>
                  `
                )
                .join("")}
            </nav>
          </div>
        </header>
        <div class="cinema-grid" data-cinema-grid>${renderCinemaCards(visibleEntries, activeCategory, playback)}</div>
      </section>
    </main>
  `;
};

const renderWatchlistView = (entries: CinemaEntry[], query: string) => {
  const watchlistedEntries = entries.filter((entry) => entry.watchlisted);
  const visibleEntries = query
    ? watchlistedEntries.filter((entry) =>
        `${entry.title} ${entry.name} ${entry.folder} ${entry.genres.join(" ")} ${entry.cast}`.toLowerCase().includes(query.toLowerCase())
      )
    : watchlistedEntries;

  return `
    <main class="cinema-watchlist-view browsing" data-cinema-view="watchlist">
      <section class="cinema-library-row">
        <header>
          <div>
            <p class="eyebrow">Saved</p>
            <h3>Watchlist</h3>
          </div>
          <span>${visibleEntries.length} titles</span>
        </header>
        <div class="cinema-grid" data-cinema-grid>
          ${
            visibleEntries.length > 0
              ? renderCinemaCards(visibleEntries, "movies")
              : `
                <div class="cinema-empty">
                  <strong>Your watchlist is empty</strong>
                  <span>Add movies or shows from Library.</span>
                </div>
              `
          }
        </div>
      </section>
    </main>
  `;
};

const renderTitleHero = (entry: CinemaEntry, entries: CinemaEntry[], playback: ContinueWatchingEntry | undefined, catalog: CinemaCatalogState | undefined, subtitles?: SubtitleTracksResponse, preference?: SubtitlePreference, canOptimize = false) => `
  <main class="cinema-title-detail" data-cinema-view="title-detail">
    <section class="cinema-player-layout">
      <div class="cinema-player-frame" data-cinema-backdrop="${escapeHtml(entry.path)}"${backdropStyle(entry)}>
        ${renderPlaybackControls(entry, currentServerInfo(), playback, catalog?.chapters)}
      </div>
      <aside class="cinema-title-panel">
        <button class="cinema-back-command" type="button" data-cinema-action="library">${renderCinemaIcon("ArrowLeft")} Back to Library</button>
        <p class="eyebrow">${escapeHtml(entry.episode?.seriesTitle || categoryLabel(entry.category))}</p>
        <h2>${escapeHtml(entry.title)}</h2>
        ${entry.tagline ? `<p class="cinema-tagline">${escapeHtml(entry.tagline)}</p>` : ""}
        <p class="cinema-title-meta">${escapeHtml(metadataLine(entry) || `${entry.folder || "Content"} / ${formatSize(entry.size)}`)}</p>
        <p>${escapeHtml(entry.summary || "No synopsis has been added for this title yet.")}</p>
        <div class="cinema-actions">
          <button type="button" data-cinema-action="play">${renderCinemaIcon("Play")} ${playback ? `Resume at ${formatTime(playback.positionSeconds)}` : "Play"}</button>
          ${entry.id && entry.sourceId ? `<button type="button" data-cinema-action="played">${renderCinemaIcon("BadgeCheck")} Mark watched</button><button type="button" data-cinema-action="unplayed">Mark unwatched</button>` : ""}
          ${renderWatchlistButton(entry)}
          ${entry.id ? `<button type="button" data-cinema-action="save-playlist">${renderCinemaIcon("ListPlus")} Save to playlist</button>` : ""}
          <button type="button" data-cinema-action="more">${renderCinemaIcon("MoreHorizontal")} More</button>
          ${canOptimize && entry.id && entry.sourceId ? `<button type="button" data-cinema-action="optimize">${renderCinemaIcon("Gauge")} Optimize</button>` : ""}
        </div>
        <button class="cinema-edit-command" type="button" data-cinema-action="edit">${renderCinemaIcon("Pencil")} Edit Details</button>
        <button class="cinema-edit-command" type="button" data-cinema-action="tmdb">${renderCinemaIcon("Database")} Match with TMDB</button>
        ${entry.tmdbId ? `<button class="cinema-edit-command" type="button" data-cinema-action="tmdb-refresh">${renderCinemaIcon("RefreshCw")} Refresh TMDB Metadata</button>` : ""}
        ${renderServerCard(currentServerInfo(), true)}
        ${renderPlaybackSettings(entry, subtitles, preference)}
        <div class="cinema-meta-list">
          <span>Type <strong>Video</strong></span>
          ${entry.episode ? `<span>Episode <strong>S${entry.episode.seasonNumber} E${entry.episode.episodeNumber}</strong></span><span>Air date <strong>${escapeHtml(entry.episode.airDate || "Not set")}</strong></span>` : ""}
          <span>Year <strong>${escapeHtml(entry.releaseYear || "Not set")}</strong></span>
          <span>Rating <strong>${escapeHtml(entry.rating || "Not set")}</strong></span>
          <span>Genres <strong>${escapeHtml(entry.genres.join(", ") || "Not set")}</strong></span>
          <span>Studio <strong>${escapeHtml(entry.studio || "Not set")}</strong></span>
          <span>File <strong>${escapeHtml(entry.name)}</strong></span>
          <span>Metadata <strong>${entry.tmdbId ? `TMDB ${escapeHtml(entry.tmdbMediaType)} #${entry.tmdbId}` : "Local"}</strong></span>
          <span>Catalog <strong>${entry.id && entry.sourceId ? "Stable ID" : "Path fallback"}</strong></span>
          <span>Enrichment <strong>${escapeHtml(catalog?.probeState || (entry.posterUrl || entry.tmdbId ? "Metadata ready" : "Local fallback"))}</strong></span>
        </div>
      </aside>
    </section>
    <section class="cinema-detail-lower">
      ${renderChapterStrip(entry, catalog?.chapters ?? [])}
      ${renderNextUpQueue(entries, entry)}
    </section>
  </main>
`;

const renderVideoPlayerView = (entry: CinemaEntry, subtitles: SubtitleTracksResponse | undefined, quality: PlaybackQualityPreference, profiles: RenditionProfile[]) => `
  <main class="cinema-watch-surface" data-cinema-view="player">
    <header class="cinema-player-header">
      <button type="button" data-cinema-action="back-title">${renderCinemaIcon("ArrowLeft")} Details</button>
      <div>
        <p class="eyebrow">Now Playing</p>
        <h2>${escapeHtml(entry.title)}</h2>
      </div>
      <label class="cinema-player-quality">Quality
        <select data-cinema-player-quality aria-label="Playback quality">
          <option value="auto"${quality.mode === "auto" ? " selected" : ""}>Auto</option>
          <option value="original"${quality.mode === "original" ? " selected" : ""}>Original</option>
          ${profiles.map((profile) => `<option value="${profile.id}"${quality.mode === "profile" && quality.profileId === profile.id ? " selected" : ""}>${escapeHtml(profile.label)} · ${Math.round(profile.totalBitrate / 1_000_000)} Mbps</option>`).join("")}
        </select>
        <span data-cinema-quality-result>${escapeHtml(qualityResultLabel(quality))}</span>
      </label>
      <button type="button" data-cinema-action="player-fullscreen">Fullscreen</button>
    </header>
    <section class="cinema-video-stage">
      <video class="cinema-player" data-cinema-player controls autoplay playsinline preload="metadata" crossorigin="anonymous"></video>
      <div class="cinema-player-overlay">
        <button class="cinema-play-orb" type="button" data-cinema-action="play" aria-label="Play">${renderCinemaIcon("Play")}</button>
      </div>
      <label class="cinema-player-subtitles">Subtitles <select data-cinema-player-subtitle><option value="">Off</option>${subtitles?.tracks.map((track) => `<option value="${escapeHtml(track.id)}"${track.id === subtitles.selectedSubtitleId ? " selected" : ""}>${escapeHtml(track.label || track.language || "Unknown")}</option>`).join("") ?? ""}</select></label>
      <div class="cinema-player-statusbar">
        <span><i class="cinema-status-dot ${currentServerInfo().online ? "online" : "offline"}"></i>${currentServerInfo().online ? "Server Online" : "Server Offline"}</span>
        <span data-cinema-player-status>Connecting to ${escapeHtml(currentServerInfo().name)}…</span>
      </div>
    </section>
  </main>
`;

const renderPlayerView = (entry: CinemaEntry, _entries: CinemaEntry[], subtitles: SubtitleTracksResponse | undefined, quality: PlaybackQualityPreference, profiles: RenditionProfile[]) => renderVideoPlayerView(entry, subtitles, quality, profiles);

const renderServersView = () => {
  const server = currentServerInfo();

  return `
    <main class="cinema-servers" data-cinema-view="servers">
      <section>
        <p class="eyebrow">Server</p>
        <h2>${server.online ? "Connected" : "Needs Connection"}</h2>
        <p>${escapeHtml(server.address)}</p>
        ${renderServerCard(server)}
      </section>
      <div class="cinema-server-grid">
        <span>Mode <strong>${escapeHtml(server.mode)}</strong></span>
        <span>Authentication <strong>${escapeHtml(server.authState)}</strong></span>
        <span>Playback <strong>Auto / 480p / 720p / 1080p</strong></span>
        <span>Throughput <strong>Local network</strong></span>
      </div>
    </main>
  `;
};

const renderIdentifyView = (selected: CinemaEntry | null) => `
  <main class="cinema-identify-workspace" data-cinema-view="identify">
    <section>
      <p class="eyebrow">Identify</p>
      <h2>${escapeHtml(selected?.title ?? "Visual Identification")}</h2>
      <p>${selected?.mediaKind === "video" ? "Sample frames and search for title evidence." : "Open a video title to run visual identification."}</p>
      <div class="cinema-actions">
        <button type="button" data-cinema-action="run-identify" ${selected?.mediaKind === "video" ? "" : "disabled"}>Identify Title</button>
        <button type="button" data-cinema-action="library">Library</button>
      </div>
    </section>
    <section class="cinema-identify" data-cinema-identify>
      <div class="cinema-empty">
        <strong>Waiting for frames</strong>
        <span>Select a video and start identification.</span>
      </div>
    </section>
  </main>
`;

const renderEditForm = (entry: CinemaEntry) => `
  <section class="cinema-editor-sheet" data-cinema-editor>
    <form class="cinema-editor-dialog" data-cinema-editor-form>
      <header>
        <div>
          <p class="eyebrow">Edit Details</p>
          <h3>${escapeHtml(entry.title)}</h3>
        </div>
        <button type="button" data-cinema-action="close-editor" aria-label="Close editor">×</button>
      </header>
      <div class="cinema-editor-groups">
        <fieldset>
          <legend>Overview</legend>
          <label>Title <input name="title" value="${escapeHtml(entry.title)}" /></label>
          <label>Sort Title <input name="sortTitle" value="${escapeHtml(entry.sortTitle || entry.title)}" /></label>
          <label>Year <input name="releaseYear" value="${escapeHtml(entry.releaseYear)}" /></label>
          <label>Rating <input name="rating" value="${escapeHtml(entry.rating)}" /></label>
          <label class="wide">Summary <textarea name="summary">${escapeHtml(entry.summary)}</textarea></label>
        </fieldset>
        <fieldset>
          <legend>Artwork And Credits</legend>
          <label>Genres <input name="genres" value="${escapeHtml(entry.genres.join(", "))}" /></label>
          <label>Studio <input name="studio" value="${escapeHtml(entry.studio)}" /></label>
          <label>Collection <input name="collection" value="${escapeHtml(entry.collection)}" /></label>
          <label>Poster URL <input name="posterUrl" value="${escapeHtml(entry.posterUrl)}" /></label>
          <label class="wide">Tagline <input name="tagline" value="${escapeHtml(entry.tagline)}" /></label>
          <label class="wide">Cast <input name="cast" value="${escapeHtml(entry.cast)}" /></label>
        </fieldset>
      </div>
      <footer>
        <span data-cinema-editor-status>Source: ${escapeHtml(entry.path)}</span>
        <button type="button" data-cinema-action="close-editor">Cancel</button>
        <button type="submit">Save Details</button>
      </footer>
    </form>
  </section>
`;

const renderCinemaSheet = (title: string, eyebrow: string, body: string) => `
  <section class="cinema-editor-sheet cinema-expanded-sheet" data-cinema-expanded-sheet>
    <div class="cinema-expanded-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <header>
        <div>
          <p class="eyebrow">${escapeHtml(eyebrow)}</p>
          <h3>${escapeHtml(title)}</h3>
        </div>
        <button type="button" data-cinema-action="close-sheet" aria-label="Close">${renderCinemaIcon("X")}</button>
      </header>
      ${body}
    </div>
  </section>
`;

const renderResumeSheet = (entry: CinemaEntry, resume: ContinueWatchingEntry) => {
  const progress = Math.max(0, Math.min(100, Math.round(resume.progress * 100)));
  const position = formatTime(resume.positionSeconds);

  return `
    <section class="cinema-editor-sheet cinema-resume-sheet" data-cinema-resume-sheet>
      <div class="cinema-resume-dialog" role="dialog" aria-modal="true" aria-labelledby="cinema-resume-title" aria-describedby="cinema-resume-description">
        <button class="cinema-resume-close" type="button" data-cinema-action="close-resume" aria-label="Close resume dialog">${renderCinemaIcon("X")}</button>
        <span class="cinema-resume-mark">${renderCinemaIcon("History")}</span>
        <div class="cinema-resume-copy">
          <p class="eyebrow">Continue Watching</p>
          <h3 id="cinema-resume-title">Resume ${escapeHtml(displayTitle(entry))}?</h3>
          <p id="cinema-resume-description">Pick up where you left off at <strong>${position}</strong>, or start again from the beginning.</p>
        </div>
        <div class="cinema-resume-progress" role="progressbar" aria-label="${progress}% watched" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
          <i style="width: ${progress}%"></i>
        </div>
        <div class="cinema-resume-meta">
          <span>${position} watched</span>
          <span>${progress}% complete</span>
        </div>
        <div class="cinema-resume-actions">
          <button class="primary" type="button" data-cinema-action="resume-play" autofocus>${renderCinemaIcon("Play")} Resume at ${position}</button>
          <button type="button" data-cinema-action="restart-play">${renderCinemaIcon("RotateCcw")} Start over</button>
        </div>
      </div>
    </section>
  `;
};

const renderTmdbSheet = (entry: CinemaEntry, status: CinemaTmdbStatusResponse | null, candidates: CinemaTmdbCandidate[] = [], message = "") =>
  renderCinemaSheet("Match with TMDB", entry.episode?.seriesTitle || entry.title, renderTmdbPanel(entry, status, candidates, message));

const renderMoreSheet = (entry: CinemaEntry) =>
  renderCinemaSheet(
    "Title Options",
    entry.title,
    `
      <div class="cinema-more-actions">
        <button type="button" data-cinema-action="edit">${renderCinemaIcon("Pencil")} Edit Details</button>
        <button type="button" data-cinema-action="view-chapters">${renderCinemaIcon("ListVideo")} View Chapters</button>
        <button type="button" data-cinema-action="view-queue">${renderCinemaIcon("ListOrdered")} View Queue</button>
        <button type="button" data-cinema-action="identify-nav">${renderCinemaIcon("ScanSearch")} Identify Title</button>
        <button type="button" data-cinema-action="tmdb">${renderCinemaIcon("Database")} Match with TMDB</button>
      </div>
      <div class="cinema-expanded-meta">
        <span>File <strong>${escapeHtml(entry.name)}</strong></span>
        <span>Source <strong>${escapeHtml(entry.folder || "Content root")}</strong></span>
        <span>Size <strong>${formatSize(entry.size)}</strong></span>
        <span>Modified <strong>${new Date(entry.modifiedAt).toLocaleDateString()}</strong></span>
      </div>
    `
  );

const renditionStateLabel = (rendition: MediaRendition | undefined) => rendition
  ? `${rendition.state}${rendition.retention === "pinned" ? " · pinned" : ""}`
  : "Not generated";

const renderOptimizeSheet = (entry: CinemaEntry, profiles: RenditionProfile[], renditions: MediaRendition[], message = "") =>
  renderCinemaSheet("Optimize for Devices", entry.title, `
    <form class="cinema-optimize" data-cinema-optimize-form>
      <p>Create reusable lower-quality versions ahead of playback. Existing versions are reused automatically.</p>
      ${message ? `<p class="cinema-optimize-status" role="status">${escapeHtml(message)}</p>` : ""}
      <div class="cinema-optimize-profiles">
        ${profiles.map((profile) => {
          const rendition = renditions.find((entry) => entry.profileId === profile.id);
          return `<article>
            <label><input type="checkbox" name="profileId" value="${profile.id}"${rendition?.state === "ready" ? " disabled" : ""}> <strong>${escapeHtml(profile.label)}</strong></label>
            <span>${escapeHtml(renditionStateLabel(rendition))} · ${Math.round(profile.totalBitrate / 1_000_000)} Mbps</span>
            ${rendition ? `<div>
              <button type="button" data-cinema-rendition-retention="${rendition.id}" data-retention="${rendition.retention === "pinned" ? "cache" : "pinned"}">${rendition.retention === "pinned" ? "Unpin" : "Pin"}</button>
              <button type="button" data-cinema-rendition-remove="${rendition.id}">Remove</button>
            </div>` : ""}
          </article>`;
        }).join("")}
      </div>
      <label><input type="checkbox" name="pinned"> Keep selected versions pinned</label>
      <footer><button type="button" data-cinema-action="close-sheet">Close</button><button type="submit">Build selected</button></footer>
    </form>
  `);

const renderChaptersSheet = (entry: CinemaEntry, chapters: MediaChapter[]) =>
  renderCinemaSheet(
    "All Chapters",
    entry.title,
    chapters.length ? `<div class="cinema-expanded-chapters">${renderChapterCards(entry, chapters, "expanded")}</div>` : `<div class="cinema-empty"><strong>No embedded chapters</strong><span>Chapter data is not available for this source yet.</span></div>`
  );

const renderQueueSheet = (entries: CinemaEntry[], selected: CinemaEntry | null) => {
  const queue = queueEntries(entries, selected);

  return renderCinemaSheet(
    "View Queue",
    selected?.title ?? "Up Next",
    queue.length > 0
      ? `<div class="cinema-expanded-queue">${renderQueueCards(queue)}</div>`
      : `
        <div class="cinema-empty">
          <strong>No queued titles</strong>
          <span>Add titles to the watchlist or import more media.</span>
        </div>
      `
  );
};

const renderIdentificationResult = (frames: CinemaIdentificationFrame[], result: CinemaIdentifyResponse) => {
  const provider = result.providers[0];
  const configured = provider?.configured ?? false;
  const pages = provider?.results.flatMap((entry) => entry.pages ?? []).filter((page) => page.url) ?? [];
  const entities = provider?.results.flatMap((entry) => entry.webEntities ?? []) ?? [];

  return `
    <div class="cinema-identify-header">
      <div>
        <p class="eyebrow">Visual Search</p>
        <h4>${configured ? "Online evidence" : "Search kit ready"}</h4>
      </div>
      <span>${frames.length} frames</span>
    </div>
    <div class="cinema-frame-strip">
      ${frames
        .map(
          (frame) => `
            <figure>
              <img src="${frame.image}" alt="Sample frame at ${formatTime(frame.time)}" />
              <figcaption>${formatTime(frame.time)}</figcaption>
            </figure>
          `
        )
        .join("")}
    </div>
    ${
      result.candidates.length > 0
        ? `<div class="cinema-evidence-list"><strong>Candidate entities</strong>${result.candidates
            .map((candidate) => `<span>${escapeHtml(candidate.name)} / ${candidate.score.toFixed(2)}</span>`)
            .join("")}</div>`
        : ""
    }
    ${
      entities.length > 0
        ? `<div class="cinema-evidence-list"><strong>Frame evidence</strong>${entities
            .slice(0, 8)
            .map((entity) => `<span>${escapeHtml(entity.description)} / ${entity.score.toFixed(2)}</span>`)
            .join("")}</div>`
        : ""
    }
    <div class="cinema-evidence-list">
      <strong>${pages.length > 0 ? "Matching pages" : configured ? "No matching pages found" : "Manual searches"}</strong>
      ${
        pages.length > 0
          ? pages.slice(0, 6).map((page) => `<a href="${escapeHtml(page.url)}" target="_blank" rel="noreferrer">${escapeHtml(page.title)}</a>`).join("")
          : result.frameQueries.slice(0, 6).map((query) => `<a href="${searchUrl(query)}" target="_blank" rel="noreferrer">${escapeHtml(query)}</a>`).join("")
      }
    </div>
  `;
};

export const renderCinemaView = () => `
  <section class="cinema-shell" data-cinema-app>
    <div data-cinema-top-nav></div>
    <section class="cinema-content" data-cinema-content>
      <div class="cinema-empty">
        <strong>Loading library</strong>
        <span>Scanning content for playable media.</span>
      </div>
    </section>
    <section data-cinema-editor-host hidden></section>
    <div class="cinema-wave" aria-hidden="true">
      <svg viewBox="0 0 1600 160" preserveAspectRatio="none">
        <path class="cinema-wave-line primary" d="M -640 88 C -560 50 -480 50 -400 88 C -320 126 -240 126 -160 88 C -80 50 0 50 80 88 C 160 126 240 126 320 88 C 400 50 480 50 560 88 C 640 126 720 126 800 88 C 880 50 960 50 1040 88 C 1120 126 1200 126 1280 88 C 1360 50 1440 50 1520 88 C 1600 126 1680 126 1760 88 C 1840 50 1920 50 2000 88 C 2080 126 2160 126 2240 88" />
        <path class="cinema-wave-line secondary" d="M -640 88 C -560 50 -480 50 -400 88 C -320 126 -240 126 -160 88 C -80 50 0 50 80 88 C 160 126 240 126 320 88 C 400 50 480 50 560 88 C 640 126 720 126 800 88 C 880 50 960 50 1040 88 C 1120 126 1200 126 1280 88 C 1360 50 1440 50 1520 88 C 1600 126 1680 126 1760 88 C 1840 50 1920 50 2000 88 C 2080 126 2160 126 2240 88" />
        <path class="cinema-wave-line tertiary" d="M -640 88 C -560 50 -480 50 -400 88 C -320 126 -240 126 -160 88 C -80 50 0 50 80 88 C 160 126 240 126 320 88 C 400 50 480 50 560 88 C 640 126 720 126 800 88 C 880 50 960 50 1040 88 C 1120 126 1200 126 1280 88 C 1360 50 1440 50 1520 88 C 1600 126 1680 126 1760 88 C 1840 50 1920 50 2000 88 C 2080 126 2160 126 2240 88" />
      </svg>
    </div>
    <footer class="cinema-footer-status" data-cinema-footer></footer>
  </section>
`;

export const bindCinemaView = (container: ParentNode, onHome?: () => void, options: { canManageRenditions?: boolean; personalPlayback?: boolean } = {}) => {
  const app = container.querySelector<HTMLElement>("[data-cinema-app]");
  const topNav = container.querySelector<HTMLElement>("[data-cinema-top-nav]");
  const content = container.querySelector<HTMLElement>("[data-cinema-content]");
  const editorHost = container.querySelector<HTMLElement>("[data-cinema-editor-host]");
  const footer = container.querySelector<HTMLElement>("[data-cinema-footer]");

  if (!app || !topNav || !content || !editorHost || !footer) {
    return;
  }

  let entries: CinemaEntry[] = [];
  let activeCategory: CinemaCategory = "movies";
  let selected: CinemaEntry | null = null;
  const subtitleState = new Map<string, SubtitleTracksResponse>();
  let subtitlePreference: SubtitlePreference | undefined;
  let view: CinemaView = "library";
  let query = "";
  let isScanning = false;
  let catalogMessage = "Loading catalog…";
  let playback = new Map<string, ContinueWatchingEntry>();
  const catalogState = new Map<string, CinemaCatalogState>();
  let stopActivePlayback: (() => void) | null = null;
  let deliveryGeneration = 0;
  let playlists: MediaList[] = [];
  let collections: MediaList[] = [];
  let pendingPlayback: PendingCinemaPlayback | null = null;
  let qualityPreference: PlaybackQualityPreference = { mode: "auto" };
  let renditionProfiles = fallbackRenditionProfiles;

  const deliveryCapabilities = (player: HTMLVideoElement) => {
    const mp4 = Boolean(player.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'));
    const hls = supportsHlsPlayback(player);
    const storageKey = "nebula.cinema.deviceId";
    let deviceId = window.localStorage.getItem(storageKey);
    if (!deviceId) { deviceId = crypto.randomUUID(); window.localStorage.setItem(storageKey, deviceId); }
    return {
      audioCodecs: mp4 ? ["aac"] : [], containers: mp4 ? ["mp4"] : [], deviceId,
      maxAudioChannels: null, maxBitrate: null, maxHeight: null, maxWidth: null,
      subtitleFormats: [], supportsHls: hls, videoCodecs: mp4 ? ["h264"] : []
    };
  };

  const currentVisibleEntries = () =>
    entries
      .filter((entry) => entry.category === activeCategory)
      .filter((entry) =>
        query
          ? `${entry.title} ${entry.name} ${entry.folder} ${entry.genres.join(" ")} ${entry.cast}`.toLowerCase().includes(query.toLowerCase())
          : true
      );

  const currentWatchlistEntries = () =>
    entries
      .filter((entry) => entry.watchlisted)
      .filter((entry) =>
        query
          ? `${entry.title} ${entry.name} ${entry.folder} ${entry.genres.join(" ")} ${entry.cast}`.toLowerCase().includes(query.toLowerCase())
          : true
      );

  const thumbnailCache = new Map<string, Promise<string | null>>();

  const captureVideoThumbnail = (entry: CinemaEntry, time: number, width: number, height: number) => {
    const cacheKey = `${entry.path}:${Math.round(time * 10) / 10}:${width}x${height}`;
    const cached = thumbnailCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const thumbnail = (async () => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.src = entry.streamUrl;

      try {
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("loadedmetadata", () => resolve(), { once: true });
          video.addEventListener("error", () => reject(new Error("Poster metadata failed.")), { once: true });
        });

        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 6;
        const seekTime = time >= 0 ? time : Math.min(12, Math.max(0.5, duration * 0.08));
        video.currentTime = Math.min(Math.max(0.4, duration - 0.2), Math.max(0.4, seekTime));

        await new Promise<void>((resolve, reject) => {
          video.addEventListener("seeked", () => resolve(), { once: true });
          video.addEventListener("error", () => reject(new Error("Poster seek failed.")), { once: true });
        });

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");

        if (!context) {
          return null;
        }

        const sourceWidth = video.videoWidth;
        const sourceHeight = video.videoHeight;
        const sourceRatio = sourceWidth / sourceHeight;
        const targetRatio = canvas.width / canvas.height;
        const cropWidth = sourceRatio > targetRatio ? sourceHeight * targetRatio : sourceWidth;
        const cropHeight = sourceRatio > targetRatio ? sourceHeight : sourceWidth / targetRatio;
        const cropX = (sourceWidth - cropWidth) / 2;
        const cropY = (sourceHeight - cropHeight) / 2;

        context.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.72);
      } finally {
        video.removeAttribute("src");
        video.load();
      }
    })();

    thumbnailCache.set(cacheKey, thumbnail);
    return thumbnail;
  };

  const hydratePoster = async (entry: CinemaEntry, poster: HTMLElement) => {
    const explicitTime = Number(poster.dataset.cinemaFrameTime);

    if (entry.mediaKind !== "video") {
      return;
    }

    const remoteUrl = poster.dataset.cinemaBackdrop ? entry.backdropUrl || entry.posterUrl : entry.posterUrl;
    if (remoteUrl && !Number.isFinite(explicitTime)) {
      const loaded = await new Promise<boolean>((resolve) => {
        const image = new Image();
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
        image.src = remoteUrl;
      });
      if (loaded) return;
      poster.style.backgroundImage = "";
    }

    const isWideThumbnail = Boolean(poster.dataset.cinemaBackdrop);
    const thumbnail = await captureVideoThumbnail(
      entry,
      Number.isFinite(explicitTime) ? explicitTime : -1,
      isWideThumbnail ? 384 : 320,
      isWideThumbnail ? 216 : 480
    );

    if (!thumbnail) {
      return;
    }

    poster.style.backgroundImage = `url(${thumbnail})`;
    poster.classList.add("ready");

    if (poster.dataset.cinemaPoster || poster.classList.contains("cinema-chapter-thumb") || poster.classList.contains("cinema-next-thumb")) {
      poster.innerHTML = "";
    }
  };

  const hydratePosters = () => {
    app.querySelectorAll<HTMLElement>("[data-cinema-poster], [data-cinema-backdrop]").forEach((poster) => {
      const path = poster.dataset.cinemaPoster ?? poster.dataset.cinemaBackdrop;
      const entry = entries.find((candidate) => candidate.path === path);

      if (entry) {
        void hydratePoster(entry, poster).catch(() => {});
      }
    });
  };

  const renderFooter = () => {
    const server = currentServerInfo();
    const now = new Date();

    footer.innerHTML = `
      <span><i class="cinema-status-dot ${server.online ? "online" : "offline"}"></i>${server.online ? "Server Online" : "Server Offline"}</span>
      <span>${escapeHtml(server.name)} / ${escapeHtml(server.address)}</span>
      <time>${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
    `;
  };

  const render = () => {
    topNav.innerHTML = renderTopNav(view);
    content.classList.toggle("scanning", isScanning);

    if (view === "library") {
      content.innerHTML = renderLibrary(entries, activeCategory, query, selected, playback, catalogMessage);
    }

    if (view === "watchlist") {
      content.innerHTML = renderWatchlistView(entries, query);
    }

    if (view === "title-detail") {
      content.innerHTML = selected ? renderTitleHero(selected, entries, selected.id ? playback.get(selected.id) : undefined, selected.id ? catalogState.get(selected.id) : undefined, selected.id ? subtitleState.get(selected.id) : undefined, subtitlePreference, options.canManageRenditions) : renderLibrary(entries, activeCategory, query, selected, playback, catalogMessage);
    }

    if (view === "player") {
      content.innerHTML = selected ? renderPlayerView(selected, entries, selected.id ? subtitleState.get(selected.id) : undefined, qualityPreference, renditionProfiles) : renderLibrary(entries, activeCategory, query, selected, playback, catalogMessage);
    }

    if (view === "servers") {
      content.innerHTML = renderServersView();
    }

    if (view === "identify") {
      content.innerHTML = renderIdentifyView(selected);
    }

    const search = topNav.querySelector<HTMLInputElement>("[data-cinema-search]");
    if (search) {
      search.value = query;
    }

    content.querySelectorAll<HTMLButtonElement>("[data-cinema-category]").forEach((button) => {
      button.classList.toggle("active", view === "library" && button.dataset.cinemaCategory === activeCategory);
    });

    renderFooter();
    hydratePosters();
    const subtitleSelect = content.querySelector<HTMLSelectElement>("[data-cinema-subtitle-select]");
    if (subtitleSelect && selected?.id && selected.sourceId) subtitleSelect.addEventListener("change", async () => {
      subtitleSelect.disabled = true;
      try { await selectSubtitleTrack(selected!.id!, selected!.sourceId!, subtitleSelect.value || null); subtitleState.set(selected!.id!, await listSubtitleTracks(selected!.id!, selected!.sourceId!)); render(); }
      catch { subtitleSelect.title = "Subtitle selection is unavailable; video playback is unaffected."; subtitleSelect.disabled = false; }
    });
    content.querySelector<HTMLFormElement>("[data-cinema-subtitle-preferences]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      try {
        subtitlePreference = await saveSubtitlePreference({ mode: String(data.get("mode")) as SubtitlePreference["mode"], languages: String(data.get("languages") ?? "").split(",").map((value) => value.trim()).filter(Boolean) });
        if (selected?.id && selected.sourceId) subtitleState.set(selected.id, await listSubtitleTracks(selected.id, selected.sourceId));
        render();
      } catch (error) { form.title = error instanceof Error ? error.message : "Preferences could not be saved."; }
    });
  };

  const saveSelectedToPlaylist = async (entry: CinemaEntry, button: HTMLButtonElement) => {
    if (!entry.id) return;
    button.disabled = true;
    try {
      let playlist = playlists[0];
      if (!playlist) playlist = (await createMediaList("playlist", "Cinema Favorites", "video")).list;
      playlist = (await addMediaListItem("playlist", playlist.id, entry.id)).list;
      playlists = [playlist, ...playlists.filter(({ id }) => id !== playlist.id)];
      button.textContent = "Saved to playlist";
    } catch (error) {
      button.textContent = error instanceof Error && /already/i.test(error.message) ? "Already in playlist" : "Could not save";
    } finally { button.disabled = false; }
  };

  const loadCatalogDetail = async (entry: CinemaEntry) => {
    if (!entry.id || catalogState.has(entry.id)) return;
    try {
      const candidate = await getCinemaCatalogItem(entry.id);
      const rawChapters = candidate.chapters;
      const chapters = rawChapters.filter((chapter): chapter is MediaChapter => Boolean(chapter && typeof chapter === "object" && Number.isFinite((chapter as MediaChapter).startSeconds)));
      catalogState.set(entry.id, { chapters, probeState: String(candidate.probeState ?? (chapters.length ? "Ready" : "Pending")) });
      if (selected?.id === entry.id && view === "title-detail") render();
    } catch {
      catalogState.set(entry.id, { chapters: [], probeState: "Local fallback" });
    }
  };

  const openTitle = (entry: CinemaEntry) => {
    selected = entry;
    activeCategory = entry.category;
    view = "title-detail";
    render();
    void loadCatalogDetail(entry);
    if (entry.id && entry.sourceId) void listSubtitleTracks(entry.id, entry.sourceId).then((state) => { subtitleState.set(entry.id!, state); if (selected?.id === entry.id) render(); }).catch(() => {});
    if (!subtitlePreference) void getSubtitlePreference().then((value) => { subtitlePreference = value; if (selected?.id === entry.id) render(); }).catch(() => {});
  };

  const openPlayer = (fullscreen = false, startPosition: number | null = null) => {
    if (!selected) {
      return;
    }

    const playingEntry = selected;
    view = "player";
    render();

    const player = content.querySelector<HTMLMediaElement>("[data-cinema-player]");
    const stage = content.querySelector<HTMLElement>(".cinema-video-stage");
    const status = content.querySelector<HTMLElement>("[data-cinema-player-status]");

    if (player && stage) {
      let sessionId: string | null = null;
      let deliveryId: string | null = null;
      let pendingDeliveryId: string | null = null;
      let hlsPlayback: HlsPlaybackHandle | null = null;
      let requestGeneration = 0;
      const generation = ++deliveryGeneration;
      let ended = false;
      let lifecycleStarted = false;
      let lastProgressAt = 0;
      let eventQueue = Promise.resolve();
      const report = (event: PlaybackEventKind) => {
        if (!playingEntry.id || !playingEntry.sourceId) return;
        if (event === "start") lifecycleStarted = true;
        const durationSeconds = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : null;
        const positionSeconds = durationSeconds === null ? Math.max(0, player.currentTime || 0) : Math.min(durationSeconds, Math.max(0, player.currentTime || 0));
        eventQueue = eventQueue.then(async () => {
          if (event !== "start" && !sessionId) return;
          const result = await reportCinemaPlayback({
            durationSeconds,
            event,
            eventId: crypto.randomUUID(),
            itemId: playingEntry.id!,
            positionSeconds,
            sessionId,
            sourceId: playingEntry.sourceId!
          });
          sessionId = result.session.id;
          if (result.state.positionSeconds > 0 && result.state.lastPlayedAt) {
            playback.set(playingEntry.id!, {
              itemId: playingEntry.id!,
              lastPlayedAt: result.state.lastPlayedAt,
              positionSeconds: result.state.positionSeconds,
              progress: durationSeconds ? result.state.positionSeconds / durationSeconds : 0,
              sourceId: result.state.sourceId
            });
          } else {
            playback.delete(playingEntry.id!);
          }
        }).catch(() => setStatus("Playing locally; progress sync is unavailable."));
      };
      const renderPlaybackState = () => {
        stage.classList.toggle("is-playing", !player.paused && !player.ended);
      };
      const setStatus = (message: string) => {
        if (status) {
          status.textContent = message;
        }
      };
      const attachSubtitle = (subtitleId: string | null) => {
        player.querySelectorAll("track").forEach((track) => track.remove());
        const state = playingEntry.id ? subtitleState.get(playingEntry.id) : undefined;
        const track = state?.tracks.find((candidate) => candidate.id === subtitleId);
        if (!track || track.kind !== "sidecar" || !playingEntry.id || !playingEntry.sourceId) return;
        const node = document.createElement("track");
        node.kind = "subtitles";
        node.label = track.label;
        node.srclang = track.language ?? "und";
        node.src = subtitleAssetUrl(playingEntry.id, playingEntry.sourceId, track.id);
        node.default = true;
        player.append(node);
        node.addEventListener("load", () => { if (node.track) node.track.mode = "showing"; });
      };
      const playerSubtitle = content.querySelector<HTMLSelectElement>("[data-cinema-player-subtitle]");
      attachSubtitle(playerSubtitle?.value || null);
      playerSubtitle?.addEventListener("change", async () => {
        try { await selectSubtitleTrack(playingEntry.id!, playingEntry.sourceId!, playerSubtitle.value || null); attachSubtitle(playerSubtitle.value || null); }
        catch { setStatus("Subtitles are unavailable; video playback continues."); }
      });

      player.addEventListener("play", () => {
        renderPlaybackState();
        if (status) {
          delete status.dataset.cinemaPlaybackError;
        }
        setStatus("Playback requested.");
        if (!lifecycleStarted) report("start");
      });
      player.addEventListener("playing", () => {
        renderPlaybackState();
        setStatus("Playing from the local Cinema server.");
      });
      player.addEventListener("pause", () => {
        renderPlaybackState();
        setStatus("Paused.");
        if (!ended) report("pause");
      });
      player.addEventListener("ended", () => {
        ended = true;
        renderPlaybackState();
        setStatus("Finished.");
        report("complete");
        if (deliveryId) { void completeCinemaDelivery(deliveryId).catch(() => {}); deliveryId = null; }
      });
      player.addEventListener("timeupdate", () => {
        if (sessionId && Date.now() - lastProgressAt >= 10_000) {
          lastProgressAt = Date.now();
          report("progress");
        }
      });
      const stopPlayback = () => {
        deliveryGeneration += 1;
        requestGeneration += 1;
        if (!ended && lifecycleStarted) {
          ended = true;
          report("stop");
        }
        window.removeEventListener("pagehide", stopPlayback);
        hlsPlayback?.destroy();
        hlsPlayback = null;
        if (deliveryId) void cancelCinemaDelivery(deliveryId).catch(() => {});
        if (pendingDeliveryId && pendingDeliveryId !== deliveryId) void cancelCinemaDelivery(pendingDeliveryId).catch(() => {});
      };
      stopActivePlayback = stopPlayback;
      window.addEventListener("pagehide", stopPlayback, { once: true });
      player.addEventListener("stalled", () => setStatus("Playback is waiting for more data from the server."));
      player.addEventListener("error", () => setStatus("This video could not be played here."));
      renderPlaybackState();

      const seekWhenReady = (position: number | null) => {
        if (position === null || position <= 0) return;
        const seek = () => {
          if (Number.isFinite(player.duration) && position < player.duration) player.currentTime = Math.max(0, position);
        };
        if (player.readyState >= 1) seek(); else player.addEventListener("loadedmetadata", seek, { once: true });
      };
      const useFallback = (position = startPosition) => {
        if (generation !== deliveryGeneration) return;
        hlsPlayback?.destroy();
        hlsPlayback = null;
        setStatus("Using local compatibility playback.");
        player.src = playingEntry.streamUrl;
        player.load();
        seekWhenReady(position);
        void player.play().catch(() => setStatus("Ready. Press Play to start playback."));
      };
      const attachDelivery = async (created: Awaited<ReturnType<typeof createCinemaDelivery>>, targetPosition: number | null, shouldPlay: boolean) => {
        hlsPlayback?.destroy();
        hlsPlayback = null;
        const source = apiUrl(created.session.deliveryUrl);
        if (created.plan.output.protocol === "hls") {
          hlsPlayback = createHlsPlayback({
            manifestUrl: source,
            media: player,
            onError: (error) => setStatus(error.message)
          });
          await hlsPlayback.ready;
        } else {
          player.src = source;
          player.load();
        }
        seekWhenReady(targetPosition);
        if (shouldPlay) void player.play().catch(() => setStatus("Ready. Press Play to start playback."));
      };
      const prepareDelivery = async (preference = qualityPreference, targetPosition = startPosition, switching = false) => {
        if (!(player instanceof HTMLVideoElement) || !playingEntry.id || !playingEntry.sourceId || getApiConnectionMode() !== "Same origin") return useFallback();
        const localRequest = ++requestGeneration;
        const oldDeliveryId = deliveryId;
        const shouldPlay = switching ? !player.paused : true;
        setStatus(switching ? `Preparing ${qualityResultLabel(preference)}…` : "Preparing compatible playback…");
        try {
          const created = await createCinemaDelivery({ capabilities: deliveryCapabilities(player), itemId: playingEntry.id, quality: preference, sourceId: playingEntry.sourceId, startPositionSeconds: targetPosition });
          pendingDeliveryId = created.session.id;
          let delivery = created.session;
          while (["queued", "running"].includes(delivery.status)) {
            await new Promise((resolve) => window.setTimeout(resolve, 350));
            if (generation !== deliveryGeneration || localRequest !== requestGeneration) {
              void cancelCinemaDelivery(delivery.id).catch(() => {});
              return false;
            }
            delivery = (await getCinemaDelivery(delivery.id)).session;
          }
          if (delivery.status !== "ready" || generation !== deliveryGeneration || localRequest !== requestGeneration) throw new Error("Delivery did not become ready.");
          await attachDelivery({ ...created, session: delivery }, targetPosition, shouldPlay);
          if (generation !== deliveryGeneration || localRequest !== requestGeneration) {
            void cancelCinemaDelivery(delivery.id).catch(() => {});
            return false;
          }
          deliveryId = delivery.id;
          pendingDeliveryId = null;
          if (oldDeliveryId && oldDeliveryId !== deliveryId) void cancelCinemaDelivery(oldDeliveryId).catch(() => {});
          qualityPreference = preference;
          const qualitySelect = content.querySelector<HTMLSelectElement>("[data-cinema-player-quality]");
          const qualityResult = content.querySelector<HTMLElement>("[data-cinema-quality-result]");
          if (qualitySelect) { qualitySelect.value = qualityValue(preference); qualitySelect.disabled = false; }
          if (qualityResult) qualityResult.textContent = qualityResultLabel(preference, created.plan);
          const readyMessage = created.plan.decision === "direct-play" ? "Direct play ready." : created.plan.decision === "remux" ? "Compatible MP4 ready." : "HLS stream ready.";
          setStatus(readyMessage);
          return true;
        } catch {
          if (pendingDeliveryId) { void cancelCinemaDelivery(pendingDeliveryId).catch(() => {}); pendingDeliveryId = null; }
          const qualitySelect = content.querySelector<HTMLSelectElement>("[data-cinema-player-quality]");
          if (qualitySelect) { qualitySelect.value = qualityValue(qualityPreference); qualitySelect.disabled = false; }
          if (switching) setStatus("That quality is unavailable for this title or device.");
          else if (preference.mode === "profile") setStatus("That quality is unavailable. Choose Auto or Original.");
          else useFallback(targetPosition);
          return false;
        }
      };
      const qualitySelect = content.querySelector<HTMLSelectElement>("[data-cinema-player-quality]");
      qualitySelect?.addEventListener("change", () => {
        const next = parseQualityValue(qualitySelect.value);
        const position = Number.isFinite(player.currentTime) ? player.currentTime : 0;
        qualitySelect.disabled = true;
        void prepareDelivery(next, position, true);
      });
      void prepareDelivery();
    }

    if (fullscreen && player instanceof HTMLVideoElement) {
      void player.requestFullscreen?.();
    }
  };

  const frameBrightness = (context: CanvasRenderingContext2D, width: number, height: number) => {
    const pixels = context.getImageData(0, 0, width, height).data;
    let total = 0;

    for (let index = 0; index < pixels.length; index += 16) {
      total += (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
    }

    return total / (pixels.length / 16);
  };

  const waitForVideoEvent = (video: HTMLVideoElement, eventName: "loadedmetadata" | "seeked") =>
    new Promise<void>((resolve, reject) => {
      video.addEventListener(eventName, () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("Video frame sampling failed.")), { once: true });
    });

  const captureIdentificationFrames = async (entry: CinemaEntry): Promise<CinemaIdentificationFrame[]> => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = entry.streamUrl;

    await waitForVideoEvent(video, "loadedmetadata");

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 120;
    const canvas = document.createElement("canvas");
    canvas.width = 384;
    canvas.height = 216;
    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (!context) {
      return [];
    }

    const frames: CinemaIdentificationFrame[] = [];
    const sampleCount = 10;

    for (let index = 0; index < sampleCount; index += 1) {
      video.currentTime = Math.min(duration - 0.2, Math.max(0.4, duration * ((index + 1) / (sampleCount + 1))));
      await waitForVideoEvent(video, "seeked");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      if (frameBrightness(context, canvas.width, canvas.height) < 12) {
        continue;
      }

      frames.push({
        image: canvas.toDataURL("image/jpeg", 0.72),
        index,
        time: video.currentTime
      });
    }

    video.removeAttribute("src");
    video.load();
    return frames;
  };

  const identifySelectedVideo = async () => {
    if (!selected || selected.mediaKind !== "video") {
      return;
    }

    view = "identify";
    render();

    const panel = content.querySelector<HTMLElement>("[data-cinema-identify]");
    const identify = content.querySelector<HTMLButtonElement>("[data-cinema-action='run-identify']");

    if (!panel || !identify) {
      return;
    }

    identify.disabled = true;
    identify.textContent = "Sampling";
    panel.innerHTML = `
      <div class="cinema-empty">
        <strong>Sampling video frames</strong>
        <span>Capturing visual evidence across the runtime.</span>
      </div>
    `;

    try {
      const frames = await captureIdentificationFrames(selected);

      if (frames.length === 0) {
        throw new Error("No useful frames could be sampled from this video.");
      }

      identify.textContent = "Searching";
      panel.innerHTML = renderIdentificationResult(
        frames,
        await identifyCinemaFrames({
          frames,
          path: selected.path,
          title: selected.title
        })
      );
    } catch (error) {
      panel.innerHTML = `
        <div class="cinema-empty">
          <strong>Identification unavailable</strong>
          <span>${escapeHtml(error instanceof Error ? error.message : "Unable to sample this video.")}</span>
        </div>
      `;
    } finally {
      identify.disabled = false;
      identify.textContent = "Identify Title";
    }
  };

  const openEditor = () => {
    if (!selected) {
      return;
    }

    view = "metadata-editor";
    editorHost.hidden = false;
    editorHost.innerHTML = renderEditForm(selected);
  };

  const openSheet = (html: string) => {
    editorHost.hidden = false;
    editorHost.innerHTML = html;
    hydratePosters();
  };

  const openOptimizeSheet = async (entry: CinemaEntry, message = "") => {
    if (!entry.id) return;
    try {
      const state = await listItemRenditions(entry.id);
      openSheet(renderOptimizeSheet(entry, state.profiles, state.renditions, message));
    } catch (error) {
      openSheet(renderOptimizeSheet(entry, [], [], error instanceof Error ? error.message : "Optimization status is unavailable."));
    }
  };

  const updateEntryFromMetadata = (entry: CinemaEntry, metadata: Record<string, unknown>): CinemaEntry => ({
    ...entry,
    ...metadata,
    genres: Array.isArray(metadata.genres) ? metadata.genres.filter((genre): genre is string => typeof genre === "string") : entry.genres
  } as CinemaEntry);

  const closeSheet = () => {
    pendingPlayback = null;
    editorHost.hidden = true;
    editorHost.innerHTML = "";
  };

  const closeResumePrompt = () => {
    closeSheet();
    queueMicrotask(() => content.querySelector<HTMLButtonElement>(".cinema-actions [data-cinema-action='play']")?.focus());
  };

  const requestPlayer = (fullscreen = false) => {
    if (!selected) {
      return;
    }

    const resume = selected.id ? playback.get(selected.id) : undefined;
    if (!resume || resume.positionSeconds <= 0) {
      openPlayer(fullscreen);
      return;
    }

    const request = { entry: selected, fullscreen, resume };
    openSheet(renderResumeSheet(request.entry, request.resume));
    pendingPlayback = request;
    queueMicrotask(() => editorHost.querySelector<HTMLButtonElement>("[data-cinema-action='resume-play']")?.focus());
  };

  const continuePendingPlayback = (resume: boolean) => {
    const request = pendingPlayback;
    if (!request) {
      return;
    }

    closeSheet();
    selected = request.entry;
    openPlayer(request.fullscreen, resume ? request.resume.positionSeconds : 0);
  };

  const closeEditor = () => {
    view = selected ? "title-detail" : "library";
    closeSheet();
    render();
  };

  const tmdbController = createCinemaTmdbController({
    closeSheet,
    getSelected: () => selected,
    openSheet,
    render,
    renderSheet: renderTmdbSheet,
    updateEntry: (entry, metadata) => {
      const updated = updateEntryFromMetadata(entry, metadata);
      entries = entries.map((candidate) => candidate.path === updated.path ? updated : candidate);
      selected = updated;
      return updated;
    }
  });

  const saveMetadata = async (form: HTMLFormElement) => {
    if (!selected) {
      return;
    }

    const status = form.querySelector<HTMLElement>("[data-cinema-editor-status]");
    const data = new FormData(form);
    const payload: CinemaMetadataUpdateRequest = {
      cast: String(data.get("cast") ?? ""),
      collection: String(data.get("collection") ?? ""),
      genres: String(data.get("genres") ?? ""),
      path: selected.path,
      posterUrl: String(data.get("posterUrl") ?? ""),
      rating: String(data.get("rating") ?? ""),
      releaseYear: String(data.get("releaseYear") ?? ""),
      sortTitle: String(data.get("sortTitle") ?? ""),
      studio: String(data.get("studio") ?? ""),
      summary: String(data.get("summary") ?? ""),
      tagline: String(data.get("tagline") ?? ""),
      title: String(data.get("title") ?? "")
    };

    if (status) {
      status.textContent = "Saving";
    }

    await updateCinemaMetadata(payload);

    const updatedEntry: CinemaEntry = {
      ...selected,
      ...payload,
      genres: payload.genres
        .split(",")
        .map((genre) => genre.trim())
        .filter(Boolean)
    };

    entries = entries.map((entry) => (entry.path === selected?.path ? updatedEntry : entry));
    selected = updatedEntry;
    closeEditor();
  };

  const toggleWatchlist = async (entry: CinemaEntry, button?: HTMLButtonElement) => {
    const nextWatchlisted = !entry.watchlisted;
    const payload: CinemaWatchlistUpdateRequest = {
      path: entry.path,
      watchlisted: nextWatchlisted
    };

    if (button) {
      button.disabled = true;
      button.textContent = nextWatchlisted ? "Adding" : "Removing";
    }

    await updateCinemaWatchlist(payload);

    const updatedEntry: CinemaEntry = {
      ...entry,
      watchlisted: nextWatchlisted
    };

    entries = entries.map((candidate) => (candidate.path === entry.path ? updatedEntry : candidate));

    if (selected?.path === entry.path) {
      selected = updatedEntry;
    }

    render();
  };

  const loadLibrary = async () => {
    isScanning = true;
    render();

    try {
      entries = (await listCinemaLibrary()).entries;
      try {
        const catalog = await listCinemaCatalog();
        const continuing = options.personalPlayback === false ? { entries: [] } : await listCinemaContinueWatching();
        const byPath = new Map(catalog.items.map((item) => [item.path ?? item.source?.path ?? "", item]));
        entries = entries.map((entry) => {
          const item = (entry.id ? catalog.items.find((candidate) => candidate.id === entry.id) : undefined) ?? byPath.get(entry.path);
          return item ? {
            ...entry,
            availability: (item.availability ?? item.source?.availability ?? entry.availability) as CinemaEntry["availability"],
            id: item.id,
            sourceId: item.sourceId ?? item.source?.id ?? entry.sourceId
          } : entry;
        });
        playback = new Map(continuing.entries.map((entry) => [entry.itemId, entry]));
        catalogMessage = options.personalPlayback === false
          ? `${catalog.items.length} stable catalog ${catalog.items.length === 1 ? "item" : "items"} · guest session`
          : `${catalog.items.length} stable catalog ${catalog.items.length === 1 ? "item" : "items"} · playback synced`;
      } catch {
        catalogMessage = "Local fallback · catalog or personal playback state is unavailable";
      }
      selected = selected ? entries.find((entry) => entry.path === selected?.path) ?? selected : null;
    } catch (error) {
      content.innerHTML = `
        <div class="cinema-empty">
          <strong>Library unavailable</strong>
          <span>${escapeHtml(error instanceof Error ? error.message : "Unable to scan content.")}</span>
        </div>
      `;
    } finally {
      isScanning = false;
      render();
    }
  };

  app.addEventListener("keydown", (event) => {
    if (!pendingPlayback) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeResumePrompt();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusable = Array.from(editorHost.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
    if (focusable.length === 0) {
      return;
    }

    const activeIndex = focusable.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.shiftKey
      ? activeIndex <= 0 ? focusable.at(-1) : null
      : activeIndex === -1 || activeIndex === focusable.length - 1 ? focusable[0] : null;

    if (next) {
      event.preventDefault();
      next.focus();
    }
  });

  app.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const resumeBackdrop = target.closest<HTMLElement>("[data-cinema-resume-sheet]");
    const categoryButton = target.closest<HTMLButtonElement>("[data-cinema-category]");
    const pathButton = target.closest<HTMLButtonElement>("[data-cinema-path]");
    const actionButton = target.closest<HTMLButtonElement>("[data-cinema-action]");
    const retentionButton = target.closest<HTMLButtonElement>("[data-cinema-rendition-retention]");
    const removeButton = target.closest<HTMLButtonElement>("[data-cinema-rendition-remove]");

    if (retentionButton && selected?.id) {
      retentionButton.disabled = true;
      void setRenditionRetention(selected.id, retentionButton.dataset.cinemaRenditionRetention!, retentionButton.dataset.retention === "pinned" ? "pinned" : "cache")
        .then(() => openOptimizeSheet(selected!, "Retention updated."))
        .catch((error) => openOptimizeSheet(selected!, error instanceof Error ? error.message : "Retention could not be updated."));
      return;
    }
    if (removeButton && selected?.id) {
      if (removeButton.dataset.confirm !== "true") {
        removeButton.dataset.confirm = "true";
        removeButton.textContent = "Confirm removal";
        return;
      }
      removeButton.disabled = true;
      void deleteRendition(selected.id, removeButton.dataset.cinemaRenditionRemove!)
        .then(() => openOptimizeSheet(selected!, "Rendition removed."))
        .catch((error) => openOptimizeSheet(selected!, error instanceof Error ? error.message : "Rendition could not be removed."));
      return;
    }

    if (resumeBackdrop && target === resumeBackdrop) {
      closeResumePrompt();
      return;
    }

    if (categoryButton) {
      activeCategory = (categoryButton.dataset.cinemaCategory as CinemaCategory | undefined) ?? "movies";
      selected = null;
      view = "library";
      render();
      return;
    }

    if (pathButton) {
      const entry = entries.find((candidate) => candidate.path === pathButton.dataset.cinemaPath);

      if (entry) {
        closeSheet();
        openTitle(entry);
      }
      return;
    }

    if (!actionButton) {
      return;
    }

    const action = actionButton.dataset.cinemaAction;

    if (action === "close-resume") {
      closeResumePrompt();
      return;
    }

    if (action === "resume-play") {
      continuePendingPlayback(true);
      return;
    }

    if (action === "restart-play") {
      continuePendingPlayback(false);
      return;
    }

    const active =
      (view === "watchlist" ? currentWatchlistEntries()[0] : selected ?? currentVisibleEntries()[0]) ??
      entries.find((entry) => entry.watchlisted) ??
      entries[0] ??
      null;

    if (action === "home") {
      stopActivePlayback?.();
      onHome?.();
    }

    if (action === "library") {
      stopActivePlayback?.();
      stopActivePlayback = null;
      selected = null;
      closeSheet();
      view = "library";
      render();
    }

    if (action === "watchlist") {
      selected = null;
      closeSheet();
      view = "watchlist";
      render();
    }

    if (action === "open-featured" && active) {
      openTitle(active);
    }

    if (action === "play" && view === "player") {
      const player = content.querySelector<HTMLMediaElement>("[data-cinema-player]");

      if (player) {
        void player.play().catch((error: unknown) => {
          const status = content.querySelector<HTMLElement>("[data-cinema-player-status]");
          const code = error instanceof DOMException ? error.name : "PlaybackError";

          if (status) {
            status.dataset.cinemaPlaybackError = code;
            status.textContent = code === "NotSupportedError"
              ? "This browser cannot decode the selected video."
              : code === "NotAllowedError"
                ? "Playback is ready. Press Play again to allow audio."
                : "Playback could not start. Try Play again.";
          }
        });
      }
      return;
    }

    if ((action === "play" || action === "play-featured") && active) {
      selected = active;
      requestPlayer(false);
    }

    if (action === "player-fullscreen") {
      const player = content.querySelector<HTMLMediaElement>("[data-cinema-player]");

      if (player instanceof HTMLVideoElement) {
        void player.requestFullscreen?.();
      }
    }

    if (action === "back-title") {
      stopActivePlayback?.();
      stopActivePlayback = null;
      view = "title-detail";
      render();
    }

    if (action === "edit" && active) {
      selected = active;
      openEditor();
    }

    if (action === "tmdb" && active) {
      selected = active;
      void tmdbController.open();
    }

    if (action === "tmdb-apply" && selected) {
      void tmdbController.apply(actionButton).then((updated) => { if (updated) render(); });
    }

    if (action === "tmdb-refresh" && active) {
      selected = active;
      void tmdbController.refresh(active, actionButton).then((updated) => { if (updated) render(); });
    }

    if (action === "more" && active) {
      selected = active;
      openSheet(renderMoreSheet(active));
    }

    if (action === "optimize" && active?.id && active.sourceId) {
      selected = active;
      void openOptimizeSheet(active);
    }

    if (action === "view-chapters" && active) {
      selected = active;
      openSheet(renderChaptersSheet(active, active.id ? catalogState.get(active.id)?.chapters ?? [] : []));
    }

    if (action === "view-queue") {
      openSheet(renderQueueSheet(entries, selected ?? active));
    }

    if (action === "save-playlist" && active) void saveSelectedToPlaylist(active, actionButton);

    if (action === "queue" && active) {
      const targetPath = actionButton.dataset.cinemaWatchlistPath ?? active.path;
      const targetEntry = entries.find((entry) => entry.path === targetPath) ?? active;
      void toggleWatchlist(targetEntry, actionButton).catch(() => {
        actionButton.disabled = false;
        actionButton.textContent = targetEntry.watchlisted ? "In Watchlist" : "Add to Watchlist";
      });
    }

    if (action === "close-editor") {
      closeEditor();
    }

    if (action === "close-sheet") {
      closeSheet();
    }

    if (action === "refresh") {
      void loadLibrary();
    }

    if (action === "scan-catalog") {
      actionButton.disabled = true;
      catalogMessage = "Catalog scan running…";
      render();
      void scanCinemaCatalog().then(async (result) => {
        const scan = result.scan;
        const scanMessage = scan.error ? `Scan failed · ${scan.error}` : `Scan complete · ${scan.discovered ?? 0} discovered · ${scan.new ?? 0} new · ${scan.changed ?? 0} changed`;
        await loadLibrary();
        catalogMessage = scanMessage;
        render();
      }).catch((error) => {
        catalogMessage = `Local fallback · ${error instanceof Error ? error.message : "scan unavailable"}`;
        render();
      });
    }

    if ((action === "played" || action === "unplayed") && active?.id && active.sourceId) {
      const markPlayed = action === "played";
      actionButton.disabled = true;
      void updateCinemaWatched({ itemId: active.id, sourceId: active.sourceId, watched: markPlayed }).then(() => {
        playback.delete(active.id!);
        render();
      }).catch(() => {
        actionButton.disabled = false;
        actionButton.textContent = "Playback update failed";
      });
    }

    if (action === "chapter" && selected) {
      const chapterTime = Number(actionButton.dataset.cinemaChapterTime);
      closeSheet();
      openPlayer(false, Number.isFinite(chapterTime) ? chapterTime : 0);
    }

    if (action === "servers") {
      view = "servers";
      render();
    }

    if (action === "identify-nav") {
      closeSheet();
      view = "identify";
      render();
    }

    if (action === "run-identify") {
      void identifySelectedVideo();
    }
  });

  app.addEventListener("submit", (event) => {
    const form = (event.target as Element).closest<HTMLFormElement>("[data-cinema-optimize-form]");
    if (!form || !selected?.id || !selected.sourceId) return;
    event.preventDefault();
    const data = new FormData(form);
    const profileIds = data.getAll("profileId").map(String) as RenditionProfileId[];
    if (!profileIds.length) {
      void openOptimizeSheet(selected, "Select at least one profile.");
      return;
    }
    form.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = true; });
    void buildItemRenditions(selected.id, { profileIds, retention: data.get("pinned") ? "pinned" : "cache", sourceId: selected.sourceId })
      .then(() => openOptimizeSheet(selected!, "Optimization jobs queued."))
      .catch((error) => openOptimizeSheet(selected!, error instanceof Error ? error.message : "Optimization could not be queued."));
  });

  app.addEventListener("input", (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>("[data-cinema-search]");

    if (input) {
      query = input.value.trim();
      if (view !== "watchlist") {
        view = "library";
      }
      render();
      input.focus();
    }
  });

  editorHost.addEventListener("submit", (event) => {
    const tmdbForm = (event.target as HTMLElement).closest<HTMLFormElement>("[data-cinema-tmdb-search]");

    if (tmdbForm && selected) {
      event.preventDefault();
      void tmdbController.submitSearch(tmdbForm);
      return;
    }

    const form = (event.target as HTMLElement).closest<HTMLFormElement>("[data-cinema-editor-form]");

    if (!form) {
      return;
    }

    event.preventDefault();
    void saveMetadata(form).catch((error) => {
      const status = form.querySelector<HTMLElement>("[data-cinema-editor-status]");

      if (status) {
        status.textContent = error instanceof Error ? error.message : "Save failed.";
      }
    });
  });

  render();
  void listRenditionProfiles().then((response) => {
    renditionProfiles = response.profiles;
    if (view !== "player") render();
  }).catch(() => {});
  void Promise.all([listMediaLists("playlist", "video"), listMediaLists("collection", "video")]).then(([personal, shared]) => {
    playlists = personal.lists; collections = shared.lists;
    catalogMessage = `${catalogMessage} · ${playlists.length} playlists · ${collections.length} collections`;
    render();
  }).catch(() => {});
  void loadLibrary();
};
