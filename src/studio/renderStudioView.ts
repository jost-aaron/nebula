import { createElement, icons } from "lucide";
import { getApiConnectionMode, getEffectiveApiBaseUrl, getApiToken } from "../api/http";
import { listMusicLibrary, listStudioPlaybackHistory, reportStudioPlayback } from "../api/musicApi";
import type { MusicEntry } from "../shared/musicTypes";
import { addMediaListItem, createMediaList, listMediaLists } from "../api/mediaListsApi";
import type { MediaList } from "../shared/mediaListTypes";
import type { PlaybackEventKind, PlaybackHistoryEntry } from "../shared/playbackTypes";

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
          <em>${escapeHtml(formatAudioFormat(entry).replace(" audio", ""))}</em>
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
  entries.filter((entry) => entry.path !== selected?.path).slice(0, 8);

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

const renderSourceCards = (entry: MusicEntry, server: StudioServerInfo) => `
  <section class="studio-source-cards" aria-label="Track source details">
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
  </section>
`;

const renderNowPlaying = (entry: MusicEntry, entries: MusicEntry[]) => {
  const server = currentServerInfo();
  const currentIndex = entries.findIndex((candidate) => candidate.path === entry.path);
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < entries.length - 1;

  return `
    <button class="studio-back-command" type="button" data-studio-action="library">${renderStudioIcon("ArrowLeft")} Back to Library</button>
    <div class="studio-player-hero">
      <section class="studio-now">
        <div class="studio-artwork-stage">
          ${renderArtwork(entry, entry.title)}
          <span class="studio-format-chip">${escapeHtml(formatAudioFormat(entry).replace(" audio", ""))} / Local file</span>
        </div>
        <div class="studio-track-detail">
          <p class="eyebrow">Now Playing</p>
          <h2>${escapeHtml(entry.title)}</h2>
          <p class="studio-now-artist">${escapeHtml(entry.artist || "Unknown artist")}</p>
          <p class="studio-now-album">${escapeHtml(entry.album || entry.folder || "Local music")}</p>
          <div class="studio-waveform" aria-hidden="true">
            <canvas data-studio-visualizer data-studio-visualizer-mode="ambient"></canvas>
          </div>
          <audio class="studio-audio-player" data-studio-player controls preload="metadata" src="${escapeHtml(entry.streamUrl)}">
            Your browser cannot play this audio file.
          </audio>
          <div class="studio-playback-row">
            <button type="button" data-studio-action="previous" aria-label="Previous track" ${hasPrevious ? "" : "disabled"}>${renderStudioIcon("SkipBack")}</button>
            <p class="studio-player-status" data-studio-player-status>Ready from ${escapeHtml(server.name)}.</p>
            <button type="button" data-studio-action="next" aria-label="Next track" ${hasNext ? "" : "disabled"}>${renderStudioIcon("SkipForward")}</button>
          </div>
          ${entry.id ? `<button class="studio-playlist-command" type="button" data-studio-action="save-playlist">${renderStudioIcon("ListPlus")} Save to playlist</button>` : ""}
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
      <footer class="studio-footer" data-studio-footer></footer>
    </section>
  `;
};

export const bindStudioView = (container: ParentNode, onHome?: () => void, options: { personalPlayback?: boolean } = {}) => {
  const app = container.querySelector<HTMLElement>("[data-studio-app]");
  const content = container.querySelector<HTMLElement>("[data-studio-content]");
  const footer = container.querySelector<HTMLElement>("[data-studio-footer]");
  const dialogHost = container.querySelector<HTMLElement>("[data-studio-dialog-host]");

  if (!app || !content || !footer || !dialogHost) {
    return;
  }

  let entries: MusicEntry[] = [];
  let selected: MusicEntry | null = null;
  let libraryScope: StudioLibraryScope | null = null;
  let browseMode: StudioBrowseMode = "library";
  let query = "";
  let isScanning = false;
  let loadError = "";
  let playerCleanup: (() => void) | null = null;
  let playlists: MediaList[] = [];
  let collections: MediaList[] = [];
  let history = new Map<string, PlaybackHistoryEntry>();
  let pendingResume: { entry: MusicEntry; state: PlaybackHistoryEntry } | null = null;
  const personalPlayback = options.personalPlayback !== false;

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

  const bindPlayer = () => {
    const player = content.querySelector<HTMLAudioElement>("[data-studio-player]");
    const status = content.querySelector<HTMLElement>("[data-studio-player-status]");
    const visualizer = content.querySelector<HTMLCanvasElement>("[data-studio-visualizer]");

    if (!player || !status) {
      return () => undefined;
    }

    const audioPlayer = player;
    const playerStatus = status;
    const playingEntry = selected;
    let sessionId: string | null = null;
    let lifecycleStarted = false;
    let ended = false;
    let lastProgressAt = 0;
    let eventQueue = Promise.resolve();

    const setStatus = (message: string) => {
      playerStatus.textContent = message;
    };

    const report = (event: PlaybackEventKind) => {
      if (!personalPlayback || !playingEntry?.id || !playingEntry.sourceId) return;
      if (event === "start") lifecycleStarted = true;
      const durationSeconds = Number.isFinite(audioPlayer.duration) && audioPlayer.duration > 0 ? audioPlayer.duration : null;
      const positionSeconds = durationSeconds === null ? Math.max(0, audioPlayer.currentTime || 0) : Math.min(durationSeconds, Math.max(0, audioPlayer.currentTime || 0));
      eventQueue = eventQueue.then(async () => {
        if (event !== "start" && !sessionId) return;
        const result = await reportStudioPlayback({
          durationSeconds,
          event,
          eventId: crypto.randomUUID(),
          itemId: playingEntry.id!,
          positionSeconds,
          sessionId,
          sourceId: playingEntry.sourceId!
        });
        sessionId = result.session.id;
        if (result.state.lastPlayedAt) {
          history.set(playingEntry.id!, {
            completed: result.state.completed,
            durationSeconds: result.state.durationSeconds,
            itemId: playingEntry.id!,
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

    const onPlay = () => {
      setStatus("Playback requested.");
      void activateAnalyser();
      if (!lifecycleStarted) report("start");
    };
    const onPlaying = () => {
      setStatus("Playing from the local Studio server.");
      void activateAnalyser();
    };
    const onPause = () => { setStatus("Paused."); if (!ended && lifecycleStarted) report("pause"); };
    const onEnded = () => { ended = true; setStatus("Finished."); report("complete"); };
    const onTimeUpdate = () => {
      if (sessionId && Date.now() - lastProgressAt >= 10_000) {
        lastProgressAt = Date.now();
        report("progress");
      }
    };
    const onStalled = () => setStatus("Playback is waiting for more data from the server.");
    const onError = () =>
      setStatus("This audio file could not be played here. The browser may not support this format, especially some FLAC files.");

    audioPlayer.addEventListener("play", onPlay);
    audioPlayer.addEventListener("playing", onPlaying);
    audioPlayer.addEventListener("pause", onPause);
    audioPlayer.addEventListener("ended", onEnded);
    audioPlayer.addEventListener("stalled", onStalled);
    audioPlayer.addEventListener("error", onError);
    audioPlayer.addEventListener("timeupdate", onTimeUpdate);

    const stopPlayback = () => {
      if (!ended && lifecycleStarted) {
        ended = true;
        report("stop");
      }
      window.removeEventListener("pagehide", stopPlayback);
    };
    const removePlayerListeners = () => {
      stopPlayback();
      audioPlayer.removeEventListener("play", onPlay);
      audioPlayer.removeEventListener("playing", onPlaying);
      audioPlayer.removeEventListener("pause", onPause);
      audioPlayer.removeEventListener("ended", onEnded);
      audioPlayer.removeEventListener("stalled", onStalled);
      audioPlayer.removeEventListener("error", onError);
      audioPlayer.removeEventListener("timeupdate", onTimeUpdate);
    };
    window.addEventListener("pagehide", stopPlayback, { once: true });

    const context = visualizer?.getContext("2d");

    if (!visualizer || !context) {
      return removePlayerListeners;
    }

    const mediaUrl = new URL(audioPlayer.currentSrc || audioPlayer.src, window.location.href);
    const canAnalyseAudio = mediaUrl.origin === window.location.origin && Boolean(window.AudioContext);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const levels = new Float32Array(192);
    let audioContext: AudioContext | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let spectrum: Uint8Array<ArrayBuffer> | null = null;
    let animationFrame = 0;
    let disposed = false;

    async function activateAnalyser() {
      if (!canAnalyseAudio || disposed) {
        return;
      }

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

        if (audioContext.state === "suspended") {
          await audioContext.resume();
        }
      } catch {
        analyser = null;
        spectrum = null;
      }
    }

    const sizeCanvas = () => {
      const bounds = visualizer.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width * pixelRatio));
      const height = Math.max(1, Math.round(bounds.height * pixelRatio));

      if (visualizer.width !== width || visualizer.height !== height) {
        visualizer.width = width;
        visualizer.height = height;
      }

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      return { height: bounds.height, width: bounds.width };
    };

    const drawVisualizer = (timestamp: number) => {
      if (disposed) {
        return;
      }

      if (!visualizer.isConnected) {
        cleanup();
        return;
      }

      const { height, width } = sizeCanvas();
      const isPlaying = !audioPlayer.paused && !audioPlayer.ended && !audioPlayer.error;
      const isReactive = isPlaying && Boolean(analyser && spectrum && audioContext?.state === "running");
      const mode = isReactive ? "reactive" : isPlaying ? "ambient-playback" : "ambient";
      visualizer.dataset.studioVisualizerMode = mode;

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
      if (disposed) {
        return;
      }

      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      removePlayerListeners();
      source?.disconnect();
      analyser?.disconnect();
      void audioContext?.close().catch(() => undefined);
    }

    animationFrame = window.requestAnimationFrame(drawVisualizer);
    return cleanup;
  };

  const render = () => {
    playerCleanup?.();
    playerCleanup = null;
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
    playerCleanup = bindPlayer();
  };

  const closeResumePrompt = () => {
    pendingResume = null;
    dialogHost.hidden = true;
    dialogHost.innerHTML = "";
    queueMicrotask(() => content.querySelector<HTMLAudioElement>("[data-studio-player]")?.focus());
  };

  const playSelected = (positionSeconds = 0) => {
    const player = content.querySelector<HTMLAudioElement>("[data-studio-player]");
    const status = content.querySelector<HTMLElement>("[data-studio-player-status]");
    if (!player) return;
    const seek = () => {
      if (Number.isFinite(player.duration) && positionSeconds < player.duration) player.currentTime = Math.max(0, positionSeconds);
    };
    if (player.readyState >= 1) seek(); else player.addEventListener("loadedmetadata", seek, { once: true });
    void player.play().catch(() => {
      if (status) status.textContent = "Ready to play. Use the audio controls if autoplay was blocked.";
    });
  };

  const selectTrack = (entry: MusicEntry, autoplay = false) => {
    selected = entry;
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
    if (!selected) {
      return;
    }

    const index = entries.findIndex((entry) => entry.path === selected?.path);
    const next = entries[index + offset];

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

    if (actionButton?.dataset.studioAction === "close-resume") { closeResumePrompt(); return; }
    if (actionButton?.dataset.studioAction === "resume-play" || actionButton?.dataset.studioAction === "restart-play") {
      const request = pendingResume;
      if (!request) return;
      const position = actionButton.dataset.studioAction === "resume-play" ? request.state.positionSeconds : 0;
      selected = request.entry;
      closeResumePrompt();
      playSelected(position);
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
    const input = (event.target as HTMLElement).closest<HTMLInputElement>("[data-studio-search]");

    if (input) {
      query = input.value.trim();
      selected = null;
      libraryScope = null;
      render();
      content.scrollTop = 0;
      input.focus();
    }
  });

  render();
  void Promise.all([listMediaLists("playlist", "audio"), listMediaLists("collection", "audio")]).then(([personal, shared]) => {
    playlists = personal.lists; collections = shared.lists; render();
  }).catch(() => {});
  void loadLibrary();
};
