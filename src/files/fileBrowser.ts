import { apiFetch, apiJson, apiUrl, applyApiHeadersToRequest, getApiConnectionMode } from "../api/http";

export interface FileEntry {
  modifiedAt: string;
  name: string;
  path: string;
  size: number;
  type: "file" | "folder";
}

interface FileListing {
  entries: FileEntry[];
  path: string;
}

interface UploadPart {
  index: number;
  size: number;
}

interface UploadSession {
  chunkSize: number;
  id: string;
  name: string;
  path: string;
  size: number;
  target: string;
  type: string;
  uploadedParts: UploadPart[];
}

interface UploadResult {
  ok: true;
  path: string;
}

interface StoredUploadSession {
  chunkSize: number;
  lastModified: number;
  name: string;
  path: string;
  sessionId: string;
  size: number;
  type: string;
}

type FileSectionId = "files" | "movies" | "tv" | "music" | "uploads" | "recent";

interface FileSection {
  detail: string;
  id: FileSectionId;
  label: string;
  marker: string;
  path: string;
}

const DIRECT_UPLOAD_LIMIT = 64 * 1024 * 1024;
const RESUMABLE_CHUNK_SIZE = 64 * 1024 * 1024;
const CHUNK_RETRIES = 2;
const UPLOAD_SESSION_STORAGE_KEY = "nebula.files.uploadSessions.v1";

const FILE_SECTIONS: FileSection[] = [
  { detail: "Content root", id: "files", label: "Files", marker: "F", path: "" },
  { detail: "Local video", id: "movies", label: "Movies", marker: "M", path: "Movies" },
  { detail: "Series folders", id: "tv", label: "TV Shows", marker: "T", path: "TV Shows" },
  { detail: "Audio library", id: "music", label: "Music", marker: "A", path: "Music" },
  { detail: "Incoming files", id: "uploads", label: "Uploads", marker: "U", path: "Uploads" },
  { detail: "Recently changed", id: "recent", label: "Recent", marker: "R", path: "" }
];

const VIDEO_PATTERN = /\.(m4v|mkv|mov|mp4|webm)$/i;
const AUDIO_PATTERN = /\.(aac|flac|m4a|mp3|ogg|wav)$/i;
const IMAGE_PATTERN = /\.(gif|jpe?g|png|svg|webp)$/i;
const TEXT_PATTERN = /\.(css|html|js|json|md|txt)$/i;

const api = async <T>(url: string, options?: RequestInit): Promise<T> =>
  apiJson<T>(url, options).catch((error) => {
    throw new Error(error instanceof Error ? error.message : "File operation failed.");
  });

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const formatSize = (size: number) => {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const parentPath = (currentPath: string) => currentPath.split("/").filter(Boolean).slice(0, -1).join("/");

const fileApiPath = (kind: "read" | "download", filePath: string) =>
  `/api/files/${kind}?path=${encodeURIComponent(filePath)}`;

const uploadUrl = (folderPath: string, fileName: string) =>
  `/api/files/upload?path=${encodeURIComponent(folderPath)}&name=${encodeURIComponent(fileName)}`;

const uploadSessionUrl = (sessionId: string) => `/api/files/uploads/${encodeURIComponent(sessionId)}`;

const uploadChunkUrl = (sessionId: string, chunkIndex: number) =>
  `${uploadSessionUrl(sessionId)}/chunks/${chunkIndex}`;

const entryAccent = (entry: FileEntry) => {
  if (entry.type === "folder") {
    return "folder";
  }

  if (VIDEO_PATTERN.test(entry.name)) {
    return "video";
  }

  if (AUDIO_PATTERN.test(entry.name)) {
    return "audio";
  }

  if (IMAGE_PATTERN.test(entry.name)) {
    return "image";
  }

  if (TEXT_PATTERN.test(entry.name)) {
    return "text";
  }

  return "file";
};

const entryGlyph = (entry: FileEntry) => {
  const accent = entryAccent(entry);

  if (accent === "folder") {
    return "DIR";
  }

  if (accent === "video") {
    return "VID";
  }

  if (accent === "audio") {
    return "AUD";
  }

  if (accent === "image") {
    return "IMG";
  }

  if (accent === "text") {
    return "TXT";
  }

  return "DOC";
};

const entryKind = (entry: FileEntry) => {
  if (entry.type === "folder") {
    return "Folder";
  }

  const extension = entry.name.split(".").pop();
  return extension && extension !== entry.name ? extension.toUpperCase() : "File";
};

const storageBreakdown = (entries: FileEntry[]) => {
  const totals = entries.reduce(
    (total, entry) => {
      if (entry.type === "folder") {
        total.folders += 1;
        return total;
      }

      total.used += entry.size;

      if (VIDEO_PATTERN.test(entry.name)) {
        total.video += entry.size;
      } else if (AUDIO_PATTERN.test(entry.name)) {
        total.audio += entry.size;
      } else {
        total.other += entry.size;
      }

      return total;
    },
    { audio: 0, folders: 0, other: 0, used: 0, video: 0 }
  );

  const largestCategory = Math.max(totals.video, totals.audio, totals.other, 1);

  return {
    ...totals,
    audioShare: Math.max(6, (totals.audio / largestCategory) * 100),
    otherShare: Math.max(6, (totals.other / largestCategory) * 100),
    videoShare: Math.max(6, (totals.video / largestCategory) * 100)
  };
};

const readStoredUploadSessions = (): StoredUploadSession[] => {
  try {
    return JSON.parse(window.localStorage.getItem(UPLOAD_SESSION_STORAGE_KEY) ?? "[]") as StoredUploadSession[];
  } catch {
    return [];
  }
};

const writeStoredUploadSessions = (sessions: StoredUploadSession[]) => {
  window.localStorage.setItem(UPLOAD_SESSION_STORAGE_KEY, JSON.stringify(sessions));
};

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const renderBreadcrumbs = (currentPath: string) => {
  const parts = currentPath.split("/").filter(Boolean);
  const crumbs = [{ label: "Content", path: "" }].concat(
    parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join("/")
    }))
  );

  return crumbs
    .map(
      (crumb, index) => `
        <button type="button" data-file-path="${escapeHtml(crumb.path)}">
          ${escapeHtml(crumb.label)}
        </button>
        ${index < crumbs.length - 1 ? "<span>/</span>" : ""}
      `
    )
    .join("");
};

const renderSections = (activeSection: FileSectionId, entries: FileEntry[]) =>
  FILE_SECTIONS.map((section) => {
    const count =
      section.id === "recent"
        ? entries.slice().sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)).slice(0, 8).length
        : section.id === "files"
          ? entries.length
          : entries.filter((entry) => entry.path === section.path || entry.path.startsWith(`${section.path}/`)).length;

    return `
      <button
        class="file-section ${section.id === activeSection ? "active" : ""}"
        type="button"
        data-file-section="${section.id}"
      >
        <span class="file-section-icon">${section.marker}</span>
        <span>
          <strong>${escapeHtml(section.label)}</strong>
          <small>${escapeHtml(section.detail)}</small>
        </span>
        <em>${count}</em>
      </button>
    `;
  }).join("");

const renderStorage = (entries: FileEntry[]) => {
  const storage = storageBreakdown(entries);

  return `
    <section class="file-storage" data-file-storage>
      <div>
        <p class="eyebrow">Storage</p>
        <strong>${formatSize(storage.used)}</strong>
        <span>visible in this folder</span>
      </div>
      <div class="file-storage-ring" aria-hidden="true">
        <span>${entries.length}</span>
        <small>items</small>
      </div>
      <dl>
        <div style="--storage-share: ${storage.videoShare}%">
          <dt>Video</dt>
          <dd>${formatSize(storage.video)}</dd>
        </div>
        <div style="--storage-share: ${storage.audioShare}%">
          <dt>Audio</dt>
          <dd>${formatSize(storage.audio)}</dd>
        </div>
        <div style="--storage-share: ${storage.otherShare}%">
          <dt>Other</dt>
          <dd>${formatSize(storage.other)}</dd>
        </div>
      </dl>
    </section>
  `;
};

const renderEntryCards = (entries: FileEntry[], selectedPath: string | null, needsServerConfig: boolean) => {
  if (needsServerConfig) {
    return `
      <div class="file-empty file-server-empty">
        <strong>Connect a Nebula server</strong>
        <span>Files needs Settings -> Client -> Server URL in the iOS app.</span>
        <button type="button" data-file-action="settings">Open Settings</button>
      </div>
    `;
  }

  if (entries.length === 0) {
    return `
      <div class="file-empty">
        <strong>No files yet</strong>
        <span>Create a folder, create a text file, or upload content.</span>
      </div>
    `;
  }

  return entries
    .map(
      (entry) => `
        <button
          class="file-card ${entry.path === selectedPath ? "active" : ""}"
          type="button"
          data-entry-path="${escapeHtml(entry.path)}"
          data-entry-type="${entry.type}"
        >
          <span class="file-card-art ${entryAccent(entry)}">
            <span>${entryGlyph(entry)}</span>
          </span>
          <span class="file-name">${escapeHtml(entry.name)}</span>
          <span class="file-card-meta">
            ${entryKind(entry)} ${entry.type === "folder" ? "folder" : `· ${formatSize(entry.size)}`}
          </span>
          <span class="file-card-date">${new Date(entry.modifiedAt).toLocaleDateString()}</span>
        </button>
      `
    )
    .join("");
};

const renderPreview = (entry: FileEntry | null, preview: string | null, imagePreviewUrl: string | null) => {
  if (!entry) {
    return `
      <div class="file-preview-empty">
        <strong>Select an item</strong>
        <span>Cards show preview, metadata, and actions here.</span>
      </div>
    `;
  }

  const modified = new Date(entry.modifiedAt).toLocaleString();
  const location = parentPath(entry.path);

  if (entry.type === "folder") {
    return `
      <div class="file-preview-card">
        <div class="file-preview-art folder">
          <span>DIR</span>
        </div>
        <h3>${escapeHtml(entry.name)}</h3>
        <dl class="file-metadata">
          <div><dt>Type</dt><dd>Folder</dd></div>
          <div><dt>Location</dt><dd>/${escapeHtml(location)}</dd></div>
          <div><dt>Modified</dt><dd>${modified}</dd></div>
        </dl>
      </div>
    `;
  }

  const isImage = IMAGE_PATTERN.test(entry.name);
  const isText = TEXT_PATTERN.test(entry.name);

  return `
    <div class="file-preview-card">
      ${
        isImage && imagePreviewUrl
          ? `<img class="file-preview-image" src="${imagePreviewUrl}" alt="${escapeHtml(entry.name)}" />`
          : `<div class="file-preview-art ${entryAccent(entry)}"><span>${entryGlyph(entry)}</span></div>`
      }
      <h3>${escapeHtml(entry.name)}</h3>
      <dl class="file-metadata">
        <div><dt>Type</dt><dd>${entryKind(entry)}</dd></div>
        <div><dt>Size</dt><dd>${formatSize(entry.size)}</dd></div>
        <div><dt>Location</dt><dd>/${escapeHtml(location)}</dd></div>
        <div><dt>Modified</dt><dd>${modified}</dd></div>
      </dl>
      ${
        isText && preview !== null
          ? `<pre class="file-preview-text">${escapeHtml(preview)}</pre>`
          : ""
      }
      ${!isImage && !isText ? `<p class="file-preview-note">No inline preview for this file type.</p>` : ""}
    </div>
  `;
};

export function renderFileBrowserShell() {
  return `
    <section class="file-browser" data-file-browser tabindex="0" aria-label="Files app">
      <header class="file-app-bar">
        <div>
          <p class="eyebrow">Nebula Local Content</p>
          <h2>Files</h2>
        </div>
        <button class="file-home-button" type="button" data-file-close>Back to Home</button>
      </header>
      <div class="file-browser-layout">
        <aside class="file-sidebar">
          <header class="file-sidebar-header">
            <p class="eyebrow">Local Content</p>
            <h3>Files</h3>
          </header>
          <nav class="file-sections" data-file-sections></nav>
          <div data-file-storage></div>
        </aside>
        <main class="file-stage">
          <header class="file-toolbar">
            <div>
              <p class="eyebrow">Browse</p>
              <h3 data-file-heading>All Files</h3>
            </div>
            <div class="file-toolbar-side">
              <nav class="file-breadcrumbs" data-file-breadcrumbs></nav>
              <span class="file-sort">Sort: Name</span>
            </div>
          </header>
          <section class="file-list" data-file-list></section>
        </main>
        <aside class="file-preview">
          <div data-file-preview></div>
          <div class="file-actions">
            <button type="button" data-file-action="open" disabled>Open</button>
            <button type="button" data-file-action="new-folder">New Folder</button>
            <button type="button" data-file-action="new-text">New Text</button>
            <button type="button" data-file-action="upload">Upload</button>
            <button type="button" data-file-action="rename" disabled>Rename</button>
            <button type="button" data-file-action="download" disabled>Download</button>
            <button type="button" data-file-action="delete" disabled>Delete</button>
            <input class="file-upload-input" type="file" data-file-upload multiple hidden />
          </div>
        </aside>
      </div>
      <div class="file-upload-progress" data-file-upload-progress hidden>
        <div>
          <strong data-file-upload-title>Uploading</strong>
          <span data-file-upload-detail>Preparing...</span>
        </div>
        <div class="file-upload-meter">
          <progress data-file-upload-meter value="0" max="100"></progress>
          <span aria-hidden="true"><i data-file-upload-fill></i></span>
        </div>
        <button type="button" data-file-upload-cancel>Cancel</button>
      </div>
      <div class="file-drop-indicator" aria-hidden="true">
        <strong>Drop files to upload</strong>
        <span>Files will be added to the current folder.</span>
      </div>
      <p class="file-status" data-file-status></p>
    </section>
  `;
}

interface FileBrowserOptions {
  onOpenSettings?: () => void;
}

export function bindFileBrowser(container: ParentNode, options: FileBrowserOptions = {}) {
  const browser = container.querySelector<HTMLElement>("[data-file-browser]");
  const sections = container.querySelector<HTMLElement>("[data-file-sections]");
  const storage = container.querySelector<HTMLElement>("[data-file-storage]");
  const heading = container.querySelector<HTMLElement>("[data-file-heading]");
  const breadcrumbs = container.querySelector<HTMLElement>("[data-file-breadcrumbs]");
  const list = container.querySelector<HTMLElement>("[data-file-list]");
  const preview = container.querySelector<HTMLElement>("[data-file-preview]");
  const status = container.querySelector<HTMLElement>("[data-file-status]");
  const uploadInput = container.querySelector<HTMLInputElement>("[data-file-upload]");
  const uploadProgress = container.querySelector<HTMLElement>("[data-file-upload-progress]");
  const uploadTitle = container.querySelector<HTMLElement>("[data-file-upload-title]");
  const uploadDetail = container.querySelector<HTMLElement>("[data-file-upload-detail]");
  const uploadMeter = container.querySelector<HTMLProgressElement>("[data-file-upload-meter]");
  const uploadFill = container.querySelector<HTMLElement>("[data-file-upload-fill]");
  const uploadCancel = container.querySelector<HTMLButtonElement>("[data-file-upload-cancel]");

  if (!browser || !sections || !storage || !heading || !breadcrumbs || !list || !preview || !status || !uploadInput || !uploadProgress || !uploadTitle || !uploadDetail || !uploadMeter || !uploadFill || !uploadCancel) {
    return;
  }

  const dropTarget = container instanceof HTMLElement ? container : browser;

  let currentPath = "";
  let entries: FileEntry[] = [];
  let selectedPath: string | null = null;
  let activeSection: FileSectionId = "files";
  let dragDepth = 0;
  let activeUpload: XMLHttpRequest | null = null;
  let activeUploadSessionId: string | null = null;
  let activePreviewObjectUrl: string | null = null;
  let needsServerConfig = false;
  let uploadCancelled = false;

  const selectedEntry = () => entries.find((entry) => entry.path === selectedPath) ?? null;
  const selectedIndex = () => Math.max(0, entries.findIndex((entry) => entry.path === selectedPath));
  const activeSectionConfig = () => FILE_SECTIONS.find((section) => section.id === activeSection) ?? FILE_SECTIONS[0];

  const setStatus = (message: string) => {
    status.textContent = message;
  };

  const updateActionState = () => {
    const entry = selectedEntry();
    browser.querySelectorAll<HTMLButtonElement>("[data-file-action='open'], [data-file-action='rename'], [data-file-action='delete']").forEach((button) => {
      button.disabled = !entry;
    });
    browser.querySelector<HTMLButtonElement>("[data-file-action='download']")!.disabled = !entry || entry.type !== "file";
  };

  const loadPreview = async () => {
    const entry = selectedEntry();
    let content: string | null = null;
    let imagePreviewUrl: string | null = null;

    if (activePreviewObjectUrl) {
      URL.revokeObjectURL(activePreviewObjectUrl);
      activePreviewObjectUrl = null;
    }

    if (entry?.type === "file" && TEXT_PATTERN.test(entry.name)) {
      content = await apiFetch(fileApiPath("read", entry.path)).then((response) => response.text()).catch(() => null);
    } else if (entry?.type === "file" && IMAGE_PATTERN.test(entry.name)) {
      imagePreviewUrl = await apiFetch(fileApiPath("read", entry.path))
        .then(async (response) => {
          if (!response.ok) {
            throw new Error("Preview failed.");
          }

          return URL.createObjectURL(await response.blob());
        })
        .catch(() => null);
      activePreviewObjectUrl = imagePreviewUrl;
    }

    preview.innerHTML = renderPreview(entry, content, imagePreviewUrl);
    updateActionState();
  };

  const render = async () => {
    const section = activeSectionConfig();
    heading.textContent = section.id === "files" ? "All Files" : section.label;
    sections.innerHTML = renderSections(activeSection, entries);
    storage.innerHTML = renderStorage(entries);
    breadcrumbs.innerHTML = renderBreadcrumbs(currentPath);
    list.innerHTML = renderEntryCards(entries, selectedPath, needsServerConfig);
    await loadPreview();
  };

  const load = async (path = currentPath) => {
    try {
      const listing = await api<FileListing>(`/api/files?path=${encodeURIComponent(path)}`);
      needsServerConfig = false;
      currentPath = listing.path;
      entries = listing.entries;
      selectedPath = entries[0]?.path ?? null;
      setStatus(`Viewing /${currentPath}`);
      await render();
    } catch (error) {
      if (getApiConnectionMode() === "Needs server URL") {
        needsServerConfig = true;
        currentPath = "";
        entries = [];
        selectedPath = null;
        setStatus("Add a server URL in Settings -> Client.");
        await render();
        return;
      }

      throw error;
    }
  };

  const loadSection = async (section: FileSection) => {
    try {
      await load(section.path);
    } catch (error) {
      await load("");
      setStatus(`${section.label} folder is not available yet. Showing /${currentPath}`);
    }
  };

  const openEntry = async (entry = selectedEntry()) => {
    if (!entry) {
      return;
    }

    if (entry.type === "folder") {
      await load(entry.path);
      return;
    }

    await downloadEntry(entry).catch((error) => {
      setStatus(error instanceof Error ? error.message : "Download failed.");
    });
  };

  const downloadEntry = async (entry: FileEntry) => {
    const response = await apiFetch(fileApiPath("download", entry.path));

    if (!response.ok) {
      throw new Error("Download failed.");
    }

    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = entry.name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };

  const moveSelection = (delta: number) => {
    if (entries.length === 0) {
      return;
    }

    const nextIndex = (selectedIndex() + delta + entries.length) % entries.length;
    selectedPath = entries[nextIndex].path;
    void render();
  };

  const setUploadProgress = (title: string, detail: string, percent: number) => {
    uploadProgress.hidden = false;
    uploadTitle.textContent = title;
    uploadDetail.textContent = detail;
    const safePercent = Math.max(0, Math.min(100, percent));
    uploadMeter.value = safePercent;
    uploadMeter.setAttribute("aria-valuetext", `${Math.round(safePercent)}%`);
    uploadFill.style.setProperty("--file-upload-progress", `${safePercent}%`);
  };

  const clearUploadProgress = () => {
    activeUpload = null;
    activeUploadSessionId = null;
    uploadProgress.hidden = true;
    uploadMeter.value = 0;
    uploadMeter.setAttribute("aria-valuetext", "0%");
    uploadFill.style.setProperty("--file-upload-progress", "0%");
  };

  const parseUploadError = (responseText: string) => {
    try {
      const body = JSON.parse(responseText) as { error?: string };
      return body.error ?? "Upload failed.";
    } catch {
      return responseText || "Upload failed.";
    }
  };

  const sendUploadRequest = async (
    url: string,
    body: Blob,
    contentType: string,
    onProgress: (loaded: number, total: number) => void
  ) => {
    return new Promise<UploadResult>((resolve, reject) => {
      const request = new XMLHttpRequest();
      activeUpload = request;

      request.upload.addEventListener("progress", (event) => {
        if (!event.lengthComputable) {
          return;
        }

        onProgress(event.loaded, event.total);
      });

      request.addEventListener("load", () => {
        activeUpload = null;

        if (request.status >= 200 && request.status < 300) {
          try {
            resolve(JSON.parse(request.responseText || "{}") as UploadResult);
          } catch {
            resolve({ ok: true, path: "" });
          }
          return;
        }

        reject(new Error(parseUploadError(request.responseText)));
      });

      request.addEventListener("abort", () => {
        activeUpload = null;
        reject(new DOMException("Upload cancelled.", "AbortError"));
      });

      request.addEventListener("error", () => {
        activeUpload = null;
        reject(new Error("Upload failed."));
      });

      request.open("PUT", apiUrl(url));
      applyApiHeadersToRequest(request, { "content-type": contentType });
      request.send(body);
    });
  };

  const uploadDirectFile = async (file: File, index: number, total: number) => {
    setUploadProgress(
      `Uploading ${index + 1} of ${total}`,
      `${file.name} · 0%`,
      total > 1 ? (index / total) * 100 : 0
    );

    const result = await sendUploadRequest(uploadUrl(currentPath, file.name), file, file.type || "application/octet-stream", (loaded, uploadTotal) => {
      const filePercent = (loaded / uploadTotal) * 100;
      const totalPercent = total > 1 ? ((index + filePercent / 100) / total) * 100 : filePercent;
      setUploadProgress(`Uploading ${index + 1} of ${total}`, `${file.name} · ${Math.round(filePercent)}%`, totalPercent);
    });

    setUploadProgress(`Uploaded ${index + 1} of ${total}`, `${file.name} · complete`, ((index + 1) / total) * 100);
    return result.path || [currentPath, file.name].filter(Boolean).join("/");
  };

  const createUploadSession = async (file: File) =>
    api<UploadSession>("/api/files/uploads", {
      body: JSON.stringify({
        chunkSize: RESUMABLE_CHUNK_SIZE,
        name: file.name,
        path: currentPath,
        size: file.size,
        type: file.type
      }),
      method: "POST"
    });

  const storedSessionMatchesFile = (session: StoredUploadSession, file: File) =>
    session.chunkSize === RESUMABLE_CHUNK_SIZE &&
    session.lastModified === file.lastModified &&
    session.name === file.name &&
    session.path === currentPath &&
    session.size === file.size &&
    session.type === file.type;

  const storeUploadSession = (session: UploadSession, file: File) => {
    const sessions = readStoredUploadSessions().filter((stored) => !storedSessionMatchesFile(stored, file));
    sessions.push({
      chunkSize: session.chunkSize,
      lastModified: file.lastModified,
      name: file.name,
      path: currentPath,
      sessionId: session.id,
      size: file.size,
      type: file.type
    });
    writeStoredUploadSessions(sessions);
  };

  const removeStoredUploadSession = (sessionId: string) => {
    writeStoredUploadSessions(readStoredUploadSessions().filter((session) => session.sessionId !== sessionId));
  };

  const getOrCreateUploadSession = async (file: File) => {
    const storedSession = readStoredUploadSessions().find((session) => storedSessionMatchesFile(session, file));

    if (storedSession) {
      const session = await api<UploadSession>(uploadSessionUrl(storedSession.sessionId)).catch(() => null);

      if (session) {
        return session;
      }

      removeStoredUploadSession(storedSession.sessionId);
    }

    const session = await createUploadSession(file);
    storeUploadSession(session, file);
    return session;
  };

  const completeUploadSession = async (sessionId: string) =>
    api<UploadResult>(`${uploadSessionUrl(sessionId)}/complete`, {
      body: JSON.stringify({}),
      method: "POST"
    });

  const cancelUploadSession = async (sessionId: string) => {
    removeStoredUploadSession(sessionId);
    await api<{ ok: true }>(uploadSessionUrl(sessionId), {
      method: "DELETE"
    }).catch(() => {});
  };

  const uploadChunkWithRetry = async (
    session: UploadSession,
    file: File,
    fileIndex: number,
    totalFiles: number,
    chunkIndex: number,
    chunkCount: number
  ) => {
    const start = chunkIndex * session.chunkSize;
    const end = Math.min(file.size, start + session.chunkSize);
    const chunk = file.slice(start, end);

    for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt += 1) {
      if (uploadCancelled) {
        throw new DOMException("Upload cancelled.", "AbortError");
      }

      try {
        await sendUploadRequest(uploadChunkUrl(session.id, chunkIndex), chunk, file.type || "application/octet-stream", (loaded) => {
          const fileProgress = ((start + loaded) / file.size) * 100;
          const totalPercent = totalFiles > 1 ? ((fileIndex + fileProgress / 100) / totalFiles) * 100 : fileProgress;
          setUploadProgress(
            `Uploading ${fileIndex + 1} of ${totalFiles}`,
            `${file.name} · chunk ${chunkIndex + 1}/${chunkCount} · ${Math.round(fileProgress)}%`,
            totalPercent
          );
        });
        return;
      } catch (error) {
        if (uploadCancelled || (error instanceof DOMException && error.name === "AbortError") || attempt === CHUNK_RETRIES) {
          throw error;
        }

        setUploadProgress(
          `Retrying ${fileIndex + 1} of ${totalFiles}`,
          `${file.name} · chunk ${chunkIndex + 1}/${chunkCount} failed, retry ${attempt + 1}`,
          totalFiles > 1 ? (fileIndex / totalFiles) * 100 : (start / file.size) * 100
        );
      }
    }
  };

  const uploadResumableFile = async (file: File, index: number, total: number) => {
    const session = await getOrCreateUploadSession(file);
    const completedParts = new Set(session.uploadedParts.map((part) => part.index));
    const chunkCount = Math.ceil(file.size / session.chunkSize);
    activeUploadSessionId = session.id;

    setUploadProgress(
      `Uploading ${index + 1} of ${total}`,
      `${file.name} · ${formatSize(file.size)} · preparing chunks`,
      total > 1 ? (index / total) * 100 : 0
    );

    try {
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        if (completedParts.has(chunkIndex)) {
          continue;
        }

        await uploadChunkWithRetry(session, file, index, total, chunkIndex, chunkCount);
      }

      setUploadProgress(`Assembling ${index + 1} of ${total}`, `${file.name} · finalizing`, total > 1 ? ((index + 0.98) / total) * 100 : 98);
      const result = await completeUploadSession(session.id);
      removeStoredUploadSession(session.id);
      activeUploadSessionId = null;
      setUploadProgress(`Uploaded ${index + 1} of ${total}`, `${file.name} · complete`, ((index + 1) / total) * 100);
      return result.path;
    } catch (error) {
      if (uploadCancelled || (error instanceof DOMException && error.name === "AbortError")) {
        await cancelUploadSession(session.id);
      }

      throw error;
    }
  };

  const uploadBrowserFile = async (file: File, index: number, total: number) => {
    if (file.size > DIRECT_UPLOAD_LIMIT) {
      return uploadResumableFile(file, index, total);
    }

    return uploadDirectFile(file, index, total);
  };

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    uploadCancelled = false;
    const uploadedPaths: string[] = [];

    try {
      for (const [index, file] of files.entries()) {
        if (uploadCancelled) {
          break;
        }

        uploadedPaths.push(await uploadBrowserFile(file, index, files.length));
      }

      if (uploadCancelled) {
        setStatus("Upload cancelled.");
      } else {
        await load();
        const uploadedPath = uploadedPaths.find((path) => entries.some((entry) => entry.path === path));

        if (uploadedPath) {
          selectedPath = uploadedPath;
          await render();
        }

        setStatus(`Uploaded ${files.length} file${files.length === 1 ? "" : "s"} to /${currentPath}`);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStatus("Upload cancelled.");
      } else {
        const message = error instanceof Error ? error.message : "Upload failed.";
        setUploadProgress("Upload failed", message, 100);
        setStatus(message);
      }
    } finally {
      if (!uploadCancelled && !uploadProgress.hidden) {
        await wait(uploadTitle.textContent === "Upload failed" ? 3200 : 500);
      }
      uploadCancelled = false;
      clearUploadProgress();
    }
  };

  const setDragging = (isDragging: boolean) => {
    browser.classList.toggle("dragging", isDragging);
  };

  breadcrumbs.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-file-path]");

    if (button) {
      activeSection = "files";
      void load(button.dataset.filePath ?? "");
    }
  });

  sections.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-file-section]");

    if (!button) {
      return;
    }

    activeSection = (button.dataset.fileSection as FileSectionId | undefined) ?? "files";
    const section = activeSectionConfig();
    void loadSection(section);
  });

  list.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-file-action='settings']");

    if (action) {
      options.onOpenSettings?.();
      return;
    }

    const row = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-entry-path]");

    if (!row) {
      return;
    }

    selectedPath = row.dataset.entryPath ?? null;
    void render();
  });

  list.addEventListener("dblclick", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-entry-path]");

    if (row) {
      const entry = entries.find((candidate) => candidate.path === row.dataset.entryPath);
      void openEntry(entry ?? null).catch((error) => {
        setStatus(error instanceof Error ? error.message : "Open failed.");
      });
    }
  });

  browser.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      moveSelection(1);
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      moveSelection(-1);
    }

    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void openEntry();
    }

    if (event.key === "Escape" && currentPath) {
      event.preventDefault();
      event.stopPropagation();
      activeSection = "files";
      void load(parentPath(currentPath));
    }
  });

  browser.querySelector("[data-file-action='open']")?.addEventListener("click", () => {
    void openEntry().catch((error) => {
      setStatus(error instanceof Error ? error.message : "Open failed.");
    });
  });

  browser.querySelector("[data-file-action='new-folder']")?.addEventListener("click", async () => {
    const name = window.prompt("Folder name");

    if (!name) {
      return;
    }

    await api("/api/files/folder", {
      body: JSON.stringify({ name, path: currentPath }),
      method: "POST"
    });
    await load();
  });

  browser.querySelector("[data-file-action='new-text']")?.addEventListener("click", async () => {
    const name = window.prompt("Text file name", "note.txt");

    if (!name) {
      return;
    }

    await api("/api/files/text", {
      body: JSON.stringify({ content: "", name, path: currentPath }),
      method: "POST"
    });
    await load();
  });

  browser.querySelector("[data-file-action='upload']")?.addEventListener("click", () => {
    uploadInput.click();
  });

  uploadInput.addEventListener("change", async () => {
    const files = Array.from(uploadInput.files ?? []);

    if (files.length === 0) {
      return;
    }

    await uploadFiles(files);
    uploadInput.value = "";
  });

  uploadCancel.addEventListener("click", () => {
    uploadCancelled = true;
    const sessionId = activeUploadSessionId;
    activeUpload?.abort();
    if (sessionId) {
      void cancelUploadSession(sessionId);
    }
    clearUploadProgress();
    setStatus("Upload cancelled.");
  });

  dropTarget.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
  });

  dropTarget.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  dropTarget.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    setDragging(dragDepth > 0);
  });

  dropTarget.addEventListener("drop", async (event) => {
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);

    const files = Array.from(event.dataTransfer?.files ?? []);

    if (files.length === 0) {
      return;
    }

    await uploadFiles(files);
  });

  browser.querySelector("[data-file-action='rename']")?.addEventListener("click", async () => {
    const entry = selectedEntry();

    if (!entry) {
      return;
    }

    const name = window.prompt("New name", entry.name);

    if (!name || name === entry.name) {
      return;
    }

    await api("/api/files/rename", {
      body: JSON.stringify({ name, path: entry.path }),
      method: "POST"
    });
    await load();
  });

  browser.querySelector("[data-file-action='download']")?.addEventListener("click", () => {
    const entry = selectedEntry();

    if (entry?.type === "file") {
      void downloadEntry(entry).catch((error) => {
        setStatus(error instanceof Error ? error.message : "Download failed.");
      });
    }
  });

  browser.querySelector("[data-file-action='delete']")?.addEventListener("click", async () => {
    const entry = selectedEntry();

    if (!entry || !window.confirm(`Delete ${entry.name}?`)) {
      return;
    }

    await api(`/api/files?path=${encodeURIComponent(entry.path)}`, {
      method: "DELETE"
    });
    await load();
  });

  void load().then(() => browser.focus({ preventScroll: true }));
}
