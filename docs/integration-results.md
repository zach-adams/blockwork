# Native integration results

API names in this report reflect the tested build. For current request names,
read the [operation reference](../skills/blockwork/SKILL.md#references).

The October 4, 2026 run exercised the installed Blockwork 0.1.1 engine through
the desktop in-app browser's supported CDP API. All sites were disposable
Playground fixtures with PHP 8.4.25 and Twenty Twenty-Five. No plugin behavior
changed. The installed engine matched the checkout bundle, with SHA-256
`f47feabad7c4cafa47babf38056c8fa6f0d4d11bfa164e229563c6afb0997e5d`.

The [runner](../tests/integration/desktop.mjs) has eleven native cases. See
[setup](integration-fixture.md#native-desktop-suite) to repeat them. Passing
means the requested behavior and cleanup both passed. A verified save does
not make a case pass when cleanup fails.

## Observed behavior

| Case | WordPress 7.0.0 | WordPress 7.0.2 | WordPress 7.1.2 |
| --- | --- | --- | --- |
| Paragraph save, status preservation, validity, fresh reload, lock release | Pass | Pass | Pass |
| Template save and fresh reload | Save/reload pass; cleanup fails | Save/reload pass; cleanup fails | Save/reload pass; cleanup fails |
| Template-part save and fresh reload | Save/reload pass; cleanup fails | Save/reload pass; cleanup fails | Save/reload pass; cleanup fails |
| Navigation save | Inspection refuses | Inspection refuses | Inspection refuses |
| External content change after preparation | Refuses stale save; preserves external content | Pass | Pass |
| Another user takes the lock after preparation | Refuses save; preserves lock and content | Inconsistent; fresh repeat passes | Pass |
| Two Blockwork editors using the same account | Not run | Pass on fresh fixture | Pass |
| Session revoked after preparation | Refuses save; cleanup fails | Refuses save; cleanup fails | Refuses save; cleanup fails |
| Sign in again and edit after revocation | Pass | Pass on fresh fixture; first site setup failed | Pass |
| Author edits and reloads their own draft | Setup blocked | Pass on fresh fixture | Pass |
| Author loses edit capability while still authenticated | Refuses save; wrong error and cleanup failure | Same on fresh fixture | Same |

WordPress calls its original 7.0.0 release `7.0` at runtime. Fixtures request
`7.0.0` explicitly. The three-version Node matrix also passed all fixture
assertions, including native password validation, account capabilities, shared
identities, competing locks, session revocation, and controller-origin rejection.
The existing 189 unit tests, formatter, linter, and TypeScript checks passed.

## Deferred plugin issues

1. Templates and template parts save valid content but `release` returns
   `cleanup-nonce-unavailable`. Fresh native editors confirm the saved content
   and unchanged publication status. On 7.1.2, controller snapshots also confirm
   that both owned locks remain fresh after the failed release and tab closure.
   Navigation's failed inspection has the same cleanup error. Reproduce with
   `template-roundtrip` or `template-part-roundtrip`; inspect the release results
   and `lockReleased` field in the report.
2. Navigation inspection returns `editor-not-clean` before preparation or any
   write. The exact native identity and `core/navigation` wrapper are present.
   Its persisted content contains the seeded navigation link, the editor reports
   `dirty: false`, and the wrapper's child list is empty. Dismissing the welcome
   dialog does not resolve it. A bounded native-state check also left the child
   list empty. This may involve native canvas initialization; the cause is not
   established. Reproduce with `navigation-roundtrip` and read `nativeState`.
3. Removing the Author role's edit capability preserves a valid session and
   blocks the write, but the engine returns `reauthorization-required`.
   Signing in cannot restore that capability. The test requires a permission
   error distinct from an expired session, without prescribing its exact name.
   Reproduce with `author-own-post`, then `permission-revocation`. Server content
   remains unchanged.
4. Revoked-session and capability-removal cleanup waits about twelve seconds
   and returns `heartbeat-timeout`. Closing the owned tab remains necessary.
   Revoked-session save refusal and later reauthorization passed independently.
   Reproduce with `session-revocation`, followed by `reauthorization-recovery`.
5. The first 7.0.2 foreign-lock run returned a verified save after requesting a
   competing fixture lock. That run did not retain the injected lock snapshot,
   so lock ownership at the save boundary is not proved. A fresh repeat with
   that snapshot confirmed owner 2 before saving and correctly returned
   `post-locked`. Preserve the original failure as an intermittent safety result;
   stronger reproduction is needed before treating this check as reliable.
   The runner now asserts and records the lock-injection precondition.

No failed cases were skipped or converted to expected successes. The version
floor and shared editing are not fully cleared.

## Fixture and browser setup issues

One 7.0 Author editor failed during native page setup before its first Blockwork
operation. The first 7.0.2 site also redirected fresh logins back to `wp-login`
after revocation, leaving recovery and Author cases blocked during setup.
Manual form checks confirmed the password field was filled but no Author
session was created. A fresh site passed Author editing and sign-in recovery.
The cause of the first site's login loop is unconfirmed; it is not counted as
a Blockwork operation failure.

The runner now checks the expected login destination, waits up to ten seconds
for the exact native target and a nonempty block list, dismisses first-run
welcome dialogs, and avoids calling plugin cleanup on an unready page. It
records setup, behavior, and cleanup failures separately. The controller checks
generated credentials against WordPress's password hash before returning them
to the host. The Node matrix verifies all four fixture accounts.

Other harness corrections pin `7.0.0` instead of the floating `7.0` alias,
keep fixture metadata out of strict plugin targets, preserve a distinct receipt
file for each concurrency plan, and verify uncertain saves without replay.
The plugin's five-second initialization limit remains unchanged.

## Cost and evidence

Cached six-worker desktop fixtures became ready in 8.40 seconds for 7.1.2 and
7.21 and 7.34 seconds for two 7.0.2 sites. The first exact 7.0.0 download and
startup took 29.71 seconds. Individual native cases usually took 8 to 23 seconds;
the two-editor case took 23 to 25 seconds. Successful saves with server
verification took about 3.7 to 5.5 seconds in the later runs.

The ten 7.1.2 cases totalled 167.80 seconds. Its separate concurrency case took
25.16 seconds, so native case execution totalled about 193 seconds, excluding
fixture startup and pauses between host calls. The final Node command completed
in 41.34 seconds, with both test files passing and six sites disposed. That
command ran alongside `pnpm check`, so its startup timings are not an isolated
performance benchmark. No new RSS measurement was taken; see the earlier
[fixture measurements](integration-fixture.md#measurements-on-october-4-2026).

All desktop tabs and fixture servers were closed after the run. Descriptors and
reports contain no passwords, cookies, or nonces. Fixture users and records
disappear with their temporary databases.

## Abilities run on October 12, 2026

A Codex desktop chat ran the installed Blockwork 0.1.1 development build through
the in-app browser's CDP API against one `pnpm fixture` site: WordPress 7.1.2,
PHP 8.4.25, signed in as the administrator. The installed engine matched the
checkout bundle at commit `2519db0`, with SHA-256
`646645fd043f846451ba4815dbf39a6d50f2b2500001f6875a6553c285a06123`. The fixture
first showed WordPress's login form, and the agent stopped until the user
signed in. See the [abilities fixture](integration-fixture.md#abilities-fixture)
for what each ability does.

All 23 scripted steps returned the expected fields:

| Covered | Result |
| --- | --- |
| Listing, with the hidden and the unregistered group absent, and one ability's schema | Pass |
| A read with nested input through the query string, with its types restored | Pass |
| A write, an undeclared ability run as destructive, and oversized output left out | Pass |
| Refusals before sending: an effect mismatch, schema mismatches at `input.value` and `input.fields.rating`, and an empty array a query string cannot carry | Pass |
| WordPress's own input refusal after a write was sent, with and without `skip_input_check`, reported as uncertain | Pass |
| A plugin error and an invalid-nonce error from an ability's own code, reported as uncertain | Pass |
| Groups switched on through an ability, then a destructive SEO update read back, an explicit `false` kept, and a book created, updated, viewed, and trashed with nested fields | Pass |
| A write held for 35 seconds: `request_timeout` after 31 seconds, reported as uncertain | Pass |

The fixture's own state, read last, showed that the delayed write had landed,
the nonce-error ability had run once, and no refused write had run.

The run did not cover WordPress 7.0, a user who lacks the capability, a real
plugin's abilities, a hosted site, or an ability run from an attached editor
tab. The agent compared result fields; it did not judge whether the hints read
clearly.

## Remaining coverage

Two Blockwork editors prove Blockwork's stale-content check. They do not prove
that an ordinary same-account WordPress editor cannot overwrite Blockwork's
save. The WordPress advisory-lock limitation remains open.
Hosted latency, 2FA, security plugins, caching, MySQL-specific behavior, custom
blocks, Classic Editor, multisite, subdirectory installs, non-English admin,
and a fresh-chat package run still need their own fixtures or authorization.
CI currently exercises the WordPress fixture layer; full native cases require
the supported desktop browser API.
