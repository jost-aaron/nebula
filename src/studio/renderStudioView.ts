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
          <span aria-disabled="true" title="Playlists are planned">Playlists <small>Soon</small></span>
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
      <footer class="studio-footer" data-studio-footer></footer>
    </section>
  `;
};

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
  let browseMode: StudioBrowseMode = "library";
  let query = "";
  let isScanning = false;
  let loadError = "";
  let playerCleanup: (() => void) | null = null;

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

    const setStatus = (message: string) => {
      playerStatus.textContent = message;
    };

    const onPlay = () => {
      setStatus("Playback requested.");
      void activateAnalyser();
    };
    const onPlaying = () => {
      setStatus("Playing from the local Studio server.");
      void activateAnalyser();
    };
    const onPause = () => setStatus("Paused.");
    const onEnded = () => setStatus("Finished.");
    const onStalled = () => setStatus("Playback is waiting for more data from the server.");
    const onError = () =>
      setStatus("This audio file could not be played here. The browser may not support this format, especially some FLAC files.");

    audioPlayer.addEventListener("play", onPlay);
    audioPlayer.addEventListener("playing", onPlaying);
    audioPlayer.addEventListener("pause", onPause);
    audioPlayer.addEventListener("ended", onEnded);
    audioPlayer.addEventListener("stalled", onStalled);
    audioPlayer.addEventListener("error", onError);

    const context = visualizer?.getContext("2d");

    if (!visualizer || !context) {
      return () => {
        audioPlayer.removeEventListener("play", onPlay);
        audioPlayer.removeEventListener("playing", onPlaying);
        audioPlayer.removeEventListener("pause", onPause);
        audioPlayer.removeEventListener("ended", onEnded);
        audioPlayer.removeEventListener("stalled", onStalled);
        audioPlayer.removeEventListener("error", onError);
      };
    }

    const mediaUrl = new URL(audioPlayer.currentSrc || audioPlayer.src, window.location.href);
    const canAnalyseAudio = mediaUrl.origin === window.location.origin && Boolean(window.AudioContext);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const levels = new Float32Array(96);
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

      if (isReactive && analyser && spectrum) {
        analyser.getByteFrequencyData(spectrum);
        let sumOfSquares = 0;
        const usableBins = Math.max(1, Math.floor(spectrum.length * 0.82));

        for (let bin = 1; bin < usableBins; bin += 1) {
          sumOfSquares += spectrum[bin] * spectrum[bin];
        }

        fftEnergy = Math.min(1, Math.sqrt(sumOfSquares / usableBins) / 255);
      }

      visualizer.dataset.studioVisualizerEnergy = fftEnergy.toFixed(3);

      context.clearRect(0, 0, width, height);
      const barCount = Math.max(32, Math.min(levels.length, Math.floor(width / 6)));
      const gap = width < 420 ? 2.5 : 3;
      const barWidth = Math.max(1.5, (width - gap * (barCount - 1)) / barCount);
      const center = height / 2;
      const maximumBarHeight = Math.max(16, height - 14);
      const ambientTime = reduceMotion ? 0 : timestamp * (isPlaying ? 0.0026 : 0.00125);
      const duration = Number.isFinite(audioPlayer.duration) && audioPlayer.duration > 0 ? audioPlayer.duration : 0;
      const progress = duration ? Math.min(1, audioPlayer.currentTime / duration) : isPlaying ? 0.58 : 0.34;

      for (let index = 0; index < barCount; index += 1) {
        const position = index / Math.max(1, barCount - 1);
        let target = 0;

        if (isReactive && spectrum) {
          const usableBins = Math.max(2, Math.floor(spectrum.length * 0.82));
          const bucketStart = Math.min(
            usableBins - 1,
            Math.max(1, Math.floor(Math.pow(index / barCount, 1.78) * usableBins))
          );
          const bucketEnd = Math.min(
            usableBins,
            Math.max(bucketStart + 1, Math.ceil(Math.pow((index + 1) / barCount, 1.78) * usableBins))
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
          const lowFrequencyLift = 1 + (1 - position) * 0.22;
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
      audioPlayer.removeEventListener("play", onPlay);
      audioPlayer.removeEventListener("playing", onPlaying);
      audioPlayer.removeEventListener("pause", onPause);
      audioPlayer.removeEventListener("ended", onEnded);
      audioPlayer.removeEventListener("stalled", onStalled);
      audioPlayer.removeEventListener("error", onError);
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
          <div class="studio-track-list">${renderLibraryItems(libraryItems, selected)}</div>
        </section>
      `;
    }

    renderTabState();
    renderFooter();
    playerCleanup = bindPlayer();
  };

  const selectTrack = (entry: MusicEntry, autoplay = false) => {
    selected = entry;
    render();
    content.scrollTop = 0;

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
      entries = (await listMusicLibrary()).entries;
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
      playerCleanup?.();
      playerCleanup = null;
      onHome?.();
      return;
    }

    if (actionButton?.dataset.studioAction === "library") {
      selected = null;
      render();
      content.scrollTop = 0;
      return;
    }

    if (actionButton?.dataset.studioAction === "library-root") {
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
  void loadLibrary();
};
