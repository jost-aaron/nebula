const DEFAULT_BASE_URL = "https://api.themoviedb.org/3";
const IMAGE_BASE_URL = "https://image.tmdb.org/t/p";
const REQUEST_TIMEOUT_MS = 8_000;

const safeText = (value) => typeof value === "string" ? value.trim() : "";
const validId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const validType = (value) => value === "movie" || value === "tv" ? value : null;
const yearFromDate = (value) => /^\d{4}/.exec(safeText(value))?.[0] ?? "";
const imageUrl = (filePath, size) => safeText(filePath) ? `${IMAGE_BASE_URL}/${size}${safeText(filePath)}` : "";

export const normalizeMediaQuery = (value = "") => {
  const withoutExtension = String(value).replace(/\.[a-z0-9]{2,5}$/i, "");
  const year = /(?:^|[. _\-(])((?:19|20)\d{2})(?=$|[. _\-)])/i.exec(withoutExtension)?.[1] ?? "";
  const episodeMatch = /(?:^|[. _-])(?:s(\d{1,2})e(\d{1,3})|(\d{1,2})x(\d{1,3}))(?=$|[. _-])/i.exec(withoutExtension);
  const seasonNumber = Number(episodeMatch?.[1] ?? episodeMatch?.[3] ?? 0) || null;
  const episodeNumber = Number(episodeMatch?.[2] ?? episodeMatch?.[4] ?? 0) || null;
  const title = withoutExtension
    .replace(episodeMatch?.[0] ?? /$^/, " ")
    .replace(/(?:^|[. _\-(])(?:19|20)\d{2}(?=$|[. _\-)])/i, " ")
    .replace(/(?:^|[. _-])(?:2160p|1080p|720p|480p|360p|240p|uhd|hdr10?|dv|bluray|brrip|bdmux|webmux|web[ ._-]?dl|webrip|hdtv|x26[45]|h26[45]|hevc|aac|dts|remux)(?=$|[. _-]).*$/i, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { episodeNumber, query: title || withoutExtension.trim(), seasonNumber, year };
};

const tmdbError = (status, message, retryAfter = "") => Object.assign(new Error(message), { expose: true, retryAfter, status });

export const createTmdbClient = ({
  baseUrl = process.env.TMDB_API_BASE_URL || DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  token = process.env.TMDB_API_TOKEN || "",
  tokenProvider = () => token
} = {}) => {
  const currentToken = () => safeText(tokenProvider());

  const request = async (pathname, searchParams = {}) => {
    const requestToken = currentToken();
    if (!requestToken) {
      throw tmdbError(503, "TMDB metadata is not configured. Add a token in Settings or set TMDB_API_TOKEN on the server.");
    }

    const url = new URL(`${baseUrl.replace(/\/$/, "")}${pathname}`);
    Object.entries(searchParams).forEach(([key, value]) => {
      if (value !== "" && value !== undefined && value !== null) url.searchParams.set(key, String(value));
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;

    try {
      response = await fetchImpl(url, {
        headers: { accept: "application/json", authorization: `Bearer ${requestToken}` },
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") throw tmdbError(504, "TMDB did not respond in time.");
      throw tmdbError(502, "TMDB is currently unreachable. Cinema remains available with local metadata.");
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw tmdbError(502, "TMDB rejected the configured credential.");
      if (response.status === 429) throw tmdbError(503, "TMDB rate limited this request. Try again shortly.", response.headers.get("retry-after") ?? "");
      if (response.status === 404) throw tmdbError(404, "The selected TMDB title no longer exists.");
      throw tmdbError(502, "TMDB could not complete the metadata request.");
    }

    try {
      return await response.json();
    } catch {
      throw tmdbError(502, "TMDB returned an invalid response.");
    }
  };

  const candidate = (item, mediaType) => ({
    backdropUrl: imageUrl(item.backdrop_path, "w780"),
    episodeNumber: null,
    id: validId(item.id),
    mediaType,
    overview: safeText(item.overview),
    posterUrl: imageUrl(item.poster_path, "w342"),
    rating: Number.isFinite(item.vote_average) ? item.vote_average.toFixed(1) : "",
    seasonNumber: null,
    title: safeText(mediaType === "movie" ? item.title : item.name),
    year: yearFromDate(mediaType === "movie" ? item.release_date : item.first_air_date)
  });

  const search = async ({ category, episodeNumber = null, query, seasonNumber = null, year }) => {
    const mediaTypes = category === "movies" ? ["movie"] : category === "tv" ? ["tv"] : ["movie", "tv"];
    const groups = await Promise.all(mediaTypes.map(async (mediaType) => {
      const yearKey = mediaType === "movie" ? "primary_release_year" : "first_air_date_year";
      const body = await request(`/search/${mediaType}`, { include_adult: false, language: "en-US", query, [yearKey]: year });
      if (!Array.isArray(body?.results)) throw tmdbError(502, "TMDB returned an invalid search response.");
      return body.results.slice(0, 10).map((item) => ({
        ...candidate(item, mediaType),
        episodeNumber: mediaType === "tv" ? episodeNumber : null,
        seasonNumber: mediaType === "tv" ? seasonNumber : null
      })).filter((item) => item.id && item.title);
    }));
    return groups.flat().slice(0, 12);
  };

  const details = async (mediaTypeValue, idValue) => {
    const mediaType = validType(mediaTypeValue);
    const id = validId(idValue);
    if (!mediaType || !id) throw tmdbError(400, "A valid TMDB media type and identifier are required.");
    const item = await request(`/${mediaType}/${id}`, { append_to_response: "credits", language: "en-US" });
    if (!item || typeof item !== "object" || validId(item.id) !== id) throw tmdbError(502, "TMDB returned an invalid details response.");
    const title = safeText(mediaType === "movie" ? item.title : item.name);
    if (!title) throw tmdbError(502, "TMDB details did not include a title.");
    const companies = Array.isArray(item.production_companies) ? item.production_companies : [];
    const networks = Array.isArray(item.networks) ? item.networks : [];
    const cast = Array.isArray(item.credits?.cast) ? item.credits.cast : [];
    return {
      backdropUrl: imageUrl(item.backdrop_path, "w1280"),
      cast: cast.slice(0, 12).map((person) => safeText(person.name)).filter(Boolean).join(", "),
      collection: safeText(item.belongs_to_collection?.name),
      genres: Array.isArray(item.genres) ? item.genres.map((genre) => safeText(genre.name)).filter(Boolean) : [],
      posterUrl: imageUrl(item.poster_path, "w500"),
      rating: Number.isFinite(item.vote_average) ? item.vote_average.toFixed(1) : "",
      releaseYear: yearFromDate(mediaType === "movie" ? item.release_date : item.first_air_date),
      sortTitle: title,
      studio: safeText(companies[0]?.name || networks[0]?.name),
      summary: safeText(item.overview),
      tagline: safeText(item.tagline),
      title,
      tmdbId: id,
      tmdbImportedAt: new Date().toISOString(),
      tmdbMediaType: mediaType
    };
  };

  const episodeDetails = async (seriesIdValue, seasonNumberValue, episodeNumberValue) => {
    const seriesId = validId(seriesIdValue);
    const seasonNumber = Number(seasonNumberValue);
    const episodeNumber = Number(episodeNumberValue);
    if (!seriesId || !Number.isInteger(seasonNumber) || seasonNumber < 0 || !Number.isInteger(episodeNumber) || episodeNumber < 1) {
      throw tmdbError(400, "Valid TMDB series, season, and episode identifiers are required.");
    }
    const [series, episode] = await Promise.all([
      request(`/tv/${seriesId}`, { append_to_response: "credits", language: "en-US" }),
      request(`/tv/${seriesId}/season/${seasonNumber}/episode/${episodeNumber}`, { append_to_response: "credits", language: "en-US" })
    ]);
    const seriesTitle = safeText(series?.name);
    const episodeTitle = safeText(episode?.name);
    if (!seriesTitle || !episodeTitle || validId(series?.id) !== seriesId) throw tmdbError(502, "TMDB returned invalid episode details.");
    const companies = Array.isArray(series.production_companies) ? series.production_companies : [];
    const networks = Array.isArray(series.networks) ? series.networks : [];
    const episodeCast = Array.isArray(episode.credits?.cast) ? episode.credits.cast : Array.isArray(episode.guest_stars) ? episode.guest_stars : [];
    return {
      backdropUrl: imageUrl(episode.still_path, "w1280") || imageUrl(series.backdrop_path, "w1280"),
      cast: episodeCast.slice(0, 12).map((person) => safeText(person.name)).filter(Boolean).join(", "),
      collection: seriesTitle,
      episode: { airDate: safeText(episode.air_date), episodeNumber, seasonNumber, seriesTitle },
      genres: Array.isArray(series.genres) ? series.genres.map((genre) => safeText(genre.name)).filter(Boolean) : [],
      posterUrl: imageUrl(series.poster_path, "w500"),
      rating: Number.isFinite(episode.vote_average) ? episode.vote_average.toFixed(1) : "",
      releaseYear: yearFromDate(episode.air_date),
      sortTitle: `${seriesTitle} S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`,
      studio: safeText(companies[0]?.name || networks[0]?.name),
      summary: safeText(episode.overview),
      tagline: "",
      title: episodeTitle,
      tmdbId: seriesId,
      tmdbImportedAt: new Date().toISOString(),
      tmdbMediaType: "tv"
    };
  };

  return { get configured() { return Boolean(currentToken()); }, details, episodeDetails, search };
};
