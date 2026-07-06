import { identifyCinemaFrames, listCinemaLibrary, updateCinemaMetadata } from "../api/cinemaApi";
import type {
  CinemaCategory,
  CinemaEntry,
  CinemaIdentificationFrame,
  CinemaIdentifyResponse,
  CinemaMetadataUpdateRequest
} from "../shared/cinemaTypes";

type CinemaView = "library" | "title" | "player";

const categories: Array<{ id: CinemaCategory; label: string; empty: string }> = [
  { empty: "Upload movie files with Files.", id: "movies", label: "Movies" },
  { empty: "Put episode files in a TV, Shows, or Series folder.", id: "tv", label: "TV Shows" },
  { empty: "Upload MP3, M4A, FLAC, WAV, AAC, or OGG files.", id: "music", label: "Music" }
];

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

const categoryLabel = (category: CinemaCategory) =>
  categories.find((candidate) => candidate.id === category)?.label ?? "Movies";

const searchUrl = (query: string) => `https://www.google.com/search?q=${encodeURIComponent(query)}`;

const metadataLine = (entry: CinemaEntry) =>
  [entry.releaseYear, entry.rating, entry.genres.slice(0, 3).join(", "), formatSize(entry.size)].filter(Boolean).join(" · ");

const renderPosterFallback = (entry: CinemaEntry) => `
  <div class="cinema-poster-fallback ${entry.mediaKind === "audio" ? "audio" : ""}">
    <span>${escapeHtml(entry.mediaKind === "audio" ? "M" : entry.title.slice(0, 1).toUpperCase())}</span>
  </div>
`;

const posterStyle = (entry: CinemaEntry) =>
  entry.posterUrl ? ` style="background-image: url('${escapeHtml(entry.posterUrl)}')"` : "";

const renderCinemaCards = (entries: CinemaEntry[], category: CinemaCategory) => {
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
      (entry) => `
        <button class="cinema-card" type="button" data-cinema-path="${escapeHtml(entry.path)}">
          <span class="cinema-poster ${entry.mediaKind === "audio" ? "audio" : ""}" data-cinema-poster="${escapeHtml(entry.path)}"${posterStyle(entry)}>
            ${entry.posterUrl ? "" : renderPosterFallback(entry)}
          </span>
          <span class="cinema-card-copy">
            <strong>${escapeHtml(entry.title)}</strong>
            <small>${escapeHtml(entry.releaseYear || entry.folder || "Local media")}</small>
          </span>
        </button>
      `
    )
    .join("");
};

const renderHeroPoster = (entry: CinemaEntry) => `
  <div class="cinema-title-poster ${entry.mediaKind === "audio" ? "audio" : ""}" data-cinema-detail-poster="${escapeHtml(entry.path)}"${posterStyle(entry)}>
    ${entry.posterUrl ? "" : renderPosterFallback(entry)}
  </div>
`;

const renderTitleDetails = (entry: CinemaEntry) => `
  <section class="cinema-title-view" data-cinema-view="title">
    <div class="cinema-title-backdrop" data-cinema-backdrop="${escapeHtml(entry.path)}"${posterStyle(entry)}></div>
    <div class="cinema-title-shell">
      <header class="cinema-title-nav">
        <button type="button" data-cinema-action="back-library">Library</button>
        <button type="button" data-cinema-action="home">Home</button>
      </header>
      <div class="cinema-title-layout">
        ${renderHeroPoster(entry)}
        <section class="cinema-title-copy">
          <p class="eyebrow">${escapeHtml(categoryLabel(entry.category))}</p>
          <h3>${escapeHtml(entry.title)}</h3>
          ${entry.tagline ? `<p class="cinema-tagline">${escapeHtml(entry.tagline)}</p>` : ""}
          <p class="cinema-title-meta">${escapeHtml(metadataLine(entry) || `${entry.folder || "Content"} · ${formatSize(entry.size)}`)}</p>
          <p class="cinema-summary">${escapeHtml(entry.summary || "No synopsis has been added for this title yet.")}</p>
          <div class="cinema-actions">
            <button type="button" data-cinema-action="play">Play</button>
            <button type="button" data-cinema-action="fullscreen">Fullscreen</button>
            <button type="button" data-cinema-action="edit">Edit Details</button>
            <button type="button" data-cinema-action="identify" ${entry.mediaKind !== "video" ? "disabled" : ""}>Identify</button>
          </div>
          <div class="cinema-fact-grid">
            <span>Studio <strong>${escapeHtml(entry.studio || "Not set")}</strong></span>
            <span>Collection <strong>${escapeHtml(entry.collection || "None")}</strong></span>
            <span>Cast <strong>${escapeHtml(entry.cast || "Not set")}</strong></span>
            <span>File <strong>${escapeHtml(entry.name)}</strong></span>
          </div>
          <section class="cinema-identify" data-cinema-identify hidden></section>
        </section>
      </div>
    </div>
  </section>
`;

const renderPlayerView = (entry: CinemaEntry) => {
  const player =
    entry.mediaKind === "audio"
      ? `<audio class="cinema-player audio" data-cinema-player controls autoplay src="${entry.streamUrl}"></audio>`
      : `<video class="cinema-player" data-cinema-player controls autoplay playsinline preload="metadata" src="${entry.streamUrl}"></video>`;

  return `
    <section class="cinema-player-view" data-cinema-view="player">
      <header class="cinema-player-bar">
        <button type="button" data-cinema-action="back-title">Details</button>
        <div>
          <p class="eyebrow">Now Playing</p>
          <h3>${escapeHtml(entry.title)}</h3>
        </div>
        <button type="button" data-cinema-action="player-fullscreen">Fullscreen</button>
      </header>
      <div class="cinema-player-region">
        ${player}
      </div>
    </section>
  `;
};

const renderEditForm = (entry: CinemaEntry) => `
  <section class="cinema-editor" data-cinema-editor>
    <form class="cinema-editor-dialog" data-cinema-editor-form>
      <header>
        <div>
          <p class="eyebrow">Edit Metadata</p>
          <h3>${escapeHtml(entry.title)}</h3>
        </div>
        <button type="button" data-cinema-action="close-editor" aria-label="Close editor">×</button>
      </header>
      <div class="cinema-editor-grid">
        <label>Title <input name="title" value="${escapeHtml(entry.title)}" /></label>
        <label>Sort Title <input name="sortTitle" value="${escapeHtml(entry.sortTitle || entry.title)}" /></label>
        <label>Year <input name="releaseYear" value="${escapeHtml(entry.releaseYear)}" /></label>
        <label>Rating <input name="rating" value="${escapeHtml(entry.rating)}" /></label>
        <label>Genres <input name="genres" value="${escapeHtml(entry.genres.join(", "))}" /></label>
        <label>Studio <input name="studio" value="${escapeHtml(entry.studio)}" /></label>
        <label>Collection <input name="collection" value="${escapeHtml(entry.collection)}" /></label>
        <label>Poster URL <input name="posterUrl" value="${escapeHtml(entry.posterUrl)}" /></label>
        <label class="wide">Tagline <input name="tagline" value="${escapeHtml(entry.tagline)}" /></label>
        <label class="wide">Cast <input name="cast" value="${escapeHtml(entry.cast)}" /></label>
        <label class="wide">Summary <textarea name="summary">${escapeHtml(entry.summary)}</textarea></label>
      </div>
      <footer>
        <span data-cinema-editor-status></span>
        <button type="button" data-cinema-action="close-editor">Cancel</button>
        <button type="submit">Save Details</button>
      </footer>
    </form>
  </section>
`;

export const renderCinemaView = () => `
  <section class="cinema-app" data-cinema-app>
    <header class="cinema-shell-bar">
      <div>
        <p class="eyebrow">Nebula Cinema</p>
        <h3>Library</h3>
      </div>
      <div class="cinema-shell-actions">
        <button class="cinema-home-command" type="button" data-cinema-action="home">Home</button>
      </div>
    </header>
    <section class="cinema-home" data-cinema-view="library">
      <header class="cinema-home-header">
        <div>
          <p class="eyebrow">Local Library</p>
          <h3 data-cinema-heading>Movies</h3>
        </div>
        <div class="cinema-home-tools">
          <nav class="cinema-tabs" aria-label="Media categories">
            ${categories
              .map(
                (category) => `
                  <button class="${category.id === "movies" ? "active" : ""}" type="button" data-cinema-category="${category.id}">
                    ${category.label}
                    <span data-cinema-count="${category.id}">0</span>
                  </button>
                `
              )
              .join("")}
          </nav>
          <label class="cinema-search">
            <span>Search</span>
            <input type="search" data-cinema-search placeholder="Find media" />
          </label>
          <button class="cinema-refresh" type="button" data-cinema-action="refresh">Refresh</button>
        </div>
      </header>
      <div class="cinema-grid" data-cinema-grid>
        <div class="cinema-empty">
          <strong>Loading library</strong>
          <span>Scanning content for playable media.</span>
        </div>
      </div>
    </section>
    <section data-cinema-title-host hidden></section>
    <section data-cinema-player-host hidden></section>
    <section data-cinema-editor-host hidden></section>
  </section>
`;

export const bindCinemaView = (container: ParentNode, onHome?: () => void) => {
  const app = container.querySelector<HTMLElement>("[data-cinema-app]");
  const heading = container.querySelector<HTMLElement>("[data-cinema-heading]");
  const grid = container.querySelector<HTMLElement>("[data-cinema-grid]");
  const libraryView = container.querySelector<HTMLElement>("[data-cinema-view='library']");
  const titleHost = container.querySelector<HTMLElement>("[data-cinema-title-host]");
  const playerHost = container.querySelector<HTMLElement>("[data-cinema-player-host]");
  const editorHost = container.querySelector<HTMLElement>("[data-cinema-editor-host]");
  const search = container.querySelector<HTMLInputElement>("[data-cinema-search]");
  const refresh = container.querySelector<HTMLButtonElement>("[data-cinema-action='refresh']");

  if (!app || !heading || !grid || !libraryView || !titleHost || !playerHost || !editorHost || !search || !refresh) {
    return;
  }

  let entries: CinemaEntry[] = [];
  let activeCategory: CinemaCategory = "movies";
  let selected: CinemaEntry | null = null;
  let view: CinemaView = "library";

  const categoryEntries = (category: CinemaCategory) => entries.filter((entry) => entry.category === category);

  const filteredEntries = () => {
    const query = search.value.trim().toLowerCase();
    const currentEntries = categoryEntries(activeCategory);

    if (!query) {
      return currentEntries;
    }

    return currentEntries.filter((entry) =>
      `${entry.title} ${entry.name} ${entry.folder} ${entry.genres.join(" ")} ${entry.cast}`.toLowerCase().includes(query)
    );
  };

  const setView = (nextView: CinemaView) => {
    view = nextView;
    libraryView.hidden = view !== "library";
    titleHost.hidden = view !== "title";
    playerHost.hidden = view !== "player";
  };

  const updateCounts = () => {
    categories.forEach((category) => {
      const count = container.querySelector<HTMLElement>(`[data-cinema-count='${category.id}']`);

      if (count) {
        count.textContent = String(categoryEntries(category.id).length);
      }
    });
  };

  const hydratePoster = async (entry: CinemaEntry, poster: HTMLElement) => {
    if (entry.posterUrl || entry.mediaKind !== "video") {
      return;
    }

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = entry.streamUrl;

    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("Poster metadata failed.")), { once: true });
    });

    video.currentTime = Math.min(12, Math.max(0.5, (Number.isFinite(video.duration) ? video.duration : 6) * 0.08));

    await new Promise<void>((resolve, reject) => {
      video.addEventListener("seeked", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("Poster seek failed.")), { once: true });
    });

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 480;
    const context = canvas.getContext("2d");

    if (!context) {
      return;
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
    poster.style.backgroundImage = `url(${canvas.toDataURL("image/jpeg", 0.72)})`;
    poster.classList.add("ready");
    poster.innerHTML = "";
  };

  const hydratePosters = (scope: ParentNode = container) => {
    scope.querySelectorAll<HTMLElement>("[data-cinema-poster], [data-cinema-detail-poster], [data-cinema-backdrop]").forEach((poster) => {
      const path = poster.dataset.cinemaPoster ?? poster.dataset.cinemaDetailPoster ?? poster.dataset.cinemaBackdrop;
      const entry = entries.find((candidate) => candidate.path === path);

      if (entry) {
        void hydratePoster(entry, poster).catch(() => {});
      }
    });
  };

  const renderLibrary = () => {
    const visibleEntries = filteredEntries();
    heading.textContent = categoryLabel(activeCategory);
    container.querySelectorAll<HTMLButtonElement>("[data-cinema-category]").forEach((button) => {
      button.classList.toggle("active", button.dataset.cinemaCategory === activeCategory);
    });
    grid.innerHTML = renderCinemaCards(visibleEntries, activeCategory);
    hydratePosters(grid);
  };

  const renderTitle = () => {
    if (!selected) {
      return;
    }

    titleHost.innerHTML = renderTitleDetails(selected);
    titleHost.hidden = false;
    hydratePosters(titleHost);
    bindTitleControls();
  };

  const openTitle = (entry: CinemaEntry) => {
    selected = entry;
    playerHost.innerHTML = "";
    renderTitle();
    setView("title");
  };

  const openPlayer = (fullscreen = false) => {
    if (!selected) {
      return;
    }

    playerHost.innerHTML = renderPlayerView(selected);
    setView("player");
    const player = playerHost.querySelector<HTMLMediaElement>("[data-cinema-player]");

    if (fullscreen && player instanceof HTMLVideoElement) {
      void player.requestFullscreen?.();
    }

    bindPlayerControls();
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

  const renderIdentificationResult = (panel: HTMLElement, frames: CinemaIdentificationFrame[], result: CinemaIdentifyResponse) => {
    const provider = result.providers[0];
    const configured = provider?.configured ?? false;
    const pages = provider?.results.flatMap((entry) => entry.pages ?? []).filter((page) => page.url) ?? [];
    const entities = provider?.results.flatMap((entry) => entry.webEntities ?? []) ?? [];

    panel.hidden = false;
    panel.innerHTML = `
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
          ? `
            <div class="cinema-evidence-list">
              <strong>Candidate entities</strong>
              ${result.candidates.map((candidate) => `<span>${escapeHtml(candidate.name)} · ${candidate.score.toFixed(2)}</span>`).join("")}
            </div>
          `
          : ""
      }
      ${
        entities.length > 0
          ? `
            <div class="cinema-evidence-list">
              <strong>Frame evidence</strong>
              ${entities.slice(0, 8).map((entity) => `<span>${escapeHtml(entity.description)} · ${entity.score.toFixed(2)}</span>`).join("")}
            </div>
          `
          : ""
      }
      ${
        pages.length > 0
          ? `
            <div class="cinema-evidence-list">
              <strong>Matching pages</strong>
              ${pages.slice(0, 6).map((page) => `<a href="${escapeHtml(page.url)}" target="_blank" rel="noreferrer">${escapeHtml(page.title)}</a>`).join("")}
            </div>
          `
          : `
            <div class="cinema-evidence-list">
              <strong>${configured ? "No matching pages found" : "Manual searches"}</strong>
              ${result.frameQueries.slice(0, 6).map((query) => `<a href="${searchUrl(query)}" target="_blank" rel="noreferrer">${escapeHtml(query)}</a>`).join("")}
            </div>
          `
      }
    `;
  };

  const identifySelectedVideo = async () => {
    if (!selected || selected.mediaKind !== "video") {
      return;
    }

    const panel = titleHost.querySelector<HTMLElement>("[data-cinema-identify]");
    const identify = titleHost.querySelector<HTMLButtonElement>("[data-cinema-action='identify']");

    if (!panel || !identify) {
      return;
    }

    identify.disabled = true;
    identify.textContent = "Sampling";
    panel.hidden = false;
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

      renderIdentificationResult(panel, frames, await identifyCinemaFrames({
        frames,
        path: selected.path,
        title: selected.title
      }));
    } catch (error) {
      panel.innerHTML = `
        <div class="cinema-empty">
          <strong>Identification unavailable</strong>
          <span>${escapeHtml(error instanceof Error ? error.message : "Unable to sample this video.")}</span>
        </div>
      `;
    } finally {
      identify.disabled = false;
      identify.textContent = "Identify";
    }
  };

  const openEditor = () => {
    if (!selected) {
      return;
    }

    editorHost.hidden = false;
    editorHost.innerHTML = renderEditForm(selected);
    bindEditorControls();
  };

  const closeEditor = () => {
    editorHost.hidden = true;
    editorHost.innerHTML = "";
  };

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
    updateCounts();
    renderLibrary();
    renderTitle();
    closeEditor();
  };

  const bindTitleControls = () => {
    titleHost.querySelectorAll<HTMLButtonElement>("[data-cinema-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.cinemaAction;

        if (action === "back-library") {
          selected = null;
          titleHost.innerHTML = "";
          setView("library");
        }

        if (action === "home") {
          onHome?.();
        }

        if (action === "play") {
          openPlayer(false);
        }

        if (action === "fullscreen") {
          openPlayer(true);
        }

        if (action === "edit") {
          openEditor();
        }

        if (action === "identify") {
          void identifySelectedVideo();
        }
      });
    });
  };

  const bindPlayerControls = () => {
    playerHost.querySelectorAll<HTMLButtonElement>("[data-cinema-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.cinemaAction;

        if (action === "back-title") {
          playerHost.innerHTML = "";
          renderTitle();
          setView("title");
        }

        if (action === "player-fullscreen") {
          const player = playerHost.querySelector<HTMLMediaElement>("[data-cinema-player]");

          if (player instanceof HTMLVideoElement) {
            void player.requestFullscreen?.();
          }
        }
      });
    });
  };

  const bindEditorControls = () => {
    const form = editorHost.querySelector<HTMLFormElement>("[data-cinema-editor-form]");

    editorHost.querySelectorAll<HTMLButtonElement>("[data-cinema-action='close-editor']").forEach((button) => {
      button.addEventListener("click", closeEditor);
    });

    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveMetadata(form).catch((error) => {
        const status = form.querySelector<HTMLElement>("[data-cinema-editor-status]");

        if (status) {
          status.textContent = error instanceof Error ? error.message : "Save failed.";
        }
      });
    });
  };

  const loadLibrary = async () => {
    refresh.disabled = true;
    refresh.textContent = "Scanning";

    try {
      entries = (await listCinemaLibrary()).entries;
      updateCounts();
      renderLibrary();
    } catch (error) {
      grid.innerHTML = `
        <div class="cinema-empty">
          <strong>Library unavailable</strong>
          <span>${escapeHtml(error instanceof Error ? error.message : "Unable to scan content.")}</span>
        </div>
      `;
    } finally {
      refresh.disabled = false;
      refresh.textContent = "Refresh";
    }
  };

  container.querySelectorAll<HTMLButtonElement>("[data-cinema-category]").forEach((button) => {
    button.addEventListener("click", () => {
      activeCategory = (button.dataset.cinemaCategory as CinemaCategory | undefined) ?? "movies";
      selected = null;
      renderLibrary();
      setView("library");
    });
  });

  grid.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-cinema-path]");
    const entry = entries.find((candidate) => candidate.path === card?.dataset.cinemaPath);

    if (entry) {
      openTitle(entry);
    }
  });

  search.addEventListener("input", renderLibrary);
  refresh.addEventListener("click", () => {
    void loadLibrary();
  });
  container.querySelectorAll<HTMLButtonElement>("[data-cinema-action='home']").forEach((button) => {
    button.addEventListener("click", () => {
      onHome?.();
    });
  });

  void loadLibrary();
};
