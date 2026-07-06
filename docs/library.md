# Library

Library is available from the left rail. It shows all installed applications in
an app-grid layout inspired by iOS-style app libraries.

## Behavior

- The Library rail opens a system panel.
- Apps are loaded from `src/apps.ts`.
- Each app appears as a rounded icon with a label.
- Icons use a staggered scale/fade entrance animation.
- Clicking an app launches it through the shared full-screen app surface.

## Implementation

The view is rendered by `src/library/renderLibraryView.ts`.

`src/main.ts` binds `[data-library-app]` buttons to `launchApp(app)`.

The animation is CSS-only:

- `.library-app`
- `.library-icon`
- `@keyframes appIconEnter`

Reduced-motion users get a near-instant animation.

## Future Ideas

- Group apps by category.
- Add pinned/favorites.
- Add drag-to-reorder once persistent state exists.
- Add controller grid navigation.
- Add folders or category clusters.
