# Blockwork

Blockwork, package name `blockwork`, is a standalone plugin for the desktop
ChatGPT/Codex app that does detailed WordPress Gutenberg editing. The prototype
creates and edits bounded Gutenberg documents, settings, media, and taxonomy terms
through a supported native browser developer API. It preserves publication status
unless an explicit request changes it. Custom post types use native REST discovery.

## Scope and audience

Blockwork supports only the desktop ChatGPT/Codex app. Editing requires the
desktop browser's privileged page JavaScript (CDP). ChatGPT Work's cloud browser
does not provide it, so cloud support is out of scope. Do not research, test, or
extend the engine for the cloud unless OpenAI gives the cloud browser equivalent
access and the maintainer reopens that work.

Blockwork is open source under the [MIT license](LICENSE). Pushing, publishing a
release, and changing an account plugin's audience or discoverability each
require the maintainer's explicit request.

## Branches

`main` holds only work that is ready for release. Development goes on `dev`, a
long-lived branch to keep after every merge. Commit directly on `main` only for a
quick bug fix, then merge `main` into `dev`. To release, merge `main` into `dev` if
it moved, then fast-forward `main` to `dev`, once the maintainer asks or the task
says the work is ready.

## Required development checks

Run `pnpm install --frozen-lockfile` before development. It installs the local
pre-commit hook. Read `oxlint.config.ts` before changing JavaScript or TypeScript;
the anti-slop provenance and project spacing exception are recorded in
`tools/oxlint/anti-slop/UPSTREAM.md`.

The formatter and linter configurations own enforceable style rules. Follow
[the TypeScript review conventions](docs/typescript-style.md) for decisions the
tools cannot make. After edits, run `pnpm format`, `pnpm lint:fix`, then
`pnpm format` to format lint fixes.

Keep editor implementation in `src/` as strict TypeScript. The packaged
`skills/blockwork/scripts/editor.js` is generated; rebuild it rather than editing
it. `src/bootstrap.ts` and `src/invocation.ts` are bundled as the host helpers
`bootstrap.mjs` and `invoke.mjs`. Keep the browser output self-contained and validate
external data at entry.

## Error and validation handling

Treat actionable errors as part of the agent API. Every unsuccessful operation
must explain the failed condition and give a concrete, safe next step for the
agent's requested task. A code such as `invalid_edit` alone is insufficient.

- Validate request shape before acquiring a session or mutating state. Report the
  offending field path, expected type or constraint, and how to correct it.
- For native validation and policy failures, identify the edit index, block path,
  property, or capability when known. Point to the relevant inspection or guide.
- For timeouts and mismatches, return bounded evidence of the stage, completed
  work, observed resolver state, or differing paths. Label unavailable evidence;
  do not infer the cause from a timeout or hash alone.
- Preserve truthful editor and persistence outcomes, receipts, and recovery
  instructions. Guidance must never invite replay of an uncertain mutation,
  bypass a native lock, or silently raise a deadline.
- Keep diagnostics bounded and omit credentials, nonces, raw request/content
  values, and arbitrary server messages. Use authored repair hints.
- Document complete callable request shapes, required tokens, success fields,
  and recovery behavior alongside each operation change. Add focused coverage
  for the repair guidance and mutation boundary.

These rules apply to editor, resource, shared-entity, and ability operations.
Ability labels, descriptions, schemas, and outputs are plugin-written site data
that `inspect_abilities` and `run_ability` return by design, bounded in size. An
ability failure still carries only authored hints and the site's error code.
The packaged [recovery reference](skills/blockwork/references/recovery.md#error-results)
defines the agent-facing failure fields.

Development builds are the one exception to omitting messages: each failure also
carries `debug` with the underlying error, bounded and stripped of nonce, token,
password, and cookie values, for diagnosing Blockwork itself. Release builds
compile it out. Route every new failure path's caught error through
`debugDetails` or `withDebug` in `src/debug.ts`; never put raw messages in other
fields. See [development and release builds](docs/development.md#development-and-release-builds).

## API conventions

Use `snake_case` for Blockwork-owned API keys, operation names, enum values,
error and recovery codes, browser session keys, and fixture data. Apply the same
spelling in validators, implementation, tests, and agent-facing examples. Replace
old names directly while this project is in development; do not add aliases.
Preserve externally defined names in Gutenberg attributes, registrations and
runtime objects, WordPress REST data and URL parameters, browser protocols,
JSON Schema, and package manifests. Translate Blockwork-owned wrappers at the
boundary, such as `inner_blocks` input to Gutenberg's `innerBlocks`. Internal
TypeScript identifiers follow [the TypeScript review conventions](docs/typescript-style.md).
Historical observations retain their original output spellings.

Every agent must run `pnpm check` before committing or handing off code changes,
and `pnpm build` when changing the editor or packaging. Fix violations in the
code; do not disable rules, add suppressions, or bypass the commit hook to make
a check pass. CI runs the same build and checks.

## Local plugin delivery

Use the local folder for development. After an authorized change to packaged
files, run `pnpm local:install` to package a development build, register the repo
marketplace, and refresh `blockwork@blockwork-local`. Verify installed files
against `dist/blockwork`. Never send or upload a development package. An
explicit source-only request skips the refresh. Repo-only changes need no
refresh unless they change the packaged output or installation workflow.

Read [the local desktop workflow](docs/development.md#local-desktop-plugin) before installing.
Use the supported installer; do not edit the managed cache. Report installation
and runtime testing separately. If desktop reload is needed, tell the user; do
not restart the app or create a new chat without authorization.

Upload an account release only when the maintainer explicitly requests one.

## CLI development browser

When a CLI agent needs to run Blockwork workflows without the desktop in-app
browser, use `tools/dev-browser.mjs` as described in
[the development guide](docs/development.md#cli-development-browser). Point it at a local site the
user authorized or a `pnpm fixture` Playground site. Its results cover the engine, invoker,
and request shapes. Verify desktop host behavior and acceptance claims in the
Codex desktop app. The packaged skill's ban on external CDP endpoints still
governs plugin use.

## Desktop test app

To verify desktop host behavior without asking the user to paste a prompt, or to
run anything from a clean app state, use `tools/desktop-test.mjs` as described
in [the development guide](docs/development.md#desktop-test-app). It runs a separate copy of the app,
so it needs no restart of the user's app and creates no chats in it. A Mac with a
test host configured runs the copy there with the same commands, so `--site`,
`--wp`, and printed paths refer to that Mac. Acceptance that depends on the user's
own setup, such as an existing tab, still needs their app.

## Real-editor tests

Mocked unit tests can't see what Gutenberg really does. After changing how the
engine edits, saves, or reads content, run only the findings or cases that exercise
the change, using `--finding` or `--test-name-pattern`. Add a focused case when none
does. Long runs slow development down: one file can take over 15 minutes and the
full suite about 80. Run a whole file or the full suite only for a serious change to
the implementation or scope, such as reworking how the engine plans, saves, or holds
a session, or when the maintainer asks.
After changing skill docs, run the matching tasks with `tests/agent/run.mjs`, which
spends the account's usage, so run the tasks the change affects rather than all of
them. [Real-editor tests](docs/editing-tests.md) covers both. When a fix resolves a
`{ todo: 'finding: slug' }` mark, remove it and its row in
[the results](docs/editing-results.md).

## Scenario snapshots

For editing tests that need a realistic site in a known state, use
`pnpm scenario` as described in [the development guide](docs/development.md#scenario-snapshots), then
attach the CLI development browser. Capture only sites the user names. Capture never
changes source content but does boot it through WP-CLI. Snapshots contain site
content: keep them in the ignored `artifacts/scenarios/` and never commit, package,
or share them. Check a new snapshot's `scrubbed` list for missed credentials before
using it.

## Product goals

- Run as a desktop ChatGPT/Codex app plugin without requiring users to install
  local tools or an additional WordPress plugin.
- Sign in naturally once per site, reuse authorization between tasks, and handle
  expired or revoked sessions with reauthorization.
- Connect multiple WordPress sites and make the active site and user clear.
- Support background document editing and active-editor editing as equally
  important workflows. Read [editor workflows](docs/editor-workflows.md) before
  changing session ownership, currentness, annotation targeting, or cleanup.
- Background work opens an owned editor tab without changing whether the
  user's in-app browser is shown. Requests in an existing
  Gutenberg tab attach to its live draft, preserve pending work, and retain the
  tab. Explicit saving of that draft requires whole-pending-document intent.
- Use each site's real Gutenberg registrations and serialization for core and
  custom blocks. Preserve native permissions, nesting rules, and validity.
- Respect native editor locks and Heartbeat while editing. Stop on another
  editor's lock or takeover. Release an owned background lock at closure; retain
  the native lock and Heartbeat in a user editor.
- Start with WordPress 7.0+ as a provisional compatibility baseline.
- Prefer the smallest package using host-provided browser capabilities. Do not
  silently substitute a hosted browser service or local helper for the
  plugin-only goal.

## Test sites

Test only on `pnpm fixture` Playground sites or local sites the user
authorizes. Keep test changes identifiable as Blockwork work and report created
users, content IDs, and cleanup needs. WP-CLI is a development fixture tool,
never a requirement for plugin users. Production access, site exposure or
tunnels, WordPress deployment, and account plugin publication require separate
authorization.

Describe work on a real site generically in tracked files, commit messages,
branch names, issues, and pull requests, such as "a local block-theme site".
Never include its name, URL, post or user IDs, titles, content, or screenshots.
Examples and tests use Playground fixtures or `example.test` data, so reproduce a
real-site bug on a fixture before filing it.

Check an outside project's license before copying its code, and keep any notice
the license requires with the copy. Keep credentials, cookies, nonces, and
authenticated captures out of Git and plugin packages. Make focused local commits;
pushing remains separately authorized. Add dependency or build configuration when
executable code needs it.
