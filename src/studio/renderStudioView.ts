import { createElement, icons } from "lucide";
import { apiUrl, getApiConnectionMode, getEffectiveApiBaseUrl, getApiToken } from "../api/http";
import {
  cancelClusterMusicDelivery,
  createClusterMusicDelivery,
  failoverClusterMusicDelivery,
  getClusterMusicDelivery,
  listMusicLibrary,
  listStudioPlaybackHistory,
  reportStudioPlayback
} from "../api/musicApi";
import type { MusicEntry } from "../shared/musicTypes";
import { addMediaListItem, createMediaList, listMediaLists } from "../api/mediaListsApi";
import type { MediaList } from "../shared/mediaListTypes";
import type { PlaybackEventKind, PlaybackHistoryEntry } from "../shared/playbackTypes";
import { createBrowserUuid } from "../shared/browserUuid";
import type { FederatedAvailabilitySummary } from "../shared/federatedTypes";
import { pollDeliveryUntilReady } from "../shared/deliveryPolling.js";

interface StudioServerInfo {
  address: string;
  authState: string;
  mode: string;
  name: string;
  online: boolean;
}

type StudioBrowseMode = "albums" | "artists" | "library";
type StudioLibraryGroupKind = "album" | "artist";

interface StudioLibraryGroup {
  id: string;
  kind: StudioLibraryGroupKind;
  label: string;
  subtitle: string;
  tracks: MusicEntry[];
}

type StudioLibraryItem =
  | { group: StudioLibraryGroup; itemKind: "group" }
  | { itemKind: "track"; track: MusicEntry };

interface StudioLibraryScope {
  kind: StudioLibraryGroupKind;
  label: string;
  tracks: MusicEntry[];
}

const studioBrandMarkUrl = new URL(
  "../assets/branding/nebula-studio-eclipse-thin-groove.png",
  import.meta.url
).href;
const studioFallbackArtworkUrl = new URL(
  "../assets/branding/nebula-studio-eclipse-pulse-core.png",
  import.meta.url
).href;

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

const formatAudioFormat = (entry: MusicEntry) => {
  const extension = entry.name.split(".").pop()?.toUpperCase();
  return extension ? `${extension} audio` : "Audio file";
};

const formatTime = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, "0")}`;
};

const metadataLine = (entry: MusicEntry) =>
  [entry.artist, entry.album, entry.releaseYear, entry.genres.slice(0, 2).join(", ")].filter(Boolean).join(" / ");

const currentServerInfo = (): StudioServerInfo => ({
  address: getEffectiveApiBaseUrl() || "This device",
  authState: getApiToken() ? "Token saved" : "Local unauthenticated",
  mode: getApiConnectionMode(),
  name: getApiConnectionMode() === "Same origin" ? "Nebula Local" : "Nebula Server",
  online: getApiConnectionMode() !== "Needs server URL"
});

const studioPlaybackCapabilities = (player: HTMLAudioElement, deviceId: string) => ({
  audioCodecs: ["aac", "flac", "mp3", "opus", "vorbis"].filter((codec) => {
    const mime = codec === "mp3" ? "audio/mpeg" : codec === "aac" ? "audio/aac" : `audio/${codec}`;
    return player.canPlayType(mime) !== "";
  }),
  containers: ["aac", "flac", "m4a", "mp3", "ogg", "wav"],
  deviceId,
  maxAudioChannels: null,
  maxBitrate: null,
  maxHeight: null,
  maxWidth: null,
  subtitleFormats: [],
  supportsHls: player.canPlayType("application/vnd.apple.mpegurl") !== "",
  videoCodecs: []
});

const renderStudioIcon = (iconName: keyof typeof icons, className = "studio-ui-icon") => {
  const node = createElement(icons[iconName] ?? icons.Circle);
  node.setAttribute("class", className);
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("focusable", "false");
  return node.outerHTML;
};

const renderArtwork = (entry: MusicEntry | null, fallbackLabel = "S") => {
  const initial = (entry?.posterUrl ? entry.title : fallbackLabel).slice(0, 1).toUpperCase() || "S";
  const style = entry?.posterUrl ? ` style="background-image: url('${escapeHtml(entry.posterUrl)}')"` : "";

  return `
    <div class="studio-album-art ${entry?.posterUrl ? "has-poster" : "is-fallback"}"${style}>
      ${
        entry?.posterUrl
          ? ""
          : `<img src="${studioFallbackArtworkUrl}" alt="" aria-hidden="true" /><span aria-hidden="true">${escapeHtml(initial)}</span>`
      }
    </div>
  `;
};

const normalizeGroupValue = (value: string) => value.trim();
const groupId = (kind: StudioLibraryGroupKind, label: string) => `${kind}:${label.toLowerCase()}`;
const pluralizeTracks = (count: number) => `${count} ${count === 1 ? "track" : "tracks"}`;
const federationLabel = (federation: FederatedAvailabilitySummary) => federation.availability === "offline"
  ? "Offline"
  : federation.availability === "stale"
    ? "Stale"
    : federation.nodeCount === 1 ? federation.sources[0]?.nodeName || "1 shard" : `${federation.nodeCount} shards`;
const sortEntries = (left: MusicEntry, right: MusicEntry) =>
  (left.sortTitle || left.title).localeCompare(right.sortTitle || right.title);

const groupedLibraryItems = (tracks: MusicEntry[], scope: StudioLibraryScope | null): StudioLibraryItem[] => {
  const sortedTracks = [...tracks].sort(sortEntries);
  const groups = new Map<string, StudioLibraryGroup>();
  const looseTracks: MusicEntry[] = [];

  sortedTracks.forEach((track) => {
    const artist = normalizeGroupValue(track.artist);
    const album = normalizeGroupValue(track.album);

    if (!scope) {
      if (artist) {
        const id = groupId("artist", artist);
        const group = groups.get(id) ?? {
          id,
          kind: "artist" as const,
          label: artist,
          subtitle: "Artist",
          tracks: []
        };
        group.tracks.push(track);
        groups.set(id, group);
        return;
      }

      if (album) {
        const id = groupId("album", album);
        const group = groups.get(id) ?? {
          id,
          kind: "album" as const,
          label: album,
          subtitle: "Album",
          tracks: []
        };
        group.tracks.push(track);
        groups.set(id, group);
        return;
      }

      looseTracks.push(track);
      return;
    }

    if (scope.kind === "artist" && album) {
      const id = groupId("album", `${scope.label}:${album}`);
      const group = groups.get(id) ?? {
        id,
        kind: "album" as const,
        label: album,
        subtitle: scope.label,
        tracks: []
      };
      group.tracks.push(track);
      groups.set(id, group);
      return;
    }

    looseTracks.push(track);
  });

  return [
    ...Array.from(groups.values())
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((group) => ({ group, itemKind: "group" as const })),
    ...looseTracks.map((track) => ({ itemKind: "track" as const, track }))
  ];
};

const groupedModeItems = (tracks: MusicEntry[], mode: Exclude<StudioBrowseMode, "library">): StudioLibraryItem[] => {
  const groups = new Map<string, StudioLibraryGroup>();
  const looseTracks: MusicEntry[] = [];

  [...tracks].sort(sortEntries).forEach((track) => {
    const artist = normalizeGroupValue(track.artist);
    const album = normalizeGroupValue(track.album);
    const label = mode === "artists" ? artist : album;

    if (!label) {
      looseTracks.push(track);
      return;
    }

    const keyLabel = mode === "albums" ? `${artist}:${album}` : artist;
    const kind: StudioLibraryGroupKind = mode === "artists" ? "artist" : "album";
    const id = groupId(kind, keyLabel);
    const group = groups.get(id) ?? {
      id,
      kind,
      label,
      subtitle: mode === "artists" ? "Artist" : artist || "Album",
      tracks: []
    };
    group.tracks.push(track);
    groups.set(id, group);
  });

  return [
    ...Array.from(groups.values())
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((group) => ({ group, itemKind: "group" as const })),
    ...looseTracks.map((track) => ({ itemKind: "track" as const, track }))
  ];
};

const libraryItemsFor = (
  tracks: MusicEntry[],
  mode: StudioBrowseMode,
  scope: StudioLibraryScope | null
): StudioLibraryItem[] => {
  if (scope || mode === "library") {
    return groupedLibraryItems(tracks, scope);
  }

  return groupedModeItems(tracks, mode);
};

const renderLibraryItems = (items: StudioLibraryItem[], selected: MusicEntry | null) => {
  if (items.length === 0) {
    return `
      <div class="studio-empty studio-library-empty">
        <img src="${studioBrandMarkUrl}" alt="" aria-hidden="true" />
        <strong>No music found</strong>
        <span>Add MP3, FLAC, M4A, WAV, AAC, or OGG files with Files.</span>
      </div>
    `;
  }

  return items
    .map((item) => {
      if (item.itemKind === "group") {
        const cover = item.group.tracks.find((track) => track.posterUrl) ?? item.group.tracks[0] ?? null;

        return `
          <button class="studio-track studio-group-tile" type="button" data-studio-group="${escapeHtml(item.group.id)}">
            ${renderArtwork(cover, item.group.label)}
            <span>
              <strong>${escapeHtml(item.group.label)}</strong>
              <small>${escapeHtml(`${item.group.subtitle} / ${pluralizeTracks(item.group.tracks.length)}`)}</small>
            </span>
            <em>${escapeHtml(item.group.kind)}</em>
          </button>
        `;
      }

      const entry = item.track;

      return `
        <button class="studio-track ${selected?.path === entry.path ? "active" : ""}" type="button" data-studio-path="${escapeHtml(entry.path)}">
          ${renderArtwork(entry, entry.title)}
          <span>
            <strong>${escapeHtml(entry.title)}</strong>
            <small>${escapeHtml(metadataLine(entry) || `${entry.folder || "Content"} / ${formatAudioFormat(entry)}`)}</small>
          </span>
          <em class="${entry.playable === false ? "is-remote" : ""}">${escapeHtml(entry.federation ? federationLabel(entry.federation) : formatAudioFormat(entry).replace(" audio", ""))}</em>
        </button>
      `;
    })
    .join("");
};

const renderPlaybackHistory = (entries: MusicEntry[], history: Map<string, PlaybackHistoryEntry>) => {
  const available = entries
    .flatMap((entry) => entry.id && history.has(entry.id) ? [{ entry, state: history.get(entry.id)! }] : [])
    .sort((left, right) => Date.parse(right.state.lastPlayedAt) - Date.parse(left.state.lastPlayedAt));
  const continueListening = available.filter(({ state }) => !state.completed && state.positionSeconds > 0).slice(0, 8);
  const recent = available.slice(0, 10);
  const rail = (items: typeof available, mode: "continue" | "recent") => items.map(({ entry, state }) => `
    <button type="button" data-studio-path="${escapeHtml(entry.path)}">
      ${renderArtwork(entry, entry.title)}
      <span><strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.artist || entry.album || "Local music")}</small></span>
      ${mode === "continue"
        ? `<i class="studio-history-progress" aria-label="${Math.round(state.progress * 100)}% played"><b style="width:${Math.round(state.progress * 100)}%"></b></i><em>Resume at ${formatTime(state.positionSeconds)}</em>`
        : `<em>${state.completed ? "Completed" : `Last played ${formatTime(state.positionSeconds)}`}</em>`}
    </button>`).join("");

  return `${continueListening.length ? `<section class="studio-history" aria-label="Continue listening"><header><div><p class="eyebrow">Continue Listening</p><strong>Pick up where you left off</strong></div><span>${continueListening.length} saved</span></header><div>${rail(continueListening, "continue")}</div></section>` : ""}
    ${recent.length ? `<section class="studio-history studio-recent" aria-label="Recently played"><header><div><p class="eyebrow">Listening History</p><strong>Recently played</strong></div><span>${recent.length} tracks</span></header><div>${rail(recent, "recent")}</div></section>` : ""}`;
};

const renderResumeDialog = (entry: MusicEntry, state: PlaybackHistoryEntry) => `
  <section class="studio-resume-sheet" role="presentation">
    <div class="studio-resume-dialog" role="dialog" aria-modal="true" aria-labelledby="studio-resume-title" aria-describedby="studio-resume-description">
      <button type="button" data-studio-action="close-resume" aria-label="Close resume dialog">${renderStudioIcon("X")}</button>
      <span class="studio-resume-mark">${renderStudioIcon("History")}</span>
      <div><p class="eyebrow">Continue Listening</p><h3 id="studio-resume-title">Resume ${escapeHtml(entry.title)}?</h3><p id="studio-resume-description">Pick up at <strong>${formatTime(state.positionSeconds)}</strong>, or restart this track.</p></div>
      <div class="studio-resume-progress" role="progressbar" aria-label="${Math.round(state.progress * 100)}% played" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(state.progress * 100)}"><i style="width:${Math.round(state.progress * 100)}%"></i></div>
      <div class="studio-resume-actions"><button class="primary" type="button" data-studio-action="resume-play">${renderStudioIcon("Play")} Resume at ${formatTime(state.positionSeconds)}</button><button type="button" data-studio-action="restart-play">${renderStudioIcon("RotateCcw")} Start over</button></div>
    </div>
  </section>`;

const queueEntries = (entries: MusicEntry[], selected: MusicEntry | null) =>
  entries.filter((entry) => entry.playable !== false && entry.path !== selected?.path).slice(0, 8);

const renderQueue = (entries: MusicEntry[], selected: MusicEntry) => {
  const queue = queueEntries(entries, selected);

  return `
    <section class="studio-queue">
      <header>
        <div>
          <p class="eyebrow">Up Next</p>
          <strong>${queue.length > 0 ? pluralizeTracks(queue.length) : "Queue clear"}</strong>
        </div>
        ${renderStudioIcon("ListPlus")}
      </header>
      <div>
        ${
          queue.length > 0
            ? queue
                .map(
                  (entry, index) => `
                    <button type="button" data-studio-path="${escapeHtml(entry.path)}">
                      <span class="studio-queue-index">${String(index + 1).padStart(2, "0")}</span>
                      ${renderArtwork(entry, entry.title)}
                      <span>
                        <strong>${escapeHtml(entry.title)}</strong>
                        <small>${escapeHtml(entry.artist || entry.album || entry.folder || "Local music")}</small>
                      </span>
                    </button>
                  `
                )
                .join("")
            : `<p>Add more audio files to build a queue.</p>`
        }
      </div>
    </section>
  `;
};

const relatedEntries = (entries: MusicEntry[], selected: MusicEntry) => {
  const related = entries.filter(
    (entry) =>
      entry.path !== selected.path &&
      ((selected.album && entry.album === selected.album) || (selected.artist && entry.artist === selected.artist))
  );

  return (related.length > 0 ? related : queueEntries(entries, selected)).slice(0, 6);
};

const renderRelated = (entries: MusicEntry[], selected: MusicEntry) => {
  const related = relatedEntries(entries, selected);
  const label = selected.album
    ? `More from ${selected.album}`
    : selected.artist
      ? `More from ${selected.artist}`
      : "More from your library";

  if (related.length === 0) {
    return "";
  }

  return `
    <section class="studio-related">
      <header>
        <p class="eyebrow">${escapeHtml(label)}</p>
        <span>${pluralizeTracks(related.length)}</span>
      </header>
      <div class="studio-related-rail">
        ${related
          .map(
            (entry) => `
              <button type="button" data-studio-path="${escapeHtml(entry.path)}">
                ${renderArtwork(entry, entry.title)}
                <strong>${escapeHtml(entry.title)}</strong>
                <small>${escapeHtml(entry.artist || entry.album || "Local music")}</small>
              </button>
            `
          )
          .join("")}
      </div>
    </section>
  `;
};

const renderFederatedSources = (entry: MusicEntry) => !entry.federation ? "" : `
  <section class="studio-shard-availability" aria-label="Available on">
    <header><div><p class="eyebrow">Sources</p><strong>Available on</strong></div><span class="is-${entry.federation.availability}">${escapeHtml(federationLabel(entry.federation))}</span></header>
    <div>${entry.federation.sources.map((source) => `<article><i class="is-${source.availability}" aria-hidden="true"></i><span><strong>${escapeHtml(source.nodeName)}</strong><small>${source.local ? "This server" : "Remote shard"}</small></span><em>${source.capabilities.directPlay ? "Direct play" : source.capabilities.transcode ? "Transcode" : source.nodeState}</em></article>`).join("")}</div>
    ${entry.playable === false ? `<p>This track is visible across the cluster, but no compatible online source is currently available.</p>` : ""}
  </section>`;

const renderSourceCards = (entry: MusicEntry, server: StudioServerInfo) => `
  ${renderFederatedSources(entry)}
  ${entry.playable === false ? "" : `<section class="studio-source-cards" aria-label="Track source details">
    <article>
      ${renderStudioIcon("AudioWaveform")}
      <span>Audio</span>
      <strong>${escapeHtml(formatAudioFormat(entry).replace(" audio", ""))}</strong>
      <small>${escapeHtml(entry.genres.slice(0, 2).join(" / ") || "Local high fidelity")}</small>
    </article>
    <article>
      ${renderStudioIcon("FolderOpen")}
      <span>Local File</span>
      <strong>${escapeHtml(entry.folder || "Content root")}</strong>
      <small>${escapeHtml(`${entry.name} / ${formatSize(entry.size)}`)}</small>
    </article>
    <article>
      ${renderStudioIcon("Server")}
      <span>Nebula Server</span>
      <strong class="${server.online ? "is-online" : ""}">${server.online ? "Connected" : "Offline"}</strong>
      <small>${escapeHtml(`${server.name} / ${server.mode}`)}</small>
    </article>
  </section>`}
`;

const renderTransportControls = () => `
  <section class="studio-transport" aria-label="Playback controls" data-studio-controls>
    <div class="studio-transport-timeline">
      <time data-studio-current-time>0:00</time>
      <input type="range" min="0" max="1000" value="0" step="1" data-studio-seek aria-label="Seek through track" />
      <time data-studio-duration>0:00</time>
    </div>
    <div class="studio-transport-actions">
      <button type="button" data-studio-action="previous" aria-label="Previous track">${renderStudioIcon("SkipBack")}</button>
      <button class="studio-play-command" type="button" data-studio-action="toggle-play" data-studio-play-toggle aria-label="Play track">${renderStudioIcon("Play")}</button>
      <button type="button" data-studio-action="next" aria-label="Next track">${renderStudioIcon("SkipForward")}</button>
      <p class="studio-player-status" data-studio-player-status>Ready to play.</p>
      <button type="button" data-studio-action="toggle-mute" data-studio-mute-toggle aria-label="Mute">${renderStudioIcon("Volume2")}</button>
      <input class="studio-volume" type="range" min="0" max="1" value="1" step="0.05" data-studio-volume aria-label="Volume" />
    </div>
  </section>
`;

const renderMiniPlayer = (entry: MusicEntry) => `
  <button class="studio-mini-track" type="button" data-studio-action="open-player" aria-label="Open ${escapeHtml(entry.title)}">
    ${renderArtwork(entry, entry.title)}
    <span><strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.artist || entry.album || "Local music")}</small></span>
  </button>
  <div class="studio-mini-transport" aria-label="Mini player controls" data-studio-controls>
    <button type="button" data-studio-action="previous" aria-label="Previous track">${renderStudioIcon("SkipBack")}</button>
    <button class="studio-play-command" type="button" data-studio-action="toggle-play" data-studio-play-toggle aria-label="Play track">${renderStudioIcon("Play")}</button>
    <button type="button" data-studio-action="next" aria-label="Next track">${renderStudioIcon("SkipForward")}</button>
  </div>
  <div class="studio-mini-progress">
    <input type="range" min="0" max="1000" value="0" step="1" data-studio-seek aria-label="Seek through ${escapeHtml(entry.title)}" />
    <span><time data-studio-current-time>0:00</time><i>/</i><time data-studio-duration>0:00</time></span>
  </div>
  <div class="studio-mini-volume">
    <button type="button" data-studio-action="toggle-mute" data-studio-mute-toggle aria-label="Mute">${renderStudioIcon("Volume2")}</button>
    <input type="range" min="0" max="1" value="1" step="0.05" data-studio-volume aria-label="Volume" />
  </div>
`;

const renderNowPlaying = (entry: MusicEntry, entries: MusicEntry[]) => {
  const server = currentServerInfo();

  return `
    <button class="studio-back-command" type="button" data-studio-action="library">${renderStudioIcon("ArrowLeft")} Back to Library</button>
    <div class="studio-player-hero">
      <section class="studio-now">
        <div class="studio-artwork-stage">
          ${renderArtwork(entry, entry.title)}
          <span class="studio-format-chip">${escapeHtml(entry.federation && !entry.sourceId ? "Remote shard" : `${formatAudioFormat(entry).replace(" audio", "")} / Local file`)}</span>
        </div>
        <div class="studio-track-detail">
          <p class="eyebrow">Now Playing</p>
          <h2>${escapeHtml(entry.title)}</h2>
          <p class="studio-now-artist">${escapeHtml(entry.artist || "Unknown artist")}</p>
          <p class="studio-now-album">${escapeHtml(entry.album || entry.folder || "Local music")}</p>
          <div class="studio-waveform" aria-hidden="true">
            <canvas data-studio-visualizer data-studio-visualizer-mode="ambient"></canvas>
          </div>
          ${entry.playable === false ? `<div class="studio-remote-playback-note">${renderStudioIcon("ServerOff")}<span><strong>No compatible shard is online</strong><small>This track remains in the unified library and will become playable when an eligible source reconnects.</small></span></div>` : renderTransportControls()}
          ${entry.playable !== false && entry.id ? `<button class="studio-playlist-command" type="button" data-studio-action="save-playlist">${renderStudioIcon("ListPlus")} Save to playlist</button>` : ""}
        </div>
      </section>
      ${renderQueue(entries, entry)}
    </div>
    <div class="studio-player-lower">
      ${renderSourceCards(entry, server)}
      ${renderRelated(entries, entry)}
    </div>
  `;
};

const browseLabel = (mode: StudioBrowseMode) =>
  mode === "artists" ? "Artists" : mode === "albums" ? "Albums" : "Music";

export const renderStudioView = () => {
  const server = currentServerInfo();

  return `
    <section class="studio-shell" data-studio-app>
      <header class="studio-top-nav">
        <button class="studio-brand" type="button" data-studio-tab="library" aria-label="Studio library">
          <img src="${studioBrandMarkUrl}" alt="" aria-hidden="true" />
          <strong>Nebula Studio</strong>
        </button>
        <nav class="studio-section-nav" aria-label="Studio sections">
          <button class="active" type="button" data-studio-tab="library" aria-pressed="true">Library</button>
          <button type="button" data-studio-tab="artists" aria-pressed="false">Artists</button>
          <button type="button" data-studio-tab="albums" aria-pressed="false">Albums</button>
          <span aria-disabled="true" data-studio-list-summary>Playlists</span>
        </nav>
        <label class="studio-search">
          ${renderStudioIcon("Search")}
          <span class="visually-hidden">Search your music</span>
          <input type="search" data-studio-search placeholder="Search your music" />
        </label>
        <span class="studio-nav-status"><i class="studio-status-dot ${server.online ? "online" : "offline"}"></i>${server.online ? "Server Online" : "Server Offline"}</span>
        <button class="studio-dashboard-command" type="button" data-studio-action="home">${renderStudioIcon("LayoutDashboard")} Dashboard</button>
        <button class="studio-icon-command" type="button" data-studio-action="home" aria-label="Close Studio" title="Close">${renderStudioIcon("X")}</button>
      </header>
      <main class="studio-content" data-studio-content>
        <div class="studio-empty">
          <img src="${studioBrandMarkUrl}" alt="" aria-hidden="true" />
          <strong>Loading music</strong>
          <span>Scanning content for audio files.</span>
        </div>
      </main>
      <div class="studio-dialog-host" data-studio-dialog-host hidden></div>
      <section class="studio-mini-player" data-studio-mini-player aria-label="Now playing" hidden>
        <audio data-studio-player preload="metadata"></audio>
        <div data-studio-mini-content></div>
      </section>
      <footer class="studio-footer" data-studio-footer></footer>
    </section>
  `;
};

export const bindStudioView = (container: ParentNode, onHome?: () => void, options: { personalPlayback?: boolean } = {}) => {
  const app = container.querySelector<HTMLElement>("[data-studio-app]");
  const content = container.querySelector<HTMLElement>("[data-studio-content]");
  const footer = container.querySelector<HTMLElement>("[data-studio-footer]");
  const dialogHost = container.querySelector<HTMLElement>("[data-studio-dialog-host]");
  const miniPlayer = container.querySelector<HTMLElement>("[data-studio-mini-player]");
  const miniContent = container.querySelector<HTMLElement>("[data-studio-mini-content]");
  const audioPlayer = container.querySelector<HTMLAudioElement>("[data-studio-player]")!;

  if (!app || !content || !footer || !dialogHost || !miniPlayer || !miniContent || !audioPlayer) {
    return;
  }

  let entries: MusicEntry[] = [];
  let selected: MusicEntry | null = null;
  let libraryScope: StudioLibraryScope | null = null;
  let browseMode: StudioBrowseMode = "library";
  let query = "";
  let isScanning = false;
  let loadError = "";
  let playingEntry: MusicEntry | null = null;
  let playerCleanup: (() => void) | null = null;
  let playlists: MediaList[] = [];
  let collections: MediaList[] = [];
  let history = new Map<string, PlaybackHistoryEntry>();
  let pendingResume: { entry: MusicEntry; state: PlaybackHistoryEntry } | null = null;
  const personalPlayback = options.personalPlayback !== false;
  const playbackDeviceId = createBrowserUuid();

  const visibleEntries = () =>
    query
      ? entries.filter((entry) =>
          `${entry.title} ${entry.name} ${entry.folder} ${entry.artist} ${entry.album} ${entry.genres.join(" ")}`
            .toLowerCase()
            .includes(query.toLowerCase())
        )
      : entries;

  const renderFooter = () => {
    const server = currentServerInfo();
    const now = new Date();

    footer.innerHTML = `
      <span><i class="studio-status-dot ${server.online ? "online" : "offline"}"></i>${server.online ? "Server Online" : "Server Offline"}</span>
      <span>${escapeHtml(server.name)} / ${escapeHtml(server.address)}</span>
      <span>${pluralizeTracks(entries.length)}</span>
      <time>${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
    `;
  };

  const renderTabState = () => {
    app.querySelectorAll<HTMLButtonElement>("[data-studio-tab]").forEach((button) => {
      const isActive = button.dataset.studioTab === browseMode;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
    const summary = app.querySelector<HTMLElement>("[data-studio-list-summary]");
    if (summary) summary.textContent = `${playlists.length} playlists / ${collections.length} collections`;
  };

  const saveSelectedToPlaylist = async (button: HTMLButtonElement) => {
    if (!selected?.id) return;
    button.disabled = true;
    try {
      let playlist = playlists[0];
      if (!playlist) playlist = (await createMediaList("playlist", "Studio Favorites", "audio")).list;
      playlist = (await addMediaListItem("playlist", playlist.id, selected.id)).list;
      playlists = [playlist, ...playlists.filter(({ id }) => id !== playlist.id)];
      button.textContent = "Saved to playlist";
    } catch (error) { button.textContent = error instanceof Error && /already/i.test(error.message) ? "Already in playlist" : "Could not save"; }
    finally { button.disabled = false; }
  };

  let setPlayerEntry: (entry: MusicEntry, force?: boolean) => void = () => undefined;
  let playPlayerAt: (positionSeconds?: number) => void = () => undefined;
  let syncPlayerUi: () => void = () => undefined;

  const bindPlayer = () => {
    type PlaybackSession = {
      ended: boolean;
      entry: MusicEntry;
      lastProgressAt: number;
      lifecycleStarted: boolean;
      sessionId: string | null;
    };

    let playbackSession: PlaybackSession | null = null;
    let clusterDeliveryId: string | null = null;
    let clusterDeliveryNodeId: string | null = null;
    let clusterDeliverySourceId: string | null = null;
    let failoverPending = false;
    let preparationController: AbortController | null = null;
    let playerRequestGeneration = 0;
    let playerReady = Promise.resolve();
    let eventQueue = Promise.resolve();
    let statusMessage = "Ready to play.";
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const levels = new Float32Array(192);
    let audioContext: AudioContext | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let spectrum: Uint8Array<ArrayBuffer> | null = null;
    let animationFrame = 0;
    let disposed = false;

    const setStatus = (message: string) => {
      statusMessage = message;
      app.querySelectorAll<HTMLElement>("[data-studio-player-status]").forEach((status) => {
        status.textContent = message;
      });
    };

    syncPlayerUi = () => {
      const duration = Number.isFinite(audioPlayer.duration) && audioPlayer.duration > 0 ? audioPlayer.duration : 0;
      const progress = duration ? Math.min(1000, Math.round((audioPlayer.currentTime / duration) * 1000)) : 0;
      const isPlaying = !audioPlayer.paused && !audioPlayer.ended;
      const currentIndex = entries.findIndex((entry) => entry.path === playingEntry?.path);

      app.classList.toggle("has-player", Boolean(playingEntry));
      miniPlayer.hidden = !playingEntry || Boolean(selected);
      app.querySelectorAll<HTMLElement>("[data-studio-current-time]").forEach((time) => { time.textContent = formatTime(audioPlayer.currentTime); });
      app.querySelectorAll<HTMLElement>("[data-studio-duration]").forEach((time) => { time.textContent = formatTime(duration); });
      app.querySelectorAll<HTMLInputElement>("[data-studio-seek]").forEach((seek) => {
        if (document.activeElement !== seek) seek.value = String(progress);
        seek.style.setProperty("--studio-progress", `${progress / 10}%`);
      });
      app.querySelectorAll<HTMLButtonElement>("[data-studio-play-toggle]").forEach((button) => {
        button.innerHTML = renderStudioIcon(isPlaying ? "Pause" : "Play");
        button.setAttribute("aria-label", isPlaying ? "Pause track" : "Play track");
        button.setAttribute("aria-pressed", String(isPlaying));
      });
      app.querySelectorAll<HTMLButtonElement>("[data-studio-action='previous']").forEach((button) => { button.disabled = currentIndex <= 0; });
      app.querySelectorAll<HTMLButtonElement>("[data-studio-action='next']").forEach((button) => { button.disabled = currentIndex < 0 || currentIndex >= entries.length - 1; });
      app.querySelectorAll<HTMLInputElement>("[data-studio-volume]").forEach((volume) => {
        if (document.activeElement !== volume) volume.value = String(audioPlayer.volume);
        volume.style.setProperty("--studio-volume", `${audioPlayer.volume * 100}%`);
      });
      app.querySelectorAll<HTMLButtonElement>("[data-studio-mute-toggle]").forEach((button) => {
        const muted = audioPlayer.muted || audioPlayer.volume === 0;
        button.innerHTML = renderStudioIcon(muted ? "VolumeX" : "Volume2");
        button.setAttribute("aria-label", muted ? "Unmute" : "Mute");
        button.setAttribute("aria-pressed", String(muted));
      });
      setStatus(statusMessage);
    };

    const report = (session: PlaybackSession, event: PlaybackEventKind) => {
      if (!personalPlayback || !session.entry.id || (!session.entry.sourceId && !clusterDeliverySourceId)) return;
      if (event === "start") session.lifecycleStarted = true;
      const durationSeconds = Number.isFinite(audioPlayer.duration) && audioPlayer.duration > 0 ? audioPlayer.duration : null;
      const positionSeconds = durationSeconds === null ? Math.max(0, audioPlayer.currentTime || 0) : Math.min(durationSeconds, Math.max(0, audioPlayer.currentTime || 0));
      eventQueue = eventQueue.then(async () => {
        if (event !== "start" && !session.sessionId) return;
        const identity = session.entry.sourceId
          ? { itemId: session.entry.id!, sourceId: session.entry.sourceId }
          : { federatedIdentity: { itemId: session.entry.id!, sourceId: clusterDeliverySourceId! } };
        const result = await reportStudioPlayback({
          durationSeconds,
          event,
          eventId: createBrowserUuid(),
          ...identity,
          positionSeconds,
          sessionId: session.sessionId
        });
        session.sessionId = result.session.id;
        if (result.state.lastPlayedAt) {
          history.set(session.entry.id!, {
            completed: result.state.completed,
            durationSeconds: result.state.durationSeconds,
            itemId: session.entry.id!,
            lastPlayedAt: result.state.lastPlayedAt,
            playCount: result.state.playCount,
            positionSeconds: result.state.positionSeconds,
            progress: result.state.durationSeconds ? result.state.positionSeconds / result.state.durationSeconds : 0,
            sourceId: result.state.sourceId
          });
          if (!selected) render();
        }
      }).catch(() => setStatus("Playing locally; listening history is unavailable."));
    };

    const stopSession = () => {
      if (playbackSession && !playbackSession.ended && playbackSession.lifecycleStarted) {
        playbackSession.ended = true;
        report(playbackSession, "stop");
      }
    };

    const releaseClusterDelivery = () => {
      preparationController?.abort();
      preparationController = null;
      const id = clusterDeliveryId;
      clusterDeliveryId = null;
      clusterDeliveryNodeId = null;
      clusterDeliverySourceId = null;
      if (id) void cancelClusterMusicDelivery(id).catch(() => undefined);
    };

    setPlayerEntry = (entry: MusicEntry, force = false) => {
      if (entry.playable === false || (!entry.streamUrl && (!entry.id || !entry.federation))) return;
      if (!force && playingEntry?.path === entry.path) return;
      const requestGeneration = ++playerRequestGeneration;
      stopSession();
      releaseClusterDelivery();
      audioPlayer.pause();
      audioPlayer.removeAttribute("src");
      playingEntry = entry;
      playbackSession = { ended: false, entry, lastProgressAt: 0, lifecycleStarted: false, sessionId: null };
      miniContent.innerHTML = renderMiniPlayer(entry);
      const remote = !entry.sourceId && Boolean(entry.federation);
      statusMessage = remote ? "Connecting to an available shard…" : "Ready to play.";
      playerReady = remote
        ? createClusterMusicDelivery({
            capabilities: studioPlaybackCapabilities(audioPlayer, playbackDeviceId),
            federatedItemId: entry.id!,
            preferredProfileId: "original",
            startPositionSeconds: null
          }).then(async (created) => {
            if (disposed || requestGeneration !== playerRequestGeneration || playingEntry?.path !== entry.path) {
              void cancelClusterMusicDelivery(created.session.id).catch(() => undefined);
              return;
            }
            const controller = new AbortController();
            preparationController = controller;
            const current = await pollDeliveryUntilReady({
              initial: created,
              getStatus: getClusterMusicDelivery,
              cancel: cancelClusterMusicDelivery,
              signal: controller.signal
            }).finally(() => {
              if (preparationController === controller) preparationController = null;
            });
            clusterDeliveryId = current.session.id;
            clusterDeliveryNodeId = current.session.candidate.nodeId;
            clusterDeliverySourceId = current.session.candidate.sourceId;
            audioPlayer.src = apiUrl(current.session.deliveryUrl);
            audioPlayer.load();
            statusMessage = "Ready from a remote shard.";
            syncPlayerUi();
          }).catch((error) => {
            if (requestGeneration !== playerRequestGeneration) return;
            statusMessage = error instanceof Error ? error.message : "Remote playback could not be started.";
            syncPlayerUi();
            throw error;
          })
        : Promise.resolve().then(() => {
            audioPlayer.src = entry.streamUrl;
            audioPlayer.load();
          });
      syncPlayerUi();
    };

    playPlayerAt = (positionSeconds = 0) => {
      if (!playingEntry) return;
      const beginPlayback = () => {
        if (Number.isFinite(audioPlayer.duration) && positionSeconds < audioPlayer.duration) audioPlayer.currentTime = Math.max(0, positionSeconds);
        void audioPlayer.play().catch(() => setStatus("Ready to play. Select play again if this browser blocked playback."));
      };
      void playerReady.then(() => {
        if (!audioPlayer.src) return;
        if (positionSeconds > 0 && audioPlayer.readyState < 1) audioPlayer.addEventListener("loadedmetadata", beginPlayback, { once: true });
        else beginPlayback();
      }).catch(() => undefined);
    };

    async function activateAnalyser() {
      if (disposed || !window.AudioContext) return;
      try {
        if (!audioContext) {
          audioContext = new AudioContext();
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 4096;
          analyser.minDecibels = -86;
          analyser.maxDecibels = -18;
          analyser.smoothingTimeConstant = 0.76;
          source = audioContext.createMediaElementSource(audioPlayer);
          source.connect(analyser);
          analyser.connect(audioContext.destination);
          spectrum = new Uint8Array(analyser.frequencyBinCount);
        }
        if (audioContext.state === "suspended") await audioContext.resume();
      } catch {
        analyser = null;
        spectrum = null;
      }
    }

    const onPlay = () => {
      if (playbackSession?.ended && playingEntry) {
        playbackSession = {
          ended: false,
          entry: playingEntry,
          lastProgressAt: 0,
          lifecycleStarted: false,
          sessionId: null
        };
      }
      setStatus("Playback requested.");
      void activateAnalyser();
      if (playbackSession && !playbackSession.lifecycleStarted) report(playbackSession, "start");
      syncPlayerUi();
    };
    const onPlaying = () => {
      setStatus(clusterDeliveryId ? "Playing directly from a Nebula shard." : "Playing from the local Studio server.");
      syncPlayerUi();
    };
    const onPause = () => {
      setStatus("Paused.");
      if (playbackSession && !playbackSession.ended && playbackSession.lifecycleStarted) report(playbackSession, "pause");
      syncPlayerUi();
    };
    const onEnded = () => {
      if (playbackSession) { playbackSession.ended = true; report(playbackSession, "complete"); }
      setStatus("Finished.");
      syncPlayerUi();
    };
    const onTimeUpdate = () => {
      if (playbackSession?.sessionId && Date.now() - playbackSession.lastProgressAt >= 10_000) {
        playbackSession.lastProgressAt = Date.now();
        report(playbackSession, "progress");
      }
      syncPlayerUi();
    };
    const onStalled = () => setStatus("Playback is waiting for more data from the server.");
    const onError = async () => {
      if (!clusterDeliveryId || !clusterDeliveryNodeId || failoverPending) {
        if (!failoverPending) setStatus("This audio file could not be played here. The browser may not support this format, especially some FLAC files.");
        return;
      }
      failoverPending = true;
      const deliveryId = clusterDeliveryId;
      const position = Number.isFinite(audioPlayer.currentTime) ? audioPlayer.currentTime : 0;
      setStatus("The active shard stopped responding. Finding an exact replica…");
      try {
        preparationController?.abort();
        const controller = new AbortController();
        preparationController = controller;
        const initial = await failoverClusterMusicDelivery(deliveryId, clusterDeliveryNodeId);
        const replacement = await pollDeliveryUntilReady({
          initial,
          getStatus: getClusterMusicDelivery,
          cancel: cancelClusterMusicDelivery,
          signal: controller.signal
        }).finally(() => {
          if (preparationController === controller) preparationController = null;
        });
        if (disposed || clusterDeliveryId !== replacement.session.id) {
          void cancelClusterMusicDelivery(replacement.session.id).catch(() => undefined);
          return;
        }
        clusterDeliveryNodeId = replacement.session.candidate.nodeId;
        clusterDeliverySourceId = replacement.session.candidate.sourceId;
        audioPlayer.src = apiUrl(replacement.session.deliveryUrl);
        audioPlayer.load();
        const resume = () => {
          if (Number.isFinite(audioPlayer.duration) && position < audioPlayer.duration) audioPlayer.currentTime = Math.max(0, position);
          void audioPlayer.play().catch(() => setStatus("Replica ready. Press Play to resume."));
        };
        if (audioPlayer.readyState < 1) audioPlayer.addEventListener("loadedmetadata", resume, { once: true });
        else resume();
        setStatus(`Switched to ${replacement.session.candidate.nodeName ?? "an exact replica"}.`);
      } catch {
        setStatus("The active shard is unavailable and no exact replica could resume this track.");
      } finally {
        failoverPending = false;
      }
    };

    audioPlayer.addEventListener("durationchange", syncPlayerUi);
    audioPlayer.addEventListener("ended", onEnded);
    audioPlayer.addEventListener("error", onError);
    audioPlayer.addEventListener("pause", onPause);
    audioPlayer.addEventListener("play", onPlay);
    audioPlayer.addEventListener("playing", onPlaying);
    audioPlayer.addEventListener("stalled", onStalled);
    audioPlayer.addEventListener("timeupdate", onTimeUpdate);
    audioPlayer.addEventListener("volumechange", syncPlayerUi);

    const drawVisualizer = (timestamp: number) => {
      if (disposed) return;
      const visualizer = content.querySelector<HTMLCanvasElement>("[data-studio-visualizer]");
      const context = visualizer?.getContext("2d");
      if (!visualizer || !context) {
        animationFrame = window.requestAnimationFrame(drawVisualizer);
        return;
      }

      const bounds = visualizer.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const canvasWidth = Math.max(1, Math.round(bounds.width * pixelRatio));
      const canvasHeight = Math.max(1, Math.round(bounds.height * pixelRatio));
      if (visualizer.width !== canvasWidth || visualizer.height !== canvasHeight) {
        visualizer.width = canvasWidth;
        visualizer.height = canvasHeight;
      }
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      const height = bounds.height;
      const width = bounds.width;
      const isPlaying = !audioPlayer.paused && !audioPlayer.ended && !audioPlayer.error;
      const isReactive = isPlaying && Boolean(analyser && spectrum && audioContext?.state === "running");
      visualizer.dataset.studioVisualizerMode = isReactive ? "reactive" : isPlaying ? "ambient-playback" : "ambient";

      let fftEnergy = 0;
      const nyquistFrequency = (audioContext?.sampleRate ?? 48_000) / 2;
      const minimumFrequency = spectrum ? Math.max(20, nyquistFrequency / spectrum.length) : 20;
      const maximumFrequency = Math.min(20_000, nyquistFrequency * 0.98);
      const frequencyRatio = maximumFrequency / minimumFrequency;

      if (isReactive && analyser && spectrum) {
        analyser.getByteFrequencyData(spectrum);
        let sumOfSquares = 0;
        const audibleBinCount = Math.max(
          1,
          Math.min(spectrum.length, Math.ceil((maximumFrequency / nyquistFrequency) * spectrum.length))
        );

        for (let bin = 1; bin < audibleBinCount; bin += 1) {
          sumOfSquares += spectrum[bin] * spectrum[bin];
        }

        fftEnergy = Math.min(1, Math.sqrt(sumOfSquares / audibleBinCount) / 255);
      }

      visualizer.dataset.studioVisualizerEnergy = fftEnergy.toFixed(3);

      context.clearRect(0, 0, width, height);
      const barCount = Math.max(64, Math.min(levels.length, Math.floor(width / 3)));
      const gap = width < 420 ? 1.25 : 1.5;
      const barWidth = Math.max(1, (width - gap * (barCount - 1)) / barCount);
      visualizer.dataset.studioVisualizerBars = String(barCount);
      visualizer.dataset.studioVisualizerMinimumFrequency = String(Math.round(minimumFrequency));
      visualizer.dataset.studioVisualizerMaximumFrequency = String(Math.round(maximumFrequency));
      const center = height / 2;
      const maximumBarHeight = Math.max(16, height - 14);
      const ambientTime = reduceMotion ? 0 : timestamp * (isPlaying ? 0.0026 : 0.00125);
      const duration = Number.isFinite(audioPlayer.duration) && audioPlayer.duration > 0 ? audioPlayer.duration : 0;
      const progress = duration ? Math.min(1, audioPlayer.currentTime / duration) : isPlaying ? 0.58 : 0.34;

      for (let index = 0; index < barCount; index += 1) {
        const position = index / Math.max(1, barCount - 1);
        let target = 0;

        if (isReactive && spectrum) {
          const lowerFrequency = minimumFrequency * Math.pow(frequencyRatio, index / barCount);
          const upperFrequency = minimumFrequency * Math.pow(frequencyRatio, (index + 1) / barCount);
          const bucketStart = Math.min(
            spectrum.length - 1,
            Math.max(1, Math.floor((lowerFrequency / nyquistFrequency) * spectrum.length))
          );
          const bucketEnd = Math.min(
            spectrum.length,
            Math.max(bucketStart + 1, Math.ceil((upperFrequency / nyquistFrequency) * spectrum.length))
          );
          let bucketSquares = 0;
          let bucketPeak = 0;

          for (let bin = bucketStart; bin < bucketEnd; bin += 1) {
            const magnitude = spectrum[bin];
            bucketSquares += magnitude * magnitude;
            bucketPeak = Math.max(bucketPeak, magnitude);
          }

          const bucketSize = Math.max(1, bucketEnd - bucketStart);
          const bucketRms = Math.sqrt(bucketSquares / bucketSize) / 255;
          const bucketPeakLevel = bucketPeak / 255;
          const lowFrequencyLift = 1 + (1 - position) * 0.12;
          const bandMagnitude = (bucketRms * 0.74 + bucketPeakLevel * 0.26) * lowFrequencyLift;
          target = Math.min(1, Math.pow(bandMagnitude, 0.74));
        } else {
          const primaryWave = (Math.sin(ambientTime + index * 0.57) + 1) / 2;
          const secondaryWave = (Math.sin(ambientTime * 0.68 - index * 0.23) + 1) / 2;
          const travellingPulse = Math.pow((Math.sin(ambientTime * 0.44 + position * Math.PI * 3.4) + 1) / 2, 3);
          const energy = isPlaying ? 0.36 : 0.2;
          target = 0.08 + primaryWave * energy * 0.48 + secondaryWave * energy * 0.28 + travellingPulse * energy;
        }

        const response = target > levels[index] ? 0.48 : 0.12;
        levels[index] += (target - levels[index]) * response;
        const magnitude = Math.max(0.055, Math.min(1, levels[index]));
        const renderedHeight = Math.max(4, magnitude * maximumBarHeight);
        const x = index * (barWidth + gap);
        const y = center - renderedHeight / 2;
        const played = position <= progress;

        context.fillStyle = played
          ? `rgba(255, ${Math.round(177 + magnitude * 48)}, ${Math.round(70 + magnitude * 34)}, ${0.56 + magnitude * 0.42})`
          : `rgba(137, 151, 166, ${0.18 + magnitude * 0.36})`;
        context.shadowBlur = isReactive && played ? 8 + magnitude * 10 : 0;
        context.shadowColor = "rgba(255, 184, 70, 0.58)";
        context.fillRect(x, y, barWidth, renderedHeight);
      }

      context.shadowBlur = 0;
      animationFrame = window.requestAnimationFrame(drawVisualizer);
    };

    function cleanup() {
      if (disposed) return;
      disposed = true;
      playerRequestGeneration += 1;
      stopSession();
      releaseClusterDelivery();
      audioPlayer.pause();
      window.cancelAnimationFrame(animationFrame);
      audioPlayer.removeEventListener("durationchange", syncPlayerUi);
      audioPlayer.removeEventListener("ended", onEnded);
      audioPlayer.removeEventListener("error", onError);
      audioPlayer.removeEventListener("pause", onPause);
      audioPlayer.removeEventListener("play", onPlay);
      audioPlayer.removeEventListener("playing", onPlaying);
      audioPlayer.removeEventListener("stalled", onStalled);
      audioPlayer.removeEventListener("timeupdate", onTimeUpdate);
      audioPlayer.removeEventListener("volumechange", syncPlayerUi);
      window.removeEventListener("pagehide", cleanup);
      source?.disconnect();
      analyser?.disconnect();
      void audioContext?.close().catch(() => undefined);
    }

    window.addEventListener("pagehide", cleanup, { once: true });
    animationFrame = window.requestAnimationFrame(drawVisualizer);
    return cleanup;
  };

  const render = () => {
    const visible = visibleEntries();
    const scopedEntries = libraryScope
      ? visible.filter((entry) => libraryScope?.tracks.some((track) => track.path === entry.path))
      : visible;
    const libraryItems = libraryItemsFor(scopedEntries, browseMode, libraryScope);
    content.classList.toggle("has-selection", Boolean(selected));
    content.classList.toggle("scanning", isScanning);

    if (selected) {
      content.innerHTML = `<section class="studio-player-panel">${renderNowPlaying(selected, entries)}</section>`;
    } else if (loadError) {
      content.innerHTML = `
        <div class="studio-empty">
          <img src="${studioBrandMarkUrl}" alt="" aria-hidden="true" />
          <strong>Music unavailable</strong>
          <span>${escapeHtml(loadError)}</span>
        </div>
      `;
    } else {
      content.innerHTML = `
        <section class="studio-library">
          <header>
            <div>
              <p class="eyebrow">${escapeHtml(libraryScope?.kind ?? (isScanning ? "Scanning" : browseMode))}</p>
              <h1>${escapeHtml(libraryScope?.label ?? browseLabel(browseMode))}</h1>
              <p>${
                libraryScope
                  ? `Browsing ${pluralizeTracks(scopedEntries.length)} in this ${escapeHtml(libraryScope.kind)}.`
                  : "Your local collection, organized for fast playback."
              }</p>
            </div>
            <span>${isScanning ? "Refreshing library" : pluralizeTracks(scopedEntries.length)}</span>
          </header>
          ${
            libraryScope
              ? `<button class="studio-back-command" type="button" data-studio-action="library-root">${renderStudioIcon("ArrowLeft")} Back to ${escapeHtml(browseLabel(browseMode))}</button>`
              : ""
          }
          ${personalPlayback ? renderPlaybackHistory(scopedEntries, history) : ""}
          <div class="studio-track-list">${renderLibraryItems(libraryItems, selected)}</div>
        </section>
      `;
    }

    renderTabState();
    renderFooter();
    syncPlayerUi();
  };

  const closeResumePrompt = () => {
    pendingResume = null;
    dialogHost.hidden = true;
    dialogHost.innerHTML = "";
    content.scrollTop = 0;
    queueMicrotask(() => content.querySelector<HTMLButtonElement>("[data-studio-play-toggle]")?.focus({ preventScroll: true }));
  };

  const playSelected = (positionSeconds = 0, restartSession = false) => {
    if (!selected || selected.playable === false) return;
    setPlayerEntry(selected, restartSession);
    playPlayerAt(positionSeconds);
  };

  const selectTrack = (entry: MusicEntry, autoplay = false) => {
    selected = entry;
    if (entry.playable !== false) setPlayerEntry(entry);
    render();
    content.scrollTop = 0;

    const resumable = personalPlayback && entry.id ? history.get(entry.id) : undefined;
    if (resumable && !resumable.completed && resumable.positionSeconds > 0) {
      pendingResume = { entry, state: resumable };
      dialogHost.hidden = false;
      dialogHost.innerHTML = renderResumeDialog(entry, resumable);
      queueMicrotask(() => dialogHost.querySelector<HTMLButtonElement>("[data-studio-action='resume-play']")?.focus());
      return;
    }

    if (autoplay) playSelected();
  };

  const selectAdjacentTrack = (offset: -1 | 1) => {
    const current = playingEntry ?? selected;
    if (!current) {
      return;
    }

    const playableEntries = entries.filter((entry) => entry.playable !== false);
    const playableIndex = playableEntries.findIndex((entry) => entry.path === current.path);
    const next = playableEntries[playableIndex + offset];

    if (next) {
      selectTrack(next, true);
    }
  };

  const loadLibrary = async () => {
    isScanning = true;
    loadError = "";
    render();

    try {
      const [library, playbackHistory] = await Promise.all([
        listMusicLibrary(),
        personalPlayback ? listStudioPlaybackHistory() : Promise.resolve({ entries: [] })
      ]);
      entries = library.entries;
      history = new Map(playbackHistory.entries.map((entry) => [entry.itemId, entry]));
      selected = selected ? entries.find((entry) => entry.path === selected?.path) ?? null : null;
    } catch (error) {
      loadError = error instanceof Error ? error.message : "Unable to scan content.";
    } finally {
      isScanning = false;
      render();
    }
  };

  app.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const tabButton = target.closest<HTMLButtonElement>("[data-studio-tab]");
    const actionButton = target.closest<HTMLButtonElement>("[data-studio-action]");
    const pathButton = target.closest<HTMLButtonElement>("[data-studio-path]");

    if (tabButton) {
      const mode = tabButton.dataset.studioTab;

      if (mode === "library" || mode === "artists" || mode === "albums") {
        browseMode = mode;
        libraryScope = null;
        selected = null;
        render();
        content.scrollTop = 0;
      }
      return;
    }

    if (actionButton?.dataset.studioAction === "home") {
      closeResumePrompt();
      playerCleanup?.();
      playerCleanup = null;
      onHome?.();
      return;
    }

    if (actionButton?.dataset.studioAction === "library") {
      closeResumePrompt();
      selected = null;
      render();
      content.scrollTop = 0;
      return;
    }

    if (actionButton?.dataset.studioAction === "library-root") {
      closeResumePrompt();
      selected = null;
      libraryScope = null;
      render();
      content.scrollTop = 0;
      return;
    }

    if (actionButton?.dataset.studioAction === "previous") {
      selectAdjacentTrack(-1);
      return;
    }

    if (actionButton?.dataset.studioAction === "next") {
      selectAdjacentTrack(1);
      return;
    }

    if (actionButton?.dataset.studioAction === "open-player" && playingEntry) {
      selected = playingEntry;
      render();
      content.scrollTop = 0;
      return;
    }

    if (actionButton?.dataset.studioAction === "toggle-play") {
      if (!playingEntry && selected) setPlayerEntry(selected);
      if (!playingEntry) return;
      if (audioPlayer.paused || audioPlayer.ended) playPlayerAt(audioPlayer.ended ? 0 : audioPlayer.currentTime);
      else audioPlayer.pause();
      return;
    }

    if (actionButton?.dataset.studioAction === "toggle-mute") {
      audioPlayer.muted = !audioPlayer.muted;
      syncPlayerUi();
      return;
    }

    if (actionButton?.dataset.studioAction === "close-resume") { closeResumePrompt(); return; }
    if (actionButton?.dataset.studioAction === "resume-play" || actionButton?.dataset.studioAction === "restart-play") {
      const request = pendingResume;
      if (!request) return;
      const position = actionButton.dataset.studioAction === "resume-play" ? request.state.positionSeconds : 0;
      selected = request.entry;
      closeResumePrompt();
      playSelected(position, true);
      return;
    }

    if (actionButton?.dataset.studioAction === "save-playlist") { void saveSelectedToPlaylist(actionButton); return; }

    const groupButton = target.closest<HTMLButtonElement>("[data-studio-group]");

    if (groupButton) {
      const visible = visibleEntries();
      const scopedEntries = libraryScope
        ? visible.filter((entry) => libraryScope?.tracks.some((track) => track.path === entry.path))
        : visible;
      const group = libraryItemsFor(scopedEntries, browseMode, libraryScope)
        .filter((item): item is { group: StudioLibraryGroup; itemKind: "group" } => item.itemKind === "group")
        .map((item) => item.group)
        .find((candidate) => candidate.id === groupButton.dataset.studioGroup);

      if (group) {
        libraryScope = {
          kind: group.kind,
          label: group.label,
          tracks: group.tracks
        };
        render();
        content.scrollTop = 0;
      }
      return;
    }

    if (pathButton) {
      const entry = entries.find((candidate) => candidate.path === pathButton.dataset.studioPath);

      if (entry) {
        selectTrack(entry, false);
      }
    }
  });

  app.addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    const seek = target.closest<HTMLInputElement>("[data-studio-seek]");

    if (seek) {
      const duration = Number.isFinite(audioPlayer.duration) ? audioPlayer.duration : 0;
      if (duration > 0) audioPlayer.currentTime = (Number(seek.value) / 1000) * duration;
      syncPlayerUi();
      return;
    }

    const volume = target.closest<HTMLInputElement>("[data-studio-volume]");

    if (volume) {
      audioPlayer.volume = Number(volume.value);
      audioPlayer.muted = false;
      syncPlayerUi();
      return;
    }

    const input = target.closest<HTMLInputElement>("[data-studio-search]");

    if (input) {
      query = input.value.trim();
      selected = null;
      libraryScope = null;
      render();
      content.scrollTop = 0;
      input.focus();
    }
  });

  playerCleanup = bindPlayer();
  render();
  void Promise.all([listMediaLists("playlist", "audio"), listMediaLists("collection", "audio")]).then(([personal, shared]) => {
    playlists = personal.lists; collections = shared.lists; render();
  }).catch(() => {});
  void loadLibrary();
};
