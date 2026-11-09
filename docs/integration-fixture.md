# Disposable WordPress integration fixture

Run `pnpm install --frozen-lockfile`, then:

```sh
pnpm test:integration
```

This uses `node:test` and Playground CLI 3.1.56. The minimal test boots three
independent sites, checks REST reads and writes, and proves content and an option
marker do not leak into the next site. The editor-fixture test boots WordPress
7.0.0, 7.0.8, and 7.1.4 with a block theme. It checks real account capabilities,
shared-entity identities, foreign locks, session revocation, and the fixture
controller's browser-origin restriction. Each site is disposed in `finally`.
The minimal test also checks that closed server URLs stop responding.
Timings appear in the test output.
CI runs this separately from the unit tests. `pnpm check` keeps its existing unit
test scope.

For a desktop Blockwork test:

```sh
pnpm fixture
```

The command prints the site, numeric user and page IDs, and editor URL. Open that
URL in a hidden in-app browser tab and follow the installed Blockwork skill's
connect, read, edit, save, and release sequence. Ctrl-C closes the
server and removes its temporary WordPress files and SQLite database.

The fixture requests automatic login. Browser cookies can survive previous sites
on the same loopback hostname, so a new fixture may show WordPress's login form.
Use Playground's disposable default test account for that form.
The HTTP integration test disables automatic login because Node's `fetch` does
not retain browser cookies across redirects.

## Native desktop suite

Start one fixture for a complete suite, choosing `7.0.0`, `7.0.8`, or `7.1.4`:

```sh
pnpm fixture:integration 7.1.4
```

The single JSON line is a non-secret descriptor. Pass it as an object to
`createDesktopSuite` in [the desktop runner](../tests/integration/desktop.mjs).
Use the desktop host's `cua_repl`, the installed Blockwork resource path, and
a new directory under ignored `artifacts/`. Read Blockwork's current native API
instructions before using the runner. The host must provide
full CDP access and host file imports. Stop if either capability is unavailable.

```js
const { createDesktopSuite } = await import('file:///ABSOLUTE_REPO/tests/integration/desktop.mjs');
const suite = await createDesktopSuite(cua, descriptor, installedEditorPath, artifactDir);
```

Run `await suite.run(name)` for each name in `suite.names`, in that order. Run
one or two cases per host tool call and allow 60 seconds per case. Inspect the
returned result before continuing. Start a fresh fixture to rerun a mutating
case. The runner refuses duplicate cases within one suite. Ctrl-C disposes the
fixture after all browser cases complete.

The twelve cases cover paragraph, template, template-part, and navigation
roundtrips; an edit in an open draft; stale content; foreign locks; two Blockwork editors using one
account; revoked sessions; sign-in recovery; an Author's own post; and capability
removal from a still-authenticated Author. They save receipts before submitting
a save once, check server content and status, reopen successful saves, check
native validity and untouched content, and check lock expiry. Cleanup failures
fail the case. Independent cases continue after a failure. `report.json` and
per-case receipts preserve operation results and timings. A transport failure
or uncertain save leads to verification in the same editor, never save replay.

The fixture uses native `wp_insert_post`, capabilities, `wp_set_post_lock`, and
`WP_Session_Tokens` calls. Its finite controller binds a second ephemeral
loopback port and accepts host-side JSON requests only. It rejects browser
Origin headers. Passwords are random per fixture and move between the host
controller and the normal WordPress login form in memory. Descriptors and
reports exclude passwords, cookies, and nonces. This controller is developer
test code and is never installed on a real site or shipped in Blockwork.

The runner opens hidden internal-browser tabs, signs in with fixture users,
waits up to ten seconds for the exact editor identity and nonempty block list,
and dismisses first-run WordPress welcome dialogs when present. This page-load
wait is separate from Blockwork's own operation deadline.
It checks that the installed engine matches the checkout bundle before running.
The integration fixture uses six PHP workers for concurrent Heartbeat requests.

`7.0` is a Playground branch alias and currently resolves to a later patch.
Use `7.0.0` to install the original release. WordPress reports that release as
`7.0`; the Node test checks this explicitly.

CI runs the Node fixture tests. The desktop runner executes the installed
plugin through the supported in-app browser API and requires a desktop host.
The Node tests run the compiled engine against fixtures, but not through the
desktop host. See the
[native results](integration-results.md) for failed plugin assertions and scope.

The [Blueprint](../tests/fixtures/minimal.blueprint.json) pins WordPress 7.1.4
and PHP 8.4, disables cron, and seeds one draft page with two core paragraphs.
The seed uses canonical Gutenberg whitespace so ordinary edits pass native
serialization checks. `runPHP` calls `wp_insert_post`; no SQL, database service,
WP-CLI, containers, or saved site snapshot are required.

The minimal runner uses one PHP worker for sequential core-block checks. The
integration runner uses Playground's recommended six workers for concurrent
editors and Heartbeat. The dependency patch binds the ESM CLI server to `127.0.0.1`; its
reported localhost URL alone does not constrain the listen address. The patch is
specific to this pinned package and does not change the CJS entry point.
See the [upstream bind-host request](https://github.com/WordPress/wordpress-playground/issues/3681).

The first install downloads several PHP WebAssembly runtimes. The native file
locking dependency has prebuilt binaries for Node 22 and 24 on macOS ARM64.
Node 26.10.0 required a local compilation in this run. CI uses Node 24.
Only `fs-ext-extra-prebuilt` and the existing esbuild dependency may run install
scripts. These are developer dependencies and stay outside the plugin package.

## Abilities fixture

Every Playground fixture, minimal and editor, installs
`tests/fixtures/abilities.php` as a must-use plugin. It registers three groups
of abilities for `inspect_abilities` and `run_ability`:

| Group | Copies | Available |
| --- | --- | --- |
| `blockwork-fixture/*` | One ability per transport or failure case: nested input, large output, a delayed write, no annotations, invalid output, a plugin error, an invalid-nonce error from the ability's own code, and a refused permission | Always |
| `blockwork-seo/*` | SEOPress: registered but hidden from REST, per-post permission, and updates marked destructive and idempotent, which core routes through DELETE | After `seo_exposed: true` |
| `blockwork-fields/*` | ACF: unregistered until a flag is on, then one ability per action on the `blockwork_book` post type, each running an inner REST request with nested field values | After `fields_enabled: true` |

`blockwork-fixture/configure` takes `seo_exposed` and `fields_enabled` and
switches those two groups for later requests, so a desktop run can turn them on
through `run_ability` itself. They are the options
`blockwork_fixture_seo_exposed` and `blockwork_fixture_fields_enabled`.
`set-marker` also takes a `code` with a `pattern`, a rule the pre-send check
leaves to WordPress. `blockwork-fixture/state` returns the marker, the counter,
and how often each ability that is not read-only ran, so a desktop run can
confirm what reached the server.

Each run of an ability that is not read-only is appended to the
`blockwork_fixture_calls` option, so a test can show that a refused request
never ran and that a timed-out one ran once. `set-marker` takes `delay_ms`, up
to 40 seconds, to hold a write open past the engine's 30-second wait.

`tests/integration/abilities.test.mjs` runs the engine against these abilities
on 7.1.4, and `abilities-versions.test.mjs` repeats the main steps on 7.0.0 and
7.0.8. Both sign in over HTTP through `tests/helpers/abilities-page.mjs`, which
loads the site's own `wp-hooks`, `wp-i18n`, `wp-private-apis`, `wp-url`, and
`wp-api-fetch` scripts into one Node realm with the engine and sets
`wp.apiFetch` up as wp-admin does. Method overrides, error parsing, and the
nonce retry are therefore core's. Only the browser is replaced: `fetch` adds the
login cookie. The 7.1.4 test's last step sends the nonce-error ability through
core's parsed `wp.apiFetch` and shows it running repeatedly, which is why the
engine sends runs unparsed. Neither test exercises the in-app browser; the
[desktop abilities run](integration-results.md#abilities-run-on-october-12-2026)
does.

## Measurements on October 4, 2026

Measured on an Apple M3 Max with 36 GiB RAM, Node 26.10.0, PHP 8.4.25, and
WordPress 7.1.2. Each run created a new database. Cached runs reused only the
downloaded WordPress archive, not a populated site. Startup covers `runCLI` and
the PHP call that reads the seeded target. Package installation and module
import time are excluded.

| Measurement | One-worker result |
| --- | --- |
| Startup with WordPress archive absent | 12.98 s |
| Three cached fresh-site startups | 5.81, 5.31, 5.09 s |
| Public REST read | 312 to 330 ms |
| WordPress write and readback | 316 to 334 ms |
| Teardown | 179 to 193 ms |
| Complete three-site integration test command | 18.84 s |
| Sampled server RSS | 0.44 to 0.76 GiB |

The cold measurement temporarily moved the cached archive into an OS temporary
directory and restored it afterward. Its download time depends on the network.
With Playground's default six workers, cached startup took 6.22 to 6.71 seconds
and idle server RSS was about 2.12 GiB.

The installed Blockwork plugin also passed a desktop in-app browser roundtrip
on the one-worker fixture. Inspection took 4.44 seconds, preparation took
3.19 seconds, save with verified server readback took 4.98 seconds, and release
took 0.73 seconds. A fresh editor load confirmed both blocks were valid, the
second paragraph was unchanged, and publication status remained draft.
The existing five-second editor initialization limit was unchanged.

These native checks used the supported desktop CDP API, not the Node test runner.
These original checks established the fixture's suitability for the core
paragraph scenario. The later desktop suite extends that coverage as recorded
in [integration results](integration-results.md). RSS values are samples, not
peak measurements. All test tabs, servers, and temporary site files were
closed or removed after verification.

Keep one fixture for a related suite and give independent mutations separate
records. Create a fresh fixture before repeating the suite. Fresh-site startup
is reasonable for integration tests and expensive for every unit test.
Playground's SQLite backend does not establish MySQL-specific behavior.
