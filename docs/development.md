# Developing Blockwork

This guide covers building, packaging, and testing Blockwork, and the local tools
for working on it. Agents working on this repository also follow
[AGENTS.md](../AGENTS.md).

## Develop and package

Use Node 22.18 or newer and the pnpm version pinned in `package.json` for local
development. The editor source is strict TypeScript in `src/`. Valibot validates
incoming data, and esbuild packages it with the editor as one JavaScript
expression. The installed plugin runs without local tools; building it from this
repository needs the tools the [README](../README.md#install) lists.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` checks Oxfmt formatting, then runs Oxlint, TypeScript checking,
compilation, and the Node test suite against the compiled browser file.
`pnpm build` requires those checks before packaging. `pnpm package` packages
without them, for people who only want to install the plugin. Run `pnpm format`, `pnpm lint:fix`, then `pnpm format` to apply
formatting and available lint fixes. `pnpm format:check` checks without rewriting files.

The [TypeScript style guide](typescript-style.md) follows Google's conventions
with 100-column wrapping and project readability rules. Oxfmt handles layout;
Oxlint handles enforceable code conventions. Whether names explain their purpose,
expressions are easy to follow, and functions have clear responsibilities still needs review.

Oxlint uses the generic rules from [anti-slop](https://github.com/dmmulroy/anti-slop)
with upstream defaults except statement spacing. The project spacing rule groups
short declarations and separates control flow. The copied rules, licenses, and pinned revision live in
`tools/oxlint/anti-slop/`. They are development tools and are excluded from the
plugin. Installation configures `.githooks/` so each commit checks formatting, lint, and
types. The GitHub Actions workflow runs `pnpm build` and, in five parallel jobs, the
integration tests on pushes and pull requests. Changes to root Markdown files or
`docs/` alone start no run.
Agent requirements are in [AGENTS.md](../AGENTS.md#required-development-checks).

For disposable WordPress integration tests, run `pnpm test:integration`.
Run `pnpm fixture:integration 7.1.4` for the desktop suite's users, shared entities,
locks, and session controls. Ctrl-C discards it. `pnpm fixture` keeps the smaller
paragraph fixture available, and `pnpm fixture --acf` adds ACF Pro with the editing
suite's ACF field groups and block; [real-editor tests](editing-tests.md) says
where the plugin copy lives. See [setup and performance](integration-fixture.md)
and [historical native results](history/integration-results.md).

`pnpm test:editing` runs Blockwork calls on real Gutenberg on Playground, and
`pnpm test:agent` scores natural-language requests through the desktop app. Neither
runs from `pnpm check` or CI. See [real-editor tests](editing-tests.md) and
[their results and open defects](editing-results.md).

`skills/blockwork/scripts/` is generated and ignored by Git. It holds the compiled
`editor.js`, the compiled `invoke.mjs` host helper for bounded Promise-handle calls,
and `bootstrap.mjs` bundled from `src/bootstrap.ts`. Run `pnpm compile` to refresh
them for local prototype use.

`tools/patches/` holds the pnpm dependency patches, so pass
`--patches-dir tools/patches` to `pnpm patch-commit`.

### Development and release builds

`pnpm compile`, the tests, the CLI development browser, and `pnpm local:install`
use development builds. Each failure in a development build also returns
`debug`: the underlying error's name, code, status, message, data, first stack
frames, and causes, bounded and with nonce, token, password, and cookie values
removed. It covers native and REST errors in the editor, host CDP errors and page
exceptions in the invoker, receipt storage, and screenshot failures.
`blockwork.build.debug` reports the mode.

`pnpm build` makes the release package, which compiles `debug` out. Agents then
get only the authored codes, labels, and hints. Send, upload, or test release
behavior only from that package. `tools/package.mjs --development` makes the
local install's package, named `blockwork-<version>-development.tar.gz`. Edit
the TypeScript in `src/`, not the generated scripts.

The build creates `dist/blockwork/` and `dist/blockwork-0.1.1.tar.gz` with an
explicit file allowlist. It bundles the scripts itself, so the package's mode
never depends on an earlier compile.
It excludes test configuration, screenshots, receipts, Git data, and developer
files. Packaging does not install, upload, or publish the plugin.

### Releases

To publish a version, set the same version in `plugin.json` and `package.json`,
release it to `main`, then push a matching annotated tag. Its message becomes the
release notes, so write what changed for users:

```sh
git tag -a v0.1.2 main
git push origin v0.1.2
```

The Release workflow runs the whole Check workflow on the tagged commit. It then
checks that the tag is annotated, points at a commit on `main`, and matches both
files, and publishes a GitHub release with the release package,
`blockwork-<version>.tar.gz`.

## Local desktop plugin

Run this from the repository with the Codex CLI on `PATH`:

```sh
pnpm local:install
```

It runs the checks, packages a development build, registers this repo's
`blockwork-local` marketplace, and installs or refreshes `blockwork@blockwork-local`. The marketplace points at
`dist/blockwork/`, which contains only the generated plugin package. Edit source
files in the repo, not that generated folder. Repeat the command after changes;
no account upload is involved. Same-version file refresh is verified with Codex
CLI 0.159.3, so local iteration does not require a version bump.

In the desktop Plugins Directory, this marketplace is named **Blockwork local**.
Use its Blockwork entry rather than any other installed copy. The app loads a cached
installation, so verify the installed skill and editor against `dist/blockwork/`.
If an existing app session has not picked up the update, tell the user that a
reload may be needed. Installation does not establish successful WordPress editing.

Agents refresh this local installation after packaged changes by default.
Source-only requests skip installation.

## CLI development browser

`tools/dev-browser.mjs` lets CLI agents such as Claude Code or the Codex CLI run
Blockwork workflows without the desktop app. It opens an `agent-browser` Chromium
session and loads the compiled `bootstrap.mjs`. The connection to that browser
takes the place of the desktop tab's `cdp` capability. The engine, invoker, and
receipts are the plugin's own. The script is a development tool and is not packaged.

```sh
pnpm compile
node tools/dev-browser.mjs start 'https://example.test/wp-admin/post.php?post=ID&action=edit' \
  --wp ~/Sites/example --user admin
node tools/dev-browser.mjs run <<'JS'
const connection = await blockwork.connect({
  target: { site_url: 'https://example.test', post_id: ID, post_type: 'page' },
  workflow: 'attached',
});
state.connection = connection;
return connection.blocks;
JS
node tools/dev-browser.mjs stop
```

With `--wp`, `start` signs in through a WP-CLI auth cookie for `--user`, which
defaults to `admin`. A `pnpm fixture` Playground site signs in by itself, so omit `--wp`.
For a `.local` URL, `start` maps `*.local` to the IPv4 address the system resolves
for that host, because Chromium's own lookup of `.local` names can take over 30
seconds on macOS. Set `AGENT_BROWSER_ARGS` yourself to launch Chromium differently.
Add `--headed` to watch the browser.

The browser keeps its profile in `~/.local/share/blockwork/profiles/<session>`,
and `stop` leaves it in place, so a sign-in lasts across starts until WordPress
expires it. To sign in by hand, such as on a site with no WP-CLI, run `start`
with `--headed`, sign in in that window, and later starts reuse the login.
Remove the folder for a clean browser.

A `run` snippet is the body of an async function. It receives `blockwork`, the
bootstrap caller; `cdp`, the tab capability; `state`, an object kept between runs;
`nodeRepl.write()`; `selectTab(urlSubstring)`; and `saveImage(bytes, name?)`,
which writes a JPEG shot under `$TMPDIR/blockwork-dev/images/` and returns its
path. The caller gets a tab with the desktop tab's shape, its `cdp` capability,
which also takes Blockwork's screenshots. `selectTab` binds a different
page for later runs and returns its caller. Top-level variables do not persist,
so keep values on `state`. The return value and each write print as JSON. The
first run after `pnpm compile` reloads the engine and creates a new caller, so
call `connect` again; the page's session survives. Do not keep the caller itself
on `state`, since it would keep running the old engine. Use
`agent-browser --session blockwork-dev` for
screenshots, viewports, clicks, and new tabs. Receipts and the server log go
under `$TMPDIR/blockwork-dev/`. Release Blockwork sessions before `stop`.

To run a second browser beside the first, such as from another worktree, set
`BLOCKWORK_DEV_SESSION` to a lowercase name on every `start`, `run`, and `stop`.
That name replaces `blockwork-dev` in the agent-browser session, the
`$TMPDIR` directory, and the profile folder.

This harness does not cover the desktop host: tab ownership and hidden tabs,
`cua_repl` documentation, viewport controls, sign-in handoff, or how a desktop
agent loads the skill. Check those, and any acceptance claim, in the Codex desktop
app with the installed plugin.

## Desktop test app

`tools/desktop-test.mjs` runs prompts in a separate, disposable copy of the
ChatGPT desktop app, so an agent can test a plugin from a clean state with no
action from the user. The user's own app keeps running, and its settings, chats,
and browser sign-ins are not touched. The copy is the real installed app with the
real in-app browser, so its results cover the desktop host, which the
[CLI development browser](#cli-development-browser) can't.

```sh
node tools/desktop-test.mjs start --blockwork --effort medium \
  --site https://site.test/ --wp /path/to/wordpress --user admin
node tools/desktop-test.mjs run --timeout 600 'Change the page title to...'
node tools/desktop-test.mjs stop
```

`start` replaces any earlier test folder, packages a development build for
`--blockwork`, launches the copy in the background, maximized unless a window file
below says otherwise, and runs one short
chat. Chats run with the sidebar hidden, so the in-app browser gets the width a
person would give it. Leave out `--blockwork` to test without the plugin. `--site`
opens that site in the short chat's browser by typing its URL, and needs `--wp` and
`--user`, which sign the test browser in through WP-CLI, or `--cookies` with a JSON
file of browser cookies for a site with no WP-CLI, such as a Playground fixture. With
`--blockwork` it also allows Blockwork's page access for that site. `--window 1600x1000`
sets the window's size in points.

`run` opens a new chat, sends the prompt, waits for the chat to finish, and prints
JSON with `status`, `started_at`, `completed_at`, `duration_seconds`, `tool_calls`,
`tokens`, `model`, `effort`, `final_message`, and the `rollout` transcript path.
`status` stays `running` if the chat outlasts `--timeout`, and `aborted` means it
stopped early. Only send one prompt at a time. The script doesn't reset anything on
the site, so reset test content between runs.

`--follow-up` sends the prompt to the chat on screen instead, and the output covers
only that turn, except `tokens`, which counts the whole chat. With it, `--open <url>` first opens the page in a new tab of the
chat's in-app browser by typing the URL, as a person would. That tab is the one to
use for attached-editor checks: Gutenberg's canvas stays blank in a tab Browser Use
opened, because the host blocks its `blob:` frame. `--attach <file>` drags a file
from disk onto the composer before the prompt is typed. `--record <file.mov>`
records only the copy's window with `screencapture`, types the prompt at a reading
pace, hides the account's avatar and usage meter, the composer's caret, and the
sheen on status text such as "Thinking", starts before `--open` so the page's first
frames are in it, pauses 4 seconds before the prompt so the window can catch up, and adds `recording.started_at`
and `recording.input_at`, when the attachment or first character went in, to the
output. The program that runs the script needs Screen Recording permission.

`stop` closes the copy and removes `~/Library/Application Support/Codex Test`,
including every transcript, so copy any transcript you need first.

Each command exits once it has printed. Every wait inside it has a deadline, so a
stall exits non-zero with an error naming the stage, and a failed `start` closes
the copy. A chat that outlasts `--timeout` still reports `status: running`.

Each `start` is clean in these ways:

- It has its own `HOME` and `CODEX_HOME`, so global `AGENTS.md`, personal skills,
  memories, MCP servers, connectors, and the login-shell `PATH` aren't loaded.
- Skills from plugins on the ChatGPT account are switched off, because the app
  installs those plugins whatever its config says.
- Computer Use is switched off, because the separate `HOME` breaks the path to its
  socket, and every `cua.getState` would wait about 5 seconds for it to time out.
- Chrome is switched off, because a chat could otherwise list the user's real Chrome
  tabs through the Codex Chrome extension, which both apps share.
- The composer doesn't suggest a next message, which a follow-up would otherwise
  find already in its input.
- It uses the app's default sandbox, with approvals off so a chat can't stop to
  wait for an answer. It runs `gpt-6.1-terra` at medium effort in Fast mode. Choose
  another model or effort with `--model` and `--effort`.
- It starts with the app's first-run screens, announcements, and tips marked as
  seen, so they don't cover a person's view of a test or take its focus.

It isn't a new user. It shares the signed-in account and its usage limits, through
a link to the real `auth.json`, because a copy's refresh token could log the real
app out. It also links the app's document runtime cache, so each start doesn't
download about 2 GB, and the login keychain, because a local site's certificate
authority may be trusted only there. It shows a second app icon in the Dock while
it runs.

To place the copy's window on one Mac, write its position and size to
`~/.config/blockwork/test-window.json` on that Mac, such as
`{ "x": 100, "y": 30, "width": 1600, "height": 1200 }`. The app ignores bounds that
fall outside the connected displays.

To keep the copy and the [real-editor tests](editing-tests.md) off a Mac you're
using, put another Mac's SSH host in `~/.config/blockwork/test-host`.
`tools/desktop-test.mjs`, `tests/agent/run.mjs`, and `tests/editing/run.mjs` then
run on that Mac with the same commands and output. Each `start` and suite run first
copies this checkout, including uncommitted changes, to
`~/.cache/blockwork-tests` there and installs its dependencies.
That Mac needs the app signed in, Node, pnpm, `agent-browser`, and a logged-in
desktop session. `--site`, `--wp`, `--cookies`, `--out`, and the `rollout` path all
refer to that Mac, so run any fixture or site script there too. The agent suite
moves its results back to `artifacts/agent-tasks/` here. Compare timings only with
runs from the same Mac. Remove the file to test on this Mac again, or set
`BLOCKWORK_TEST_HERE=1` for one command.

### Demo clip

`node tools/demo.mjs` records Blockwork editing a page in the desktop test app and
cuts the recording for a README. It starts a Playground site with the editing
suite's landing page, says "Hi" in a new chat so the chat has a browser, renames the
chat "Landing page hero" from its menu, and hides that first turn. It then records
each step in `tools/demo.mjs` as a follow-up in that chat with `run --follow-up
--record`, and the first one also opens the page's editor in the chat's browser by
hand with `--open`, so its raw recording starts with that navigation. The steps restyle the hero,
attach `tools/demo/skyline.jpg` for its background with `--attach`, and make the
hero taller on phones after switching the editor to its mobile preview. Each step's clip
plays the typing and the answer at real speed and speeds up the work between them,
with a label that says how much, and the clips join into one. It writes
`raw-<step>.mov`, `segment-<step>.mp4`, `run.json`, the chat's transcript as
`chat.jsonl`, `demo.mp4`, and `demo.gif` to the ignored
`artifacts/demo/<time>/`, or to `--out`. The GIF is the widest of a few
sizes that stays under GitHub's 10 MB limit for images, and it skips frames that
repeat the one before, keeping one a second.

Change the requests by editing the steps, and the model, effort, or window size with
`--model`, `--effort`, and `--window`. Without `--window`, the window fills the
screen, unless the window file described above sets other bounds. `--cut <folder>` cuts an earlier recording again without running the app.
It needs ffmpeg with the `drawtext` filter, which some Homebrew builds leave
out; a recording made on a Mac without it can be cut on another with `--cut`. It
spends the account's usage. It records on the Mac it runs
on, even with a test host, because `screencapture` over SSH can't capture a window
without Screen Recording permission for SSH. To record on the test host, start it
there from an app that has that permission, such as T3 Code.

Review the clip before sharing it. The window shows the chat, the model name, and
the test site, and nothing from the user's own setup, but a model can still write
something unexpected in its answer. The README shows `demo.gif` from
`docs/demo.gif`, so copy a new clip there to replace it.

## Scenario snapshots

`tools/scenario.mjs` turns a local WordPress site into a trimmed Playground
snapshot, so agents can start an editing scenario from a known state and throw
the result away. Scenarios are defined in `~/.config/blockwork/scenarios.json`,
outside the repository, because they name local sites. Snapshots go to the ignored
`artifacts/scenarios/<name>/` and hold site content; keep them out of Git and
packages.

```sh
pnpm scenario list
pnpm scenario capture example
pnpm scenario up example
node tools/dev-browser.mjs start '<editor URL printed by up>'
```

`capture` runs WP-CLI on the source with plugins and themes skipped and never
changes its content; mu-plugins still load. It supports single sites with the
`wp_` table prefix and uploads in `wp-content/uploads`. It copies the active
theme and plugins, following symlinks, without `.git`, `node_modules`, `.env*`,
`auth.json`, or theme dev directories. It keeps the uploads that the scenario's
pages and site-wide content reference: patterns, global styles, templates,
navigation, the logo, and configured post types. The database is exported with
relative upload URLs and loaded into SQLite inside Playground, where the import
is checked against the source's row counts.

Before any captured plugin runs, the snapshot loses revisions, trash,
auto-drafts, transients, and configured post types and tables. Options with
credential-like names are blanked, as are credential-like keys inside serialized
or JSON settings. Session tokens, application passwords, activation keys, and
password hashes are removed, and other users get placeholder emails. Review
`scrubbed` in `scenario.json`; add stores the patterns miss to `scrub_options`
or `empty_tables`. Configured empty pages are created last. Ctrl-C or a failure
removes the dump and staging copy. A recapture moves the previous snapshot to
the Trash.

`up` clones the snapshot copy-on-write, boots the captured WordPress and PHP
versions, signs in the scenario user, and prints editor URLs for its pages. Edits
change only the clone; Ctrl-C discards it. The snapshot's mu-plugin redirects
omitted uploads to the source site, which must be running to serve them. It also
lets Acorn-based themes boot, since Playground's PHP reports the `cli` SAPI for
web requests.

| Field | Purpose |
| --- | --- |
| `name`, `source.wordpress_root`, `source.url` | Snapshot name and the local site it reads |
| `user` | Account kept intact and signed in by `up` |
| `pages` | Named page IDs whose media is kept and whose editor URLs `up` prints |
| `create_pages` | Named empty draft pages to add, by title |
| `media_post_types` | Extra site-wide post types whose media is kept |
| `theme_exclude` | Extra theme-relative paths to skip |
| `drop_post_types`, `empty_tables`, `scrub_options` | Site-specific trims and secrets |
| `php` | Optional PHP version; defaults to WP-CLI's version |

```json
{
  "scenarios": [
    {
      "name": "example",
      "source": { "wordpress_root": "/path/to/example", "url": "https://example.test" },
      "user": "admin",
      "pages": { "home": 2 }
    }
  ]
}
```

Snapshot runs are slower than a natively served local site. In one production-sized snapshot, Blockwork
operations took 4 to 9 seconds each. Uploads made during a run use absolute
`127.0.0.1:<port>` URLs and are discarded with the clone.

## Editor operations

The [skill reference list](../skills/blockwork/SKILL.md#references) routes caller
setup and each operation to its task reference. An agent connects to an editor
tab once, then reads and edits it directly:

- `connect` confirms the site, signed-in user, and document, and caches them
  for the page session.
- `connect` also lists the site's insertable theme and plugin blocks, so agents
  pick them over rebuilding the same thing from core blocks.
- `create` starts a new document from an owned wp-admin tab: it opens the
  type's native editor, waits for the post ID, and connects in one call.
- `read` returns block outlines, attributes, and native guides from the live
  editor without network requests, or the blocks and markup of another saved
  document through this editor's registrations.
- `edit` validates a batch of up to 32 operations on a copy, applies it through
  native block actions, verifies the result, and returns the changed client IDs.
  `update` merges nested attributes. New blocks get the native initialization a
  user's insertion would; an edit fails only when that stops making progress.
- `map_links` resolves a copied section's internal links against published
  destination permalinks. `insert` and `replace` apply its `link_map` beside
  `media_map`; see [copy sections between sites](../skills/blockwork/references/media.md#copy-sections-between-sites).
- `view` screenshots a block in the editor canvas at exact desktop widths, in a
  hidden background tab it resizes itself, or at Gutenberg's tablet and mobile
  previews, so agents iterate without saving.
- `measure` reports rendered geometry, chosen computed styles, and failed font
  loads in the editor canvas, optionally at one of those widths.
- `capture_page` navigates an agent's own tab to an optional URL and screenshots
  the saved page at exact
  widths, without resizing the user's browser. Entrance animations are jumped
  to their end first, a `selector` is scrolled below fixed bars that would
  cover it, cookie and consent notices are hidden for the shots and counted
  in `hidden_notices`, `states` forces CSS interactive states, and `measure` adds
  front-end element geometry and styles.
- `save` stores a receipt durably, saves once, and verifies a fresh server read
  and native parse of the stored content.
  `revert`, `status`, and `release` finish the set.

Both workflows edit the live draft. Background tabs save by default and may
only save Blockwork's own work. Attached tabs belong to the user: their typing
elsewhere never blocks an edit, and saving requires explicit whole-document
intent. Blockwork records what it last read for each block and refuses an edit
only when someone else changed what that edit depends on. A failed edit rolls
back when the draft exactly matches a state Blockwork produced; otherwise it
reports the partial change. Uncertain saves keep their receipt and reconcile
through `recover`, never a replay. The
[recovery reference](../skills/blockwork/references/recovery.md) covers failure
results, host failures, rollbacks, and uncertain saves. Blockwork never resends
a request; a read-only call that gets no browser result reports
`next: "retry"`. The browser refuses CDP until the agent reads the `cdp`
capability documentation, so the setup snippet reads it first.

The packaged references are split by when an agent needs them. A page build
reads SKILL.md, operations, and styling; recovery, resources, and active
editors load only for failures, settings and resource work, or a user's open
editor.

A verified edit beside unsupported content reports `valid: false` and
`preservation_status: verified_after_read`. This confirms the requested edit and
unchanged unsupported content without claiming whole-document validity.

The [document and resource reference](../skills/blockwork/references/documents.md)
covers custom post discovery and creation, title/slug/status/template/parent/order,
scheduling, featured images, registered REST meta, taxonomy assignments, and
existing core post-meta bindings. Settings that can change editor policy must
be saved, and the editor reopened, before structural edits.

Media and term operations use native authenticated REST requests, with separate
preparation receipts, currentness checks, and one-write recovery. Media supports
bounded file upload, metadata updates, and inspected attachment values in blocks.
Terms support search, creation, updates, and explicitly scoped deletion.
These operations do not require a local helper or an installed WordPress plugin.
Private ACF fields and PHP binding-registration proofs remain outside the
browser-only contract. Lost upload acknowledgments require an exact match against
the same-origin original file bytes; inaccessible or transformed files remain
uncertain.

Abilities that plugins register through the WordPress Abilities API are listed
with `inspect_abilities` and run with `run_ability` over the same authenticated
REST session. The caller states each ability's declared effect, and Blockwork
refuses a mismatch before sending anything. These runs have no receipt, lock
check, or verification: a failed or timed-out change is reported as uncertain
and never replayed. Labels, descriptions, and output are plugin-written site
data. The Playground fixtures install `tests/fixtures/abilities.php`, which
copies the gating and input patterns of SEOPress and ACF.

Existing synced patterns, templates, template parts, and navigation use exact
native identities and explicit shared scope. References use inspected entity
tokens and remain leaves in the containing document. Recovery can reconcile a
document or resource receipt in a fresh authenticated admin tab without replaying
the write. Native checks on a local site cover synced-pattern saving, reference
insertion, and lost-upload recovery. Template and navigation runtime acceptance
remains open.

The plugin entry point is [plugin.json](../plugin.json). Its workflow lives in
[skills/blockwork/SKILL.md](../skills/blockwork/SKILL.md).
