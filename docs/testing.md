# Testing And QA

There is no automated browser test suite yet. Current verification is a mix of
TypeScript checking and manual/in-browser QA.

## Required Check

```sh
docker compose run --rm dashboard npm run check
```

## API Smoke Checks

```sh
curl -s http://127.0.0.1:5173/api/files
curl -s http://127.0.0.1:5173/api/cinema/library
curl -s -I -H "Range: bytes=0-1023" "http://127.0.0.1:5173/api/cinema/media?path=South%20Park%20The%20Streaming%20Wars.mp4"
```

The Cinema media range request should return `206 Partial Content` when that
test file is present.

## Host Clean Check

```sh
test ! -d node_modules && test ! -d dist && echo "host clean"
```

## Manual Browser Smoke Test

Open:

```text
http://127.0.0.1:5173
```

Check:

- Dashboard heading is visible.
- GPU status says either `WebGPU · ...` or `Canvas fallback`.
- Four rail icons are visible.
- App strip shows Cinema, Arcade, Studio, Party, Settings, and Search.
- App strip includes Files.
- Clicking a tile updates the featured app.
- Double-clicking a tile launches the app surface.
- Open expands the focused app into the full-screen app surface.
- The details button opens the focused app detail panel.
- Escape closes the full-screen app surface.
- Close button hides the panel.
- Search, Library, and Settings rail buttons open shell panels.
- Sidebar Search filters apps by name and Enter launches the active result.
- The Search app filters apps by name and Enter launches the active result.
- Library shows all installed apps in a grid and clicking an app launches it.
- Cinema opens the local media browser and shows supported videos from
  `content/`.
- Cinema shows Movies, TV Shows, and Music category tabs.
- Cinema keeps the player hidden until a title is selected.
- Cinema can load selected media into the web player and the media endpoint
  supports byte-range requests.
- Files opens the local content browser and is scoped to the ignored `content/`
  folder.
- Files supports upload by button and drag/drop into the current folder.
- Files streams uploads, shows upload progress, and exposes a Cancel button
  while uploading.
- Files uses resumable chunk sessions for files larger than 64 MB.
- Re-selecting the same interrupted large file resumes from uploaded chunks.
- Home rail button clears shell panels.
- Settings shows Renderer, Display, Performance, Apps, GPU Limits, and Runtime
  diagnostics.
- The Settings app shows the same Settings menu as the sidebar Settings panel.

## Keyboard Test

- ArrowRight/ArrowDown moves focus forward.
- ArrowLeft/ArrowUp moves focus backward.
- Enter launches the focused app surface.
- Escape closes the active app surface first, otherwise closes panels and
  returns rail state to Home.

## Icon Regression Test

Rail icons previously duplicated because icon creation happened inside a repeated
render path.

Expected:

- `.rail-button` count is `4`.
- `.rail-button svg` count is `4`.
- Each rail button has exactly one `svg`.
- Repeated rail clicks do not change those counts.

Browser console snippet:

```js
Array.from(document.querySelectorAll(".rail-button")).map((button) => ({
  nav: button.getAttribute("data-nav"),
  icons: button.querySelectorAll("svg").length
}));
```

Every `icons` value should be `1`.

## Responsive Test

At a phone-like viewport, for example `390 x 844`:

- Bottom rail is visible.
- Detail panel does not overlap the bottom rail.
- Full-screen app surface fits within the viewport.
- Library grid uses three columns on phone-sized viewports.
- Cinema stacks the library and playback panel without overlap.
- Files layout keeps the list and preview usable on phone-sized viewports.
- App strip scrolls horizontally.
- Status pills wrap without text overlap.

## Future Automated Tests

Good next additions:

- Playwright smoke test in Docker.
- DOM tests for rail icon counts and panel state transitions.
- Visual screenshot checks for desktop and mobile.
- WebGPU capability test that accepts both WebGPU and Canvas fallback modes.
