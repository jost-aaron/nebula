# TMDB Metadata Design

Nebula uses TMDB as an optional, server-side metadata provider. Cinema scanning,
playback, local metadata, accounts, and watchlists do not depend on TMDB.

## Configuration and security

- An owner can save the TMDB API Read Access Token in Settings / Account. It is
  stored in the server-only SQLite data volume and is never returned after the
  write. `TMDB_API_TOKEN` remains a server/Compose fallback when no saved token
  exists. Nebula sends the effective token as an `Authorization: Bearer` header.
- The token value is never returned by an API, embedded in browser code,
  included in image URLs, or written to metadata. Missing configuration is a
  supported state.
- `TMDB_API_BASE_URL` exists only to point automated tests at a mock service; a
  deployment should leave it unset.
- Existing Nebula authorization applies. All signed-in users can read library
  data; only principals with `media.manage` can search, apply, or refresh shared
  metadata.

## Matching

Search begins with the file name or current local title. Normalization removes
the extension, separators, a detected year, season/episode tokens, and common
release/codec suffixes. The year is sent as `primary_release_year` for movies or
`first_air_date_year` for TV. Cinema's existing category selects `/search/movie`
or `/search/tv`; the UI can also let the user choose either kind.

For TV filenames containing `S02E03` or `2x03`, Nebula retains the coordinates
while searching for the series. After the user selects the series, the server
fetches both `/tv/{series_id}` and
`/tv/{series_id}/season/{season}/episode/{episode}`. Files without recognizable
coordinates continue to import series-level metadata.

Nebula does not silently apply search results. It displays candidates with type,
year, overview, rating, and artwork, and requires the user to select one. This
explicit confirmation is the ambiguity boundary; popularity or title similarity
alone is not treated as proof.

## Imported fields and storage

After selection, Nebula fetches `/movie/{id}` or `/tv/{id}` with credits and
imports title, sort title, release year, rating, genres, studio/network,
collection (movies), poster, backdrop, tagline, summary, and a bounded cast list.
Episode imports additionally store series title, season/episode numbers, air
date, episode title/summary/rating/credits, series poster, and episode still.
It stores the TMDB ID, media type, and import timestamp beside these fields in
the existing ignored `content/.cinema-metadata.json`. Watchlists remain per-user
in SQLite and are not touched.

Applying a match and refreshing are explicit mutations. Normal scans and
searches never replace metadata. Manual editing remains available after import;
refresh warns that it replaces provider-managed display fields with current TMDB
details. No raw TMDB response or unnecessary personal data is stored.

## Images and caching

TMDB image paths are converted server-side to HTTPS CDN URLs using documented
sizes: `w500` posters and `w1280` backdrops (smaller sizes in candidates). Empty
paths remain empty, preserving Nebula's local frame/fallback art. Failed browser
image loads fall back to local generated artwork. The chosen URLs and metadata
form the persistent cache; Nebula makes no automatic refresh calls. A user can
refresh a previously imported entry by its stored type and ID.

## Failure behavior

Requests have an eight-second timeout. Missing credentials, invalid credentials,
network failure, `429`, missing titles, and malformed payloads become concise,
credential-free errors. `Retry-After` is not exposed as a secret and callers are
told to retry later. No failed request changes local metadata. Cinema scanning,
manual editing, playback, and watchlists continue offline.

## Integration boundaries

Provider routes, UI/controller, types, and styles are isolated in
`server/cinemaTmdb.mjs`, `src/cinema/tmdbUi.ts`,
`src/shared/cinemaTmdbTypes.ts`, and `src/cinema/tmdb.css`. Core Cinema files
contain only narrow registration and display hooks, reducing conflicts with
parallel Cinema feature work.

## Attribution and terms

The Cinema metadata panel includes the required notice: "This product uses the
TMDB API but is not endorsed or certified by TMDB," with a link to TMDB. Before
public distribution, add an approved, unmodified TMDB logo to an About/Credits
surface, keeping it less prominent than Nebula branding. TMDB's developer API is
described as free for non-commercial attributed use; commercial deployment must
obtain the appropriate TMDB license. Operators must review the current TMDB API
terms before deployment.

References: [authentication](https://developer.themoviedb.org/docs/authentication-application),
[search and details](https://developer.themoviedb.org/docs/search-and-query-for-details),
[movie search](https://developer.themoviedb.org/reference/search-movie),
[TV search](https://developer.themoviedb.org/reference/search-tv),
[movie details](https://developer.themoviedb.org/reference/movie-details),
[TV details](https://developer.themoviedb.org/reference/tv-series-details),
[image basics](https://developer.themoviedb.org/docs/image-basics),
[rate limiting](https://developer.themoviedb.org/docs/rate-limiting), and
[attribution/FAQ](https://developer.themoviedb.org/docs/faq).
