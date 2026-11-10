# Real-editor tests

The unit tests in `tests/*.test.mjs` run against a mocked editor. These two suites
run real Gutenberg, on disposable WordPress Playground sites, and they exist to
catch what a mock can't.

| Suite  | Command             | What it runs                                      | Costs                                                         |
| ------ | ------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| Engine | `pnpm test:editing` | Blockwork calls in Chromium on a real editor      | About 80 minutes on a Mac with 8 GB of memory, no model usage |
| Agent  | `pnpm test:agent`   | Natural-language requests in the real desktop app | About a minute per task, and the signed-in account's usage    |

Neither runs from `pnpm check`. CI runs the three-case engine smoke selection below;
the full engine suite and the agent suite stay outside CI. Both need the
`agent-browser` CLI, and the agent suite needs the desktop app. Run the cases and
tasks a change affects;
[`AGENTS.md`](../AGENTS.md#real-editor-tests) says when a longer run is worth it. With a
[test host](development.md#desktop-test-app) configured, both run on that Mac.

## Engine suite

The Check workflow's `editing-smoke` job runs on Ubuntu with Node 24 and
`agent-browser@0.41.2`. It installs Chromium and its Linux libraries with
`agent-browser install --with-deps`, caches Playground downloads, and has a
10-minute job timeout. Run its exact selection locally with:

```sh
BLOCKWORK_TEST_HERE=1 pnpm test:editing tests/editing/common-edits.test.mjs --test-name-pattern='^(change the heading and button together|a guessed edit field is refused with a useful correction)$'
BLOCKWORK_TEST_HERE=1 pnpm test:editing tests/editing/save-and-recovery.test.mjs --test-name-pattern='^other writers after save preparation refuse before any save request$'
```

The first case edits a heading and button, saves, and reopens through
`assertSavedCleanly`. The second checks a malformed edit through `assertRefused`.
The third changes the stored content, then the stored date, between `prepare_save`
and `save`, and checks that `save` refuses without a write request. Each file boots
its own Playground site, and the job runs the files one at a time, because the
runner runs two files at once and two sites overloaded the CI machine. The runner keeps only the last `--test-name-pattern`, so
combine cases into one pattern. `BLOCKWORK_TEST_HERE=1` uses the runner's existing
local override, so the command ignores `~/.config/blockwork/test-host`. GitHub's
fresh runner has no test-host file and needs neither SSH nor the desktop app.

Each file in `tests/editing/` boots its own site through `startEditingSite` and
covers one area. Some groups share a document to avoid repeated editor startup.
Each selected case supplies its own prerequisites. A failed case stops its group
if the caller reports busy, partial, or uncertain state.

| File                | Covers                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `text`              | What a person types, HTML, and text that looks like block syntax, in each block that holds text |
| `block-matrix`      | Every registered core block, its variations and styles, and every registered pattern            |
| `common-edits`      | Whole user jobs on a realistic page                                                             |
| `style`             | Every style family, responsive and hover states, and `update_style` refusals                    |
| `native-controls`   | Native controls that write more than one attribute, compared with the agent's route             |
| `structure`         | Each operation in each nesting context, batches, `revert`, nesting rules, locks, and limits     |
| `existing-content`  | Classic, invalid, unregistered, and deprecated content, footnotes, and encodings                |
| `documents`         | Discovery, creation, status, settings, meta, terms, revisions, and accounts                     |
| `media`             | Inspection, uploads, attaching, copying between sites, `capture_page`, and `view`               |
| `shared`            | Synced patterns, overrides, templates, navigation, Query Loop, dynamic blocks, and bindings     |
| `save-and-recovery` | Locks, other writers, lost responses, expired sessions, interruptions, and error codes          |
| `plugins`           | Plugins that rewrite content, slow saves, meta boxes, editor extensions, CSP, and redirects     |
| `site-config`       | Permalinks, subdirectories, non-English admin, themes, versions, and multisite                  |
| `acf`               | ACF Pro's meta box saves, taxonomy and required fields, and ACF blocks                          |

Every successful save goes through `assertSavedCleanly`: persistence is verified,
fields the case didn't change stay the same, the document reopens with no invalid
blocks and isn't dirty, and the editor reproduces the stored content. Every expected
failure goes through `assertRefused`: it needs a usable `hint` and `next`, and the
stored document stays as it was.

Tests assert the behavior a user or agent should get. A case that fails because
Blockwork is wrong stays in the file, with its correct assertion, marked
`{ todo: 'finding: short-slug' }`. The run stays green while the defect stays visible,
and the runner lists each one. A marked case that passes fails the run in every mode.
Remove the mark only after the defect is proven fixed. A failure without a mark is new.

Generated groups attribute operation assertions to their leaf cases. Shared persistence
checks remain unmarked, so their failures fail the group rather than being attributed
to a finding. Targeted and full runs use the same flow. If shared work fails after
some leaves finish, the group stops and reports both completed leaves and the failure.

Things a real site adds go in `tests/fixtures/editing/*.php`, which load as must-use
plugins. Behavior only some cases want sits behind an option the case sets.

ACF Pro is licensed, so it stays out of the repository. `acf` mounts the copy at
`~/.local/share/blockwork/plugins/advanced-custom-fields-pro` on the Mac that runs
the suite, and skips its cases without one. Copy the plugin folder from a site
that has it, to each Mac that runs the suite, including the test host. It runs
unlicensed, which is enough for its fields and blocks. `acf.php` registers the
field groups and an ACF block, and does nothing on sites without ACF.

Select a file, finding, or case when working on a fix. Combine selectors to run
only their intersection. A finding may cover more than one case.

```sh
pnpm test:editing tests/editing/text.test.mjs
pnpm test:editing --finding preformatted-whitespace-verified
pnpm test:editing --finding slug-one,slug-two
pnpm test:editing tests/editing/structure.test.mjs --test-name-pattern='batch selectors'
```

`--test-name-pattern` matches the full name of each leaf case, including generated
cases. Unknown finding slugs and selections with no matching cases exit nonzero. The
runner prints the actual number of leaf cases run. Selecting `preformatted-whitespace-verified`
with `tests/editing/plugins.test.mjs` ran three cases in about 45 seconds on one run;
timing varies by host and case.
There is no `--failed` selector. Persisting failures and handling test hosts are beyond
this selection mechanism.

The files run two at a time, because each site and its browser take about 2 GB of
memory. On a busy machine timing-sensitive cases can fail, so re-run a failure alone
before believing it.

## Agent suite

`tests/agent/tasks.mjs` holds requests in a person's own words. For each one,
`tests/agent/run.mjs` seeds a page, sends the prompt to a fresh chat in a separate
copy of the desktop app, waits, and scores what was saved. Scores look at outcomes, so
any correct way of making the change passes. Every task also checks the document
reopens clean, its status is unchanged unless the request changed it, blocks outside
the request are byte-identical, and the account isn't left in Code Mode.

```sh
node tests/agent/run.mjs --dry
node tests/agent/run.mjs --model gpt-6.1-terra --effort medium
node tests/agent/run.mjs --only heading-text,columns-center
node tests/agent/run.mjs --level trap
```

`--dry` seeds each task and checks it opens clean, with no app and no usage. Results,
each saved page, and each transcript go to ignored `artifacts/agent-tasks/`. A failure
here means an agent read the docs and a plain request and still saved a wrong page, so
start by reading the transcript. The fix is usually in the skill docs rather than the
engine. On a test host, those results move back here when the run ends.

A step that stalls ends the run with a non-zero exit and an error naming the stage,
without waiting for anything else. It also stops the app copy the run started.
