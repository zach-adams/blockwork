# Caller setup and connection

## Desktop invocation

`scripts/bootstrap.mjs` loads the self-contained engine (`scripts/editor.js`)
with its invoker, evaluates each request in the bound tab through the tab's
`cdp` capability, and polls the page Promise, so a slow operation outlives the
host's outer timeout. Blockwork evaluates each request once and never resends
it; you may call a failed read-only operation or preparation again after
following its recovery guidance. Never attach an external CDP endpoint, install
a local browser, serve the script from WordPress, or evaluate the engine through
CDP yourself.

The browser refuses CDP commands until two documents have been read in the REPL
session: the browser's own documentation, which `cua.createBrowserTab`,
`cua.getBrowser`, and `cua.getTab` print the first time they use that browser,
and the `cdp` capability documentation. Read the `cdp` one once, before the
first caller; callers for later tabs in the same session don't need it again.
Read both again after a REPL reset or a lost browser binding. Otherwise the
first call returns `documentation_unread`, whose `diagnostics.missing` names
`browser`, `cdp`, or both.

Bind a tab that is already open, such as the user's editor, without printing its
whole accessibility tree, which `cua.getTab` always does:

```js
const browser = await cua.getBrowser({ id: BROWSER_ID });
const tab = await browser.tabs.get(TAB_ID);
```

Take both IDs from the tab list. `cua.getBrowser` prints the browser's
documentation only the first time in a session.

```js
nodeRepl.write(await (await tab.capabilities.get("cdp")).documentation());
const bootstrapUrl = new URL("file:///ABSOLUTE/INSTALLED/SKILL/DIRECTORY/scripts/bootstrap.mjs");
bootstrapUrl.searchParams.set("v", String(Date.now()));
const { createBlockwork } = await import(bootstrapUrl.href);
const blockwork = await createBlockwork(tab);
nodeRepl.write(blockwork.build);
```

Set the enclosing `mcp__cua_repl.js` call's `timeout_ms` to 60,000. That is the
host's limit. A longer call times out and resets the kernel, which loses its
variables while a write may still be running. Send at most one `save`,
`save_resource`, or other write per `js` call, and never loop writes inside one
call. `copy_media` stops before its own deadline,
so one call per batch is safe. `build`
reports the version and the SHA-256 of the engine, invoker, and bootstrap.
Recreate the caller after a package refresh, and pass the current `tab`; a
retained closure can hold a closed tab's handle.

The caller has one method per operation: `connect`, `read`, `edit`, `measure`,
`view`, `save`, `revert`, `status`, and `release`, plus `capture_page` for the
front end, [`prepare_resave` and `wait_for_save`](recovery.md#older-stored-markup)
for a page that needs a re-save, and [`wait_for_sign_in`](recovery.md#sign-in)
for a tab the user is signing in to. After `connect` it adds the confirmed `target` to every editor call;
`blockwork.target` returns it. `blockwork.call(request)` sends a raw resource,
shared-entity, or ability request; after `connect`, a site-only operation
without a `target` uses the connected site and user.
[`copy_media`](media.md#copy-attachments-in-bounded-batches) copies attachments
between callers in resumable deadline-bounded batches and returns the edit's
`media_map`. One caller runs one operation at a time; a second call returns
`host_operation_in_progress` without starting.

Saves and resource writes store their receipt durably before WordPress is
written, one file per receipt under `~/.local/share/blockwork/receipts/`
(`createBlockwork(tab, {receipt_directory})` changes it).
`blockwork.receipt_path` names the latest and `await blockwork.read_receipt()`
returns it. Edits write no receipts. `blockwork.build` reports the package
`version`, file hashes, and `debug`, true in a development build.

When a call fails, follow its `hint` and `next`. [Recovery](recovery.md) covers
host failures, conflicts, rollbacks, uncertain saves, and `status`.

### Interrupted turns and context summaries

If a turn is interrupted or the REPL loses its variables, get the tab inventory,
bind the same editor tab, create the caller again, and connect with the same
target and workflow. The outline `connect` returns shows what survived. Read it
before rebuilding anything.

REPL variables survive a context summary. After one, check your bindings first,
such as `nodeRepl.write({ tab: typeof tab, blockwork: typeof blockwork })`. While
they exist, continue with them and skip `cua.rewriteDocumentation()`, which
prints 50 to 120 KB that Blockwork doesn't need.

For a lost binding, follow the steps below and call `status()` before changing
anything. Retain any uncertain save receipt separately for read-only recovery.

### Lost browser binding

`browser_command_failed` with
`diagnostics.failure.reason: "browser_unavailable"` means this caller's browser
binding is gone, including a native pipe that closed before the response
arrived. Retrying through the old caller does not repair it. Retryable reads and
preparations return `next: "rebind_browser"`; changes keep their do-not-replay
`next` and require the same binding repair before checking their outcome.

1. Run the tab list from [setting up the caller](../SKILL.md#set-up-the-caller)
   in its own host call. Read the fresh browser and tab inventory, and identify
   the same editor or admin tab by its site and tab ID, plus the post identity
   for a document caller.
2. Bind that existing tab with its current browser ID, then read its `cdp`
   documentation. Do not navigate, reload, close it, or open a replacement.
3. Create a new caller. If it was connected to a document, reconnect with the
   original connect request, including its target and workflow. If connect
   returns `operation_in_progress`, wait a few seconds and retry connect. Do not
   change the workflow to get past a refusal. Call `status()` and continue only
   after connect succeeds and status returns `ok: true, busy: false`; read
   `last_request` before any change.
4. If the caller was used only for site-targeted operations such as media,
   terms, or abilities, resume in the same admin tab with the same site target.
   No document connection or `status()` is required. Settle any uncertain
   resource write with `verify_resource` and its stored receipt first. Follow
   [host recovery](recovery.md#host-failures) for the failed operation.

After reading the inventory, use its current IDs in this document-caller
example. `connection` is the original connect request, with `site_url`,
`post_id`, `post_type`, and workflow; omit the caller's added `user_id`.

```js
const recoveredBrowser = await cua.getBrowser({ id: CURRENT_BROWSER_ID });
const recoveredTab = await recoveredBrowser.tabs.get(TAB_ID);
nodeRepl.write(await (await recoveredTab.capabilities.get("cdp")).documentation());
const recoveredBlockwork = await createBlockwork(recoveredTab);
const reconnected = await recoveredBlockwork.connect(connection);
nodeRepl.write(reconnected);
if (reconnected.ok) nodeRepl.write(await recoveredBlockwork.status());
```

Use `recoveredBlockwork` for subsequent calls. The binding repair itself does
not reload the page. If that page still has a compatible Blockwork session,
connect reuses it and preserves the live draft, including unsaved editor work.
Confirm that through connect, status, and read; a closed or navigated tab cannot
be assumed to retain it. Receipts already written to disk remain there, but the
new caller has no previous `receipt_path`; retain the old path or receipt
separately for an uncertain save or resource write.

When the failed request included valid `upload.base64`,
`diagnostics.upload_bytes` reports its decoded byte count as a number. Large
uploads have coincided with this binding failure, but its cause is unknown.
After rebinding, try a smaller or recompressed file for a new preparation. The
decoded upload limit is 5 MiB. Never retry an uncertain `save_resource` with
another file; verify its stored receipt first.

### Receipt directory access

Saves keep a receipt in `~/.local/share/blockwork/receipts/`. When your sandbox
can't write there, `createBlockwork` throws `EPERM`. Pass a writable directory
from the start: `createBlockwork(tab, { receipt_directory: "/ABSOLUTE/WRITABLE/FOLDER" })`.
Pass the same option to later callers, including a front-end capture caller.

## connect

```js
const doc = await blockwork.connect({
  target: { site_url: "https://example.com", post_id: 42, post_type: "page" },
  workflow: "background",
});
```

`target` takes `site_url` (the WordPress installation URL, including any
subdirectory), `post_id`, and `post_type`, from the user's request and the exact
tab. Omit `user_id`; connect reads the signed-in account. Templates and template
parts use their string IDs. `workflow` is `attached` or `background`. Attached
connect also accepts `unsaved_preview: true`; see
[active editors](active-editors.md#unsaved-previews). Connect accepts every
[`read` field](inspection.md#read).

Connect checks the tab's origin, the editor's post identity, the signed-in user,
the site URL, and that the editor loaded the saved record, and caches the user
and the document's REST field schema; `save` checks both again. A tab opened
moments ago may still be starting Gutenberg, so connect waits up to 10 seconds
for the editor to report its post and for the block editor to receive that
post's blocks. `editor_unavailable` with `diagnostics.stage` of `editor_start`
or `block_sync` names the step that never finished. When the editor shows
another document, `target_mismatch` names it in `diagnostics.editor`. Background
connect also requires a clean editor, locks autosave for the session, and
confirms the post lock through one Heartbeat round trip. The Site Editor, which
edits templates, template parts, and navigation, takes no post locks, so those
documents have none to confirm. WordPress saves Code Mode for the user; a
background tab that opens in it shows the visual editor for that tab only and
leaves the saved preference alone.

Where the canvas loads by itself, Gutenberg can fill a block saved empty, such as
Buttons, List, or Details, with template children without marking the editor
dirty. Background connect accepts that only when nothing else differs from the
saved record, and lists those blocks in `template_fills`: `blocks`, at most 20,
each with `client_id`, `name`, and `path`, and `block_count`. Their children stay
unread, so `save` refuses with `unexpected_editor_change` until you `read` them.
The save then writes them, as saving in the visual editor would. Remove any the
page should not have, or tell the user they will appear.

The result has `target` (with `user_id`), `user`, `workflow`, `editor_instance`,
`save` (`explicit_request_only` or `default_completion`), `title`, `status`,
`link` (the permalink; a draft's link opens for signed-in editors), `dirty`,
`editor_mode` for an attached editor (see
[active editors](active-editors.md#connect-and-read)), `template_fills` when
present, the read projection, and `custom_blocks`: every non-core block the inserter offers,
as `{name, title, description}`, with `inside` listing the parents of a block
that only belongs inside them. Reconnecting to a tab with a session keeps it and
re-reads the saved baseline. A different workflow, target, or user refuses, and
so does a session from an older Blockwork build (`session_from_older_build`),
which may hold editor locks.
