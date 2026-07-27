# Files

Files is an integrated file browser for dashboard content.

## Content Root

All user-managed content lives under:

```text
content/
```

That folder is intentionally ignored by Git. It is mounted into the Docker
container at:

```text
/app/content
```

The file API is restricted to this folder. Requests that try to escape the
content root are rejected. Every Files operation also rejects symbolic links
in the requested path, so a link inside `content/` cannot expose or mutate a
host path outside it.

## Run-Time Architecture

The normal Vite dev server has been wrapped by `server/dev.mjs`.

That server does two jobs:

- Serves the Vite app.
- Exposes `/api/files/*` endpoints for the Files app.

The frontend Files app lives in:

```text
src/files/fileBrowser.ts
```

Files uses shared API helpers from:

```text
src/api/http.ts
```

That keeps desktop, browser, and Capacitor iOS clients aligned around the same
Server URL and optional bearer token settings.

## Current Features

- Browse folders.
- Open folders with one click.
- Breadcrumb navigation.
- Select files.
- Preview text files up to 1 MB.
- Preview common image files.
- Create folders.
- Create empty text files.
- Upload files.
- Drag and drop files into the current folder.
- See upload progress while files transfer.
- Cancel the active upload.
- Upload large files with resumable chunk sessions.
- Resume an interrupted large upload by selecting the same file again.
- Rename files and folders.
- Delete files and folders.
- Download files.
- Open Settings from the native-client empty state when a bundled iOS client
  needs a Server URL.

## API Endpoints

- `GET /api/files?path=<path>&limit=<1-500>&cursor=<offset>` - list a
  deterministic, bounded folder page. Responses include `nextCursor` when more
  entries remain.
- `GET /api/files/read?path=<path>` - preview/read a file.
- `GET /api/files/download?path=<path>` - download a file.
- `POST /api/files/folder` - create a folder.
- `POST /api/files/text` - create a text file.
- `PUT /api/files/upload?path=<folder>&name=<file>` - stream raw file bytes into
  the current folder. This is the small-file UI upload path.
- `POST /api/files/upload` - legacy small-file upload as base64 JSON.
- `POST /api/files/uploads` - create a resumable upload session.
- `GET /api/files/uploads/<id>` - inspect a resumable upload session and its
  completed chunks.
- `PUT /api/files/uploads/<id>/chunks/<index>` - upload one raw file chunk.
- `POST /api/files/uploads/<id>/complete` - assemble completed chunks into the
  final file.
- `DELETE /api/files/uploads/<id>` - cancel a resumable upload and remove its
  partial chunks.
- `POST /api/files/rename` - rename a file or folder.
- `DELETE /api/files?path=<path>` - delete a file or folder.

All Files requests are scoped through the configured API base URL. In the
desktop browser this is usually same-origin. In the iOS Capacitor client it can
be a baked development server URL from `./scripts/ios-sync-dev-server.sh` or a
runtime value saved in Settings -> Client -> Server URL.

When an API token is saved in Settings -> Client -> API Token, Files sends it as
a bearer token for JSON requests, preview/download fetches, and XHR uploads.

Account authorization uses the same helpers. Owners may browse, download,
upload, create, rename, and delete in the shared namespace. Members may browse,
preview, and download but receive `403` for mutations. Version one has no
per-folder visibility and never duplicates files per account.

## Notes

This is a local development content browser, not a general host filesystem
browser. Keep it scoped to `content/` unless the product intentionally grows a
permission model for broader access.

Uploads use `XMLHttpRequest` instead of `fetch` so the UI can show upload
progress and cancel the active request. Small files are sent as one streamed
request. Files larger than 64 MB are sliced in the browser and sent through a
resumable session as 64 MB chunks. The browser stores the session id in
`localStorage`, so selecting the same file again can continue from chunks that
already reached the server.

Resumable upload state lives under:

```text
content/.uploads/
```

That folder is hidden from the Files listing. Each upload session stores
metadata plus completed chunks. All upload modes create an atomic destination
reservation before writing. The reservation also records the admitted byte
count, so concurrent raw and resumable admissions share one capacity budget
instead of independently consuming the same reported free space. Resumable
reservations remain for the assembly copy because chunk files still occupy
space during completion. Chunk indexes must fall within the calculated part
count. Completion uses a same-filesystem, no-clobber hard link: if another
process creates the target first, the API returns `409`, leaves that file
untouched, and removes assembly temporaries. Successful completion removes the
session and reservation. Canceling the upload removes the session, reservation,
and partial chunks. Failed and disconnected raw uploads release their
reservation in a `finally` path.

`.uploads` is an internal namespace and cannot be addressed through any Files
read or mutation endpoint. Incomplete sessions expire after 24 hours by
default and are cleaned, including their destination reservations, during
subsequent upload admission. Capacity reservations are persisted under
`.uploads/.reservations`, making them visible to later admissions and allowing
expired transient reservations left by a process crash to be reclaimed.

The server streams upload requests with Node streams. If a browser cancels or
disconnects mid-chunk, the temporary chunk file is removed. Raw and resumable
uploads enforce a configured maximum size and preserve a minimum amount of
free filesystem space. Admission subtracts outstanding reservations before
checking the free-space floor. A streamed request without `Content-Length`
conservatively reserves the configured per-upload maximum. Defaults are 100 GiB
per upload and 256 MiB free;
operators can set `NEBULA_FILES_MAX_UPLOAD_BYTES`,
`NEBULA_FILES_MINIMUM_FREE_BYTES`, and `NEBULA_FILES_UPLOAD_TTL_MS`.

Directory metadata reads use bounded concurrency. File previews are limited to
1 MiB and include `nosniff` plus a restrictive sandbox policy. Active document
formats such as HTML, JavaScript, CSS, XML, and SVG are returned as inert plain
text; downloads always use attachment disposition.

Files combines canonical-path and per-segment symbolic-link rejection with
`O_NOFOLLOW` where the host supports it. Reads and writes use file handles and
compare the opened file identity with the path after opening; upload completion
revalidates both the parent and linked target. These checks substantially narrow
path-swap races. Portable Node does not expose an `openat(2)`-style
directory-relative API on every supported host, so Nebula does not claim to
defend against a hostile administrator concurrently rewriting the mounted
content tree. The content mount remains an operator trust boundary.

## iOS And CORS

The iOS app is a client, not a file server. It talks to the Docker-hosted Nebula
server through `/api/files/*`. Because Capacitor serves the bundled app from
`capacitor://localhost`, the dev server applies API-only CORS headers for
requests that include an `Origin` header.

Generated iOS web assets live under:

```text
ios/App/App/public/
```

That folder is generated by Capacitor sync and intentionally ignored by Git.
