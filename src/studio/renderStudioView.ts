import { createElement, icons } from "lucide";
import { getApiConnectionMode, getEffectiveApiBaseUrl, getApiToken } from "../api/http";
import { listMusicLibrary } from "../api/musicApi";
import type { MusicEntry } from "../shared/musicTypes";

interface StudioServerInfo {
  address: string;
  authState: string;
  mode: string;
  name: string;
  online: boolean;
}

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
  kind: "album" | "artist";
  label: string;
  tracks: MusicEntry[];
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

const formatAudioFormat = (entry: MusicEntry) => {
  const extension = entry.name.split(".").pop()?.toUpperCase();
  return extension ? `${extension} audio` : "Audio file";
};

const metadataLine = (entry: MusicEntry) =>
  [entry.artist, entry.album, entry.releaseYear, entry.genres.slice(0, 2).join(", ")].filter(Boolean).join(" / ");

const currentServerInfo = (): StudioServerInfo => ({
  address: getEffectiveApiBaseUrl() || "No server URL",
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
    <div class="studio-album-art"${style}>
      ${entry?.posterUrl ? "" : `<span>${escapeHtml(initial)}</span>`}
    </div>
  `;
};

const normalizeGroupValue = (value: string) => value.trim();

const groupId = (kind: StudioLibraryGroupKind, label: string) => `${kind}:${label.toLowerCase()}`;

const pluralizeTracks = (count: number) => `${count} ${count === 1 ? "track" : "tracks"}`;

const sortEntries = (left: MusicEntry, right: MusicEntry) => (left.sortTitle || left.title).localeCompare(right.sortTitle || right.title);

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
          kind: "artist",
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
          kind: "album",
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
        kind: "album",
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

const renderServerPills = (server: StudioServerInfo) => `
  <div class="studio-server-pills">
    <span><i class="studio-status-dot ${server.online ? "online" : "offline"}"></i>${server.online ? "Server Online" : "Server Offline"}</span>
    <span>${escapeHtml(server.name)}</span>
    <span>${escapeHtml(server.mode)}</span>
    <span>${escapeHtml(server.authState)}</span>
  </div>
`;

const renderLibraryItems = (items: StudioLibraryItem[], selected: MusicEntry | null) => {
  if (items.length === 0) {
    return `
      <div class="studio-empty">
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

const queueEntries = (entries: MusicEntry[], selected: MusicEntry | null) =>
  entries.filter((entry) => entry.path !== selected?.path).slice(0, 8);

const renderQueue = (entries: MusicEntry[], selected: MusicEntry | null) => {
  const queue = queueEntries(entries, selected);

  return `
    <section class="studio-queue">
      <header>
        <strong>Next Up</strong>
        <span>${queue.length} tracks</span>
      </header>
      <div>
        ${
          queue.length > 0
            ? queue
                .map(
                  (entry) => `
                    <button type="button" data-studio-path="${escapeHtml(entry.path)}">
                      ${renderArtwork(entry)}
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

const renderNowPlaying = (entry: MusicEntry, entries: MusicEntry[]) => {
  const server = currentServerInfo();

  return `
    <button class="studio-back-command" type="button" data-studio-action="library">${renderStudioIcon("ArrowLeft")} Back to Library</button>
    <section class="studio-now">
      ${renderArtwork(entry)}
      <div class="studio-track-detail">
        <p class="eyebrow">${escapeHtml(formatAudioFormat(entry))}</p>
        <h2>${escapeHtml(entry.title)}</h2>
        <p>${escapeHtml(entry.summary || metadataLine(entry) || `${entry.folder || "Content"} / ${formatSize(entry.size)}`)}</p>
        <audio class="studio-audio-player" data-studio-player controls preload="metadata" src="${entry.streamUrl}">
          Your browser cannot play this audio file.
        </audio>
        <p class="studio-player-status" data-studio-player-status>Ready from ${escapeHtml(server.name)}.</p>
        ${renderServerPills(server)}
        <div class="studio-meta-list">
          <span>Format <strong>${escapeHtml(formatAudioFormat(entry))}</strong></span>
          <span>Artist <strong>${escapeHtml(entry.artist || "Not set")}</strong></span>
          <span>Album <strong>${escapeHtml(entry.album || "Not set")}</strong></span>
          <span>Genres <strong>${escapeHtml(entry.genres.join(", ") || "Not set")}</strong></span>
          <span>Source <strong>${escapeHtml(entry.folder || "Content root")}</strong></span>
          <span>Size <strong>${formatSize(entry.size)}</strong></span>
        </div>
      </div>
    </section>
    ${renderQueue(entries, entry)}
  `;
};

export const renderStudioView = () => `
  <section class="studio-shell" data-studio-app>
    <header class="studio-top-nav">
      <button class="studio-brand" type="button" data-studio-action="library" aria-label="Studio library">
        <span class="studio-brand-mark">${renderStudioIcon("AudioLines")}</span>
        <span>
          <strong>Nebula Studio</strong>
          <small>Music Library</small>
        </span>
      </button>
      <label class="studio-search">
        <span>${renderStudioIcon("Search")} Search</span>
        <input type="search" data-studio-search placeholder="Search music" />
      </label>
      <button class="studio-dashboard-command" type="button" data-studio-action="home">${renderStudioIcon("ArrowLeft")} Dashboard</button>
      <button class="studio-icon-command" type="button" data-studio-action="home" aria-label="Close Studio" title="Close">${renderStudioIcon("X")}</button>
    </header>
    <main class="studio-content" data-studio-content>
      <div class="studio-empty">
        <strong>Loading music</strong>
        <span>Scanning content for audio files.</span>
      </div>
    </main>
    <footer class="studio-footer" data-studio-footer></footer>
  </section>
`;

export const bindStudioView = (container: ParentNode, onHome?: () => void) => {
  const app = container.querySelector<HTMLElement>("[data-studio-app]");
  const content = container.querySelector<HTMLElement>("[data-studio-content]");
  const footer = container.querySelector<HTMLElement>("[data-studio-footer]");

  if (!app || !content || !footer) {
    return;
  }

  let entries: MusicEntry[] = [];
  let selected: MusicEntry | null = null;
  let libraryScope: StudioLibraryScope | null = null;
  let query = "";
  let isScanning = false;

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
      <time>${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
    `;
  };

  const bindPlayerStatus = () => {
    const player = content.querySelector<HTMLAudioElement>("[data-studio-player]");
    const status = content.querySelector<HTMLElement>("[data-studio-player-status]");

    if (!player || !status) {
      return;
    }

    const setStatus = (message: string) => {
      status.textContent = message;
    };

    player.addEventListener("play", () => setStatus("Playback requested."));
    player.addEventListener("playing", () => setStatus("Playing from the local Studio server."));
    player.addEventListener("pause", () => setStatus("Paused."));
    player.addEventListener("ended", () => setStatus("Finished."));
    player.addEventListener("stalled", () => setStatus("Playback is waiting for more data from the server."));
    player.addEventListener("error", () =>
      setStatus("This audio file could not be played here. The browser may not support this format, especially some FLAC files.")
    );
  };

  const render = () => {
    const visible = visibleEntries();
    const scopedEntries = libraryScope ? visible.filter((entry) => libraryScope?.tracks.some((track) => track.path === entry.path)) : visible;
    const libraryItems = groupedLibraryItems(scopedEntries, libraryScope);
    content.classList.toggle("has-selection", Boolean(selected));
    content.classList.toggle("scanning", isScanning);
    content.innerHTML = `
      ${
        selected
          ? `
            <section class="studio-player-panel">
              ${renderNowPlaying(selected, entries)}
            </section>
          `
          : `
            <section class="studio-library">
              <header>
                <div>
                  <p class="eyebrow">${escapeHtml(libraryScope?.kind ?? "Library")}</p>
                  <h3>${escapeHtml(libraryScope?.label ?? "Music")}</h3>
                </div>
                <span>${pluralizeTracks(scopedEntries.length)}</span>
              </header>
              ${libraryScope ? `<button class="studio-back-command" type="button" data-studio-action="library-root">${renderStudioIcon("ArrowLeft")} Back to Music</button>` : ""}
              <div class="studio-track-list">${renderLibraryItems(libraryItems, selected)}</div>
            </section>
          `
      }
    `;
    renderFooter();
    bindPlayerStatus();
  };

  const selectTrack = (entry: MusicEntry, autoplay = false) => {
    selected = entry;
    render();

    if (autoplay) {
      const player = content.querySelector<HTMLAudioElement>("[data-studio-player]");
      const status = content.querySelector<HTMLElement>("[data-studio-player-status]");

      void player?.play().catch(() => {
        if (status) {
          status.textContent = "Ready to play. Use the audio controls if autoplay was blocked.";
        }
      });
    }
  };

  const loadLibrary = async () => {
    isScanning = true;
    render();

    try {
      entries = (await listMusicLibrary()).entries;
      selected = selected ? entries.find((entry) => entry.path === selected?.path) ?? null : null;
    } catch (error) {
      content.innerHTML = `
        <div class="studio-empty">
          <strong>Music unavailable</strong>
          <span>${escapeHtml(error instanceof Error ? error.message : "Unable to scan content.")}</span>
        </div>
      `;
    } finally {
      isScanning = false;
      render();
    }
  };

  app.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const actionButton = target.closest<HTMLButtonElement>("[data-studio-action]");
    const pathButton = target.closest<HTMLButtonElement>("[data-studio-path]");

    if (actionButton?.dataset.studioAction === "home") {
      onHome?.();
      return;
    }

    if (actionButton?.dataset.studioAction === "library") {
      selected = null;
      render();
      return;
    }

    if (actionButton?.dataset.studioAction === "library-root") {
      libraryScope = null;
      render();
      return;
    }

    const groupButton = target.closest<HTMLButtonElement>("[data-studio-group]");

    if (groupButton) {
      const visible = visibleEntries();
      const scopedEntries = libraryScope ? visible.filter((entry) => libraryScope?.tracks.some((track) => track.path === entry.path)) : visible;
      const group = groupedLibraryItems(scopedEntries, libraryScope)
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
      input.focus();
    }
  });

  render();
  void loadLibrary();
};
