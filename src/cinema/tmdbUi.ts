import type { CinemaEntry } from "../shared/cinemaTypes";
import type { CinemaTmdbCandidate, CinemaTmdbStatusResponse } from "../shared/cinemaTmdbTypes";
import { applyCinemaTmdbMatch, getCinemaTmdbCandidates, getCinemaTmdbStatus, refreshCinemaTmdbMetadata, searchCinemaTmdb } from "../api/cinemaApi";

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export const renderTmdbPanel = (entry: CinemaEntry, status: CinemaTmdbStatusResponse | null, candidates: CinemaTmdbCandidate[] = [], message = "") => `
  <div class="cinema-tmdb-panel">
    ${status?.configured === false ? `<div class="cinema-empty"><strong>TMDB is not configured</strong><span>An owner can add a token in Settings / Account, or set TMDB_API_TOKEN on the server. Cinema and manual metadata remain available.</span></div>` : ""}
    ${status?.configured !== false ? `<form data-cinema-tmdb-search class="cinema-tmdb-search">
      <label>Title <input name="query" value="${escapeHtml(entry.episode?.seriesTitle || entry.title)}" required /></label>
      <label>Year <input name="year" inputmode="numeric" value="${escapeHtml(entry.releaseYear)}" /></label>
      <button type="submit">Search TMDB</button>
    </form>` : ""}
    <p>${escapeHtml(message)}</p>
    <div class="cinema-tmdb-results">${candidates.map((candidate) => `
      <article class="cinema-tmdb-candidate">
        <span class="cinema-tmdb-art">${candidate.posterUrl ? `<img src="${escapeHtml(candidate.posterUrl)}" alt="" loading="lazy" onerror="this.remove()" />` : `<span>${escapeHtml(candidate.title.slice(0, 1).toUpperCase())}</span>`}</span>
        <div><small>${candidate.mediaType === "movie" ? "Movie" : "TV Show"}${candidate.year ? ` / ${escapeHtml(candidate.year)}` : ""}${candidate.seasonNumber !== null ? ` / S${candidate.seasonNumber} E${candidate.episodeNumber}` : ""}${candidate.rating ? ` / ${escapeHtml(candidate.rating)}` : ""}${candidate.confidence !== undefined ? ` / ${Math.round(candidate.confidence * 100)}% match` : ""}</small><strong>${escapeHtml(candidate.title)}</strong><p>${escapeHtml(candidate.overview || "No overview available.")}</p></div>
        <button type="button" data-cinema-action="tmdb-apply" data-tmdb-id="${candidate.id}" data-tmdb-type="${candidate.mediaType}" data-tmdb-season="${candidate.seasonNumber ?? ""}" data-tmdb-episode="${candidate.episodeNumber ?? ""}"${entry.tmdbId === candidate.id && entry.tmdbMediaType === candidate.mediaType ? " disabled" : ""}>${entry.tmdbId === candidate.id && entry.tmdbMediaType === candidate.mediaType ? "Current Match" : "Use This Match"}</button>
      </article>`).join("")}</div>
    <footer class="cinema-tmdb-attribution"><a href="https://www.themoviedb.org" target="_blank" rel="noreferrer">TMDB</a><span>This product uses the TMDB API but is not endorsed or certified by TMDB.</span></footer>
  </div>`;

interface TmdbControllerOptions {
  closeSheet: () => void;
  getSelected: () => CinemaEntry | null;
  openSheet: (html: string) => void;
  render: () => void;
  renderSheet: (entry: CinemaEntry, status: CinemaTmdbStatusResponse | null, candidates?: CinemaTmdbCandidate[], message?: string) => string;
  updateEntry: (entry: CinemaEntry, metadata: Record<string, unknown>) => CinemaEntry;
}

export const createCinemaTmdbController = (options: TmdbControllerOptions) => {
  let status: CinemaTmdbStatusResponse | null = null;
  const open = async () => {
    const selected = options.getSelected();
    if (!selected) return;
    options.openSheet(options.renderSheet(selected, status, [], "Checking TMDB configuration…"));
    const [statusResult, candidatesResult] = await Promise.allSettled([
      getCinemaTmdbStatus(),
      getCinemaTmdbCandidates(selected.path)
    ]);
    if (statusResult.status === "fulfilled") status = statusResult.value;
    const candidates = candidatesResult.status === "fulfilled" ? candidatesResult.value.candidates : [];
    const message = candidates.length
      ? selected.tmdbId
        ? "If this title is identified incorrectly, choose the correct alternative below."
        : "Nebula saved these possible matches during library processing. Choose the correct title."
      : statusResult.status === "rejected"
        ? statusResult.reason instanceof Error ? statusResult.reason.message : "TMDB status is unavailable."
        : "No saved alternatives are available. Search TMDB by title or partial title.";
    options.openSheet(options.renderSheet(selected, status, candidates, message));
  };
  const apply = async (button: HTMLButtonElement) => {
    const selected = options.getSelected();
    if (!selected) return null;
    button.disabled = true;
    button.textContent = "Applying…";
    try {
      const result = await applyCinemaTmdbMatch({
        episodeNumber: button.dataset.tmdbEpisode ? Number(button.dataset.tmdbEpisode) : null,
        mediaType: button.dataset.tmdbType === "tv" ? "tv" : "movie",
        path: selected.path,
        seasonNumber: button.dataset.tmdbSeason ? Number(button.dataset.tmdbSeason) : null,
        tmdbId: Number(button.dataset.tmdbId)
      });
      options.closeSheet();
      return options.updateEntry(selected, result.metadata);
    } catch (error) {
      button.disabled = false;
      button.textContent = error instanceof Error ? error.message : "Apply failed";
      return null;
    }
  };
  const refresh = async (entry: CinemaEntry, button: HTMLButtonElement) => {
    button.disabled = true;
    button.textContent = "Refreshing…";
    try { return options.updateEntry(entry, (await refreshCinemaTmdbMetadata(entry.path)).metadata); }
    catch (error) {
      button.disabled = false;
      button.textContent = error instanceof Error ? error.message : "Refresh failed";
      return null;
    }
  };
  const submitSearch = async (form: HTMLFormElement) => {
    const selected = options.getSelected();
    if (!selected) return;
    const data = new FormData(form);
    const button = form.querySelector<HTMLButtonElement>("button[type='submit']");
    if (button) { button.disabled = true; button.textContent = "Searching…"; }
    try {
      const result = await searchCinemaTmdb({ category: selected.category, path: selected.path, query: String(data.get("query") ?? ""), year: String(data.get("year") ?? "") });
      options.openSheet(options.renderSheet(selected, status, result.candidates, result.candidates.length ? "Select the correct match. Nothing is applied automatically." : "No TMDB matches found."));
    } catch (error) {
      options.openSheet(options.renderSheet(selected, status, [], error instanceof Error ? error.message : "TMDB search failed."));
    }
  };
  return { apply, open, refresh, submitSearch };
};
