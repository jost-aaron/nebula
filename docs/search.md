# Search

Search is available from the Search app in the Applications strip. It uses the
reusable renderer in `src/search/renderSearchView.ts`.

## Behavior

Search behaves like a small Spotlight-style launcher:

- The input is focused when Search opens.
- Typing filters apps by name.
- ArrowDown and ArrowUp move through visible results.
- Enter launches the active result.
- Clicking a result launches that app.

The Search app opens as a full-screen app surface, using the same launch
animation as other apps.

## Scope

Search currently only matches app names. It does not yet search settings,
commands, media, or app content.

Good future extensions:

- Include app descriptions and IDs.
- Add command results.
- Add settings results.
- Add recent apps.
- Add fuzzy matching.
- Add global keyboard shortcut support.
