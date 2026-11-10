# Contributing to Blockwork

Install Node 22.18 or later and pnpm, then run `pnpm install --frozen-lockfile`.
The install sets up the local commit hook. Read [the development guide](docs/development.md)
for fixture setup, host requirements, and detailed commands.

## Source map

- `index.ts`, `session.ts`, and `contracts.ts` route editor operations, manage sessions, and define request contracts.
- `bootstrap.mjs` and `invocation.ts` connect the desktop host to the browser engine.
- `documents.ts`, `document-view.ts`, `shared.ts`, `resources.ts`, and `abilities.ts` handle documents, shared entities, REST resources, and abilities.
- `edits.ts`, `native-controls.ts`, `initialization.ts`, `inspection.ts`, and `catalog.ts` plan edits and inspect native blocks and controls.
- `canvas.ts`, `view.ts`, and `measure.ts` prepare and inspect the editor canvas and viewport.
- `comments.ts`, `explicit-footnotes.ts`, and `structural-footnotes.ts` handle comments and footnote edits.
- `query.ts`, `pattern-sections.ts`, and `styling.ts` handle Query previews, pattern sections, and styles.
- `link-map.ts`, `media-map.ts`, and `uploads.ts` map links and media and set upload limits.
- `persistence.ts` and `preservation.ts` verify saved and preserved content.
- `native.ts`, `wordpress.ts`, `schema.ts`, and `values.ts` provide WordPress types, native requests, validation, and value helpers.
- `errors.ts`, `debug.ts`, and `timing.ts` provide failure reporting, development diagnostics, and operation timing.

The [skill references](skills/blockwork/SKILL.md#references) document callable operations,
request shapes, and recovery. The generated `skills/blockwork/scripts/editor.js` comes
from `src/`; rebuild it instead of editing it.

## Tests and checks

- `pnpm check` runs formatting, lint, type checks, and the mocked unit tests in `tests/*.test.mjs`. Run it for every change.
- `pnpm build` runs checks and packages the plugin. Run it for editor or packaging changes.
- `pnpm test:integration` runs the WordPress fixture and REST integration tests in `tests/integration/`.
- `pnpm test:editing` exercises the engine against real Gutenberg in `tests/editing/`. Select the affected cases after editing, saving, or reading changes.
- `pnpm test:agent` runs natural-language tasks in `tests/agent/` through a desktop app. Select affected tasks after skill documentation changes; this uses account usage.

See [real-editor tests](docs/editing-tests.md) for selectors and fixture details. Desktop
host behavior needs the [desktop test app](docs/development.md#desktop-test-app), not
just the engine suite. Test only on disposable Playground fixtures or local sites
explicitly authorized for testing.

## Local installation

Run `pnpm build` to check and make a release package, or `pnpm package` to make it
without the checks. For local development, run
`pnpm local:install` to build and install the development package. Follow the
[local desktop workflow](docs/development.md#local-desktop-plugin) to verify the
installed files and reload the app if needed.
