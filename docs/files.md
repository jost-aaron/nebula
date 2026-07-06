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
content root are rejected.

## Run-Time Architecture

The normal Vite dev server has been wrapped by `server/dev.mjs`.

That server does two jobs:

- Serves the Vite app.
- Exposes `/api/files/*` endpoints for the Files app.

The frontend Files app lives in:

```text
src/files/fileBrowser.ts
```

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

## API Endpoints

- `GET /api/files?path=<path>` - list a folder.
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
metadata plus completed chunks. Completing the session assembles the chunks into
the target file and removes the session folder. Canceling the upload removes
the session folder and any partial chunks.

The server streams upload requests with Node streams. If a browser cancels or
disconnects mid-chunk, the temporary chunk file is removed.
