# Save, release, and check results

## save

```js
const saved = await blockwork.save({ save_all_pending: true }); // attached
const saved = await blockwork.save(); // background
```

`save` makes two page calls. The first checks the editor, the signed-in user,
and the saved record, refuses an unrequested publication change, and returns a
receipt that the caller stores. The second rereads the saved record to confirm no
other writer changed it, confirms the draft has not changed, calls Gutenberg's
`savePost` once, and compares a fresh REST read and native parse with the receipt.
A verified result has `persistence: "verified"`, `status`, `link`, `editor_url`, `revisions`, and `valid`. `editor_url` opens the
document in the post editor, or the Site Editor for templates, template parts,
and navigation. `revisions` is `{latest_id, url}` for the latest revision
WordPress reports after the save, or `null` when the saved record links none,
such as for a type or site without revisions. Its `url`
opens WordPress's revisions screen, where the user can compare and restore
earlier title, content, excerpt, and any metadata the site revisions. A save
that changed none of those adds no revision, and slug, status, parent, and terms
are never revisioned, so restoring does not undo them. `valid: true` means
Gutenberg's parse of the stored content, with this editor's block registrations,
found every block valid and supported. That covers the block validity a fresh
editor load would show, so do not reopen the editor only to check it;
`reopen_required` still applies after a template change. `valid: false` can mean
a block Blockwork does not support, such as raw HTML, rather than an invalid
one. With `preservation_status: "verified_after_read"` it means the edit and
unsupported content were preserved exactly, not that the whole document is
supported.

Both page calls share a 45-second caller deadline, including receipt storage
between them. If preparation uses the budget, the second call refuses with
`browser_deadline_exhausted`, `operation_started: false`, and
`persistence: "not_attempted"`. If observation times out after the save may have
started, persistence is `uncertain`. Keep the stored receipt, call `status()`
until `busy` is false, and reconcile with `recover`. Never replay that save.
The deadline stops observation; it does not cancel a page job or WordPress write.

Verified persistence covers content and fields exposed through the document's
REST schema. It cannot verify plugin-owned metadata absent from REST. For a
request to verify plugin settings, inspect a site-provided observable interface
or report that limitation. A successful meta box POST alone does not prove those
values were preserved.

An array in an attribute registered for both objects and arrays may have been an
empty or numbered-key object before WordPress returned the document. Blockwork
refuses edits to that block and preparation of a whole-document save, including
for legitimate arrays, because it cannot establish the original shape. The
refusal names `diagnostics.path` and `diagnostics.attribute`, with
`next: "inspect_then_report_ambiguity"`. Inspect the document, preserve its stored
content, and report the ambiguity. Background neighboring edits remain available,
but Blockwork cannot save them while the ambiguity remains. An attached editor
requires `connect` with `unsaved_preview: true` before any such edit, because
native autosave also writes the whole draft. Restore that protected preview
before releasing it. Inspection remains available without a preview.

Attached results report `saved_all_pending: true` only when the document is clean
and core reports no dirty entities. `pending_entity_count` reports the number of
entity drafts core still holds. A verified document save can leave synced patterns
or other entity drafts pending. Tell the user when work remains; this save does
not separately publish those entities. If core cannot report its dirty entities,
`saved_all_pending` is false and the count is omitted.

When the editor has classic meta boxes, Gutenberg posts their forms to
`post.php` after the REST save. Blockwork lets WordPress process that POST as
usual but does not follow its redirect to an editor page nobody reads. Saves
that reach `savePost` report `meta_boxes` on verified and
`stored_with_field_differences` results, or in `verification_mismatch` diagnostics:

- `"none"`: no meta box POST happened.
- `"saved"`: WordPress answered with its post-save redirect or an OK response.
  Like the native editor, Blockwork cannot see where that redirect leads. A form
  may write meta keys and plugin fields this save didn't change, such as ACF's
  `acf` field filling in defaults, and those still verify. A key or field this
  save did change must still hold the requested value. An ACF taxonomy field
  that saves terms posts the terms it loaded, so it can undo a requested
  category change; that save returns `verification_mismatch` naming the
  taxonomy.
- `"unobserved"`: the page's `fetch` could not be swapped and restored, so
  Gutenberg saved natively, following any meta box redirect. Whether a meta box
  POST happened, and how it went, is unknown.
- `"failed"`: at least one meta box POST failed. On a verified result, the
  document itself still saved and verified, but plugin settings saved through
  the editor's meta box panels may not have updated. Tell the user. Do not save
  again to retry, because the failed request may have partly run.

Background preparation starts its Heartbeat lock check alongside the identity,
saved-record, and schema reads. Read, currentness, reference, and duplicate
checks retain error precedence over the lock result. Every check must pass
before Gutenberg saves.

`save` rereads the saved record before `savePost`, so another writer's save
between preparation and saving refuses with `saved_record_changed`.
`diagnostics.fields` lists the changed field names without values. This editor's
own saves in that gap, such as a draft autosave, don't count. No save was
attempted. Tell the user before replacing an owned background tab with a fresh
editor, inspect the current document, reconcile the intended edits, and prepare
again. Only the user can decide whether to reload an attached editor
and discard pending work. This check cannot prevent a writer from changing the
server after the final read and before WordPress accepts the save.

Document reads for connect, save preparation, verification, preview currentness,
and recovery request all schema properties and fixed baseline fields, replacing
`content` with `content.raw`, plus `_links` for revision links. Pattern documents
also request `wp_pattern_sync_status`, which core returns outside its schema,
so unsynced patterns still refuse. Filtered reads omit `content.rendered`.
Core and schema-declared fields keep the same values unless a plugin getter
derives a field from rendered content. Such a getter can read differently and
cause `saved_record_changed`. Title and excerpt keep their complete fields;
excerpt rendering can still run. Shared reference and inspection reads retain
full records for their tokens. Schemas with a dotted top-level property name use
full-record document reads throughout, because WordPress interprets dots in
`_fields` as nested selections. The REST response bound stays 1 MiB.
Gutenberg owns its unchanged PUT response.

Only an acknowledged live `save` can return `stored_with_field_differences`,
`persistence: "applied_with_differences"`, and `next: "inspect_stored_fields"`.
It compares full values with the pre-save record and settles the session. A
taxonomy the draft left empty also returns it when WordPress stores its default
term there, such as Uncategorized for a new post; tell the user which term.
Inspect the named fields; never replay. A lost response uses `recover`'s existing
outcomes. See [uncertain saves](recovery.md#uncertain-saves).

The saved record must be the one this editor loaded or last saved itself. Native
autosave from the same editor and the user's own saves keep that true. A save
from another tab, user, or tool refuses with `saved_record_changed`, as does
`connect`. After a native save that posted meta box forms, the meta keys and
plugin fields those forms wrote are taken as saved. Edits and saves wait up to
10 seconds for a running native save, and saves also wait that long for a
plugin's save lock, such as ACF's check after an ACF block's fields change.
Nothing to save returns `persistence: "unchanged"`. The session stays open for
more edits.

A plugin can stop a save in the editor before any request reaches WordPress,
as ACF does when a required field on a published page is empty. That returns
`save_not_sent` with `next: "ask_user"`, keeps the persistence the document had,
and drops the prepared receipt, because nothing was written. The edit stays in
the draft. Blockwork does not fill plugin fields, so follow the hint: the user
fills the field, then the save runs again.

Attached saves require `save_all_pending: true` and write every pending change
in that editor. A background save refuses with `unexpected_editor_change` when
the owned draft holds blocks or settings Blockwork did not produce or read. A
document opened at `post-new.php` must set `post.title`, `post.slug`, and
`post.status` before its first save; see
[documents](documents.md#discover-and-create-documents). For
`stored_with_field_differences`, `verification_mismatch`, `save_uncertain`, or a
timeout, see [recovery](recovery.md#uncertain-saves); never save the same
receipt twice.

## revert, status, release

`revert()` undoes the latest edit, once, while the draft is exactly as that edit
left it. `status()` reports whether an operation is running and how the last
request ended; see [recovery](recovery.md#status-and-revert).

`release()` ends the session. Attached: the tab, native lock, and Heartbeat
stay; an unsaved preview releases its save locks only after exact restoration.
Background: it refuses while a save is running, stops lock renewal, asks
WordPress to expire the owned lock (`cleanup: "release_requested"`, `not_owned`
for another user's lock, or `no_post_lock` for a Site Editor document), and
returns `close_document: true`; close the owned tab then.
`unsaved_changes: true` means edits were never saved. Afterward a background
caller refuses `connect` and editor calls with `document_released`; open a fresh
editor tab and create a new caller for it. An attached caller can `connect`
again in the same tab. On a caller that never called `connect` or `create`,
such as a `capture_page` caller, `release()` returns `ok: true` with
`cleanup: "not_connected"`, because there is no session to end.

## Document recovery without reopening an editor

If the original editor is unusable, run `recover` in an owned authenticated
wp-admin tab with the site target and the complete stored save receipt, after
any known in-flight request settles. It reads native REST state, takes no editor
lock, and never saves or replays the edit. Only a match reports verified
persistence; block validity is unavailable because no Gutenberg document loads.
Equality proves the persisted fields match, not which writer caused them. Keep
uncertain results unresolved, and connect again before any new authorized edit.
Recovery never permits retrying the old save. See
[recovery](recovery.md#uncertain-saves) for its results.
## Check and report the result

While editing, check the canvas: `view` for appearance at each width and
`measure` (or `edit`'s `measure`) for geometry and computed styles. Canvas
elements have DOM ID `block-CLIENT_ID`, usually in a same-origin iframe; for
rule attribution, interactive states, or custom elements, use focused read-only
JavaScript or the CDP CSS APIs. After a styling failure, follow
[diagnose a styling failure](styling.md#diagnose-a-styling-failure).

After the final save, check the front end once at desktop and mobile widths.
Server-rendered blocks, block scripts such as carousels and accordions, and
theme CSS loaded only on the front end can differ from the editor, and the
editor's mobile preview is wider than most phones. Batch the fixes from that
pass into one save.

Open one tab and create one caller for the front-end pass. Navigate it to each
saved `link` with `capture_page` while the tab stays open. After closing it to
edit again, open a fresh tab and create a new caller for the next pass.
It needs no `connect`, and never resizes the user's browser:

```js
const page = await cua.createBrowserTab("iab", "about:blank");
const front = await createBlockwork(page);
const captured = await front.capture_page({ url: doc.link, widths: ["desktop", "mobile"], selector: ".wp-block-cover" });
for (const shot of captured.shots) await nodeRepl.emitImage(shot.image);
```

`url` is optional. When supplied, it must be an absolute HTTP or HTTPS URL of
at most 2048 characters, and the caller navigates its tab before resizing.
Omit it to capture the current page. A caller connected to an editor refuses
`url`; open your own front-end tab and create a caller for it instead.
`navigation_failed` means navigation did not complete. Inspect the tab and its
address before trying another capture.

A fixed element that mentions cookies or consent and has a control that answers
it, such as Accept, Reject, or Got it, is hidden for the shots and put back
afterward, because it would otherwise cover part of the page in any fresh browser.
Each shot's `hidden_notices` counts the notices hidden so far in this capture, so
a nonzero count means a first-time visitor may see a notice that the shot doesn't.
Say so in your report when that matters. Pass `keep_notices: true` to leave them
showing, for example when the request concerns the notice. A notice inside an
iframe or shadow root isn't recognized and stays in the shot. `notice_cleanup`
beside the shots reports `notice_restore_failed`; close that tab before relying
on it.

To inspect an interactive style, add `states: {selector: ".button", pseudo:
["hover", "focus-visible"]}`. The first matching element receives the named
CSS pseudo-classes for every shot, and they are cleared afterward. `pseudo`
accepts one to five distinct values from `hover`, `focus`, `focus-visible`,
`active`, and `focus-within`. This forces CSS pseudo-classes only. Menus opened
by JavaScript mouse events will not open. `pseudo_state_failed` means the
browser could not apply the states. Inspect the tab or omit `states`.
`state_cleanup` reports a failed clear alongside the capture result. Close the
front-end tab before continuing if it reports `pseudo_state_clear_failed`.

`widths` takes one to six of `desktop` (1440), `tablet` (768), `mobile` (390),
or whole pixel widths from 320 to 2560; the default is desktop and mobile.
`capture_page` resizes that tab's window to each width, at 1080 pixels tall for
desktops, 1024 for tablets, and 844 for phones, scrolls `selector` (optional) to
the top of the viewport below fixed or sticky boxes covering its top edge, or
else the page to its top, gives images in view and web fonts up to 3 seconds,
captures the viewport, and puts the tab's size back; boxes with a negative
computed `z-index` contribute no selector offset. `tab_resize` reports when it
could not, as for `view`. Before each shot, running time-based animations that
have an end, such as page entrances, jump to that end, so the shot shows the
settled page; endless and scroll-driven animations keep running. Ending one can
move the page or start another, so when any ended it scrolls, waits, and ends
animations again, three passes at most, with up to 3 more seconds of loading
shared by the later passes. A hidden tab, such as one you opened in the
background, renders only when captured, so there it captures to paint the page
and settles again, three times before the shot. Look at each shot before you
rely on it, and report an image that is missing or blocky as unchecked. Each
shot has `width`, `viewport_width`, `scroll_y`, `scroll_width` (wider than
`viewport_width` means horizontal overflow), `finished_animations` (how many it
jumped to their end), `hidden_notices`, `selector_offset` (the applied backward scroll in CSS
pixels to clear overlapping bars, zero without a selector or overlapping bars,
capped at half the viewport height), `image` (JPEG bytes, a Node.js `Buffer`,
not a data URL), and `image_size` (`{width, height}` in CSS pixels). A box
taller than half the viewport, such as a modal or backdrop, is not treated as a
bar and can still cover the target; inspect the shot before using it. To save a
shot, write its bytes without decoding or splitting them:

```js
const fs = await import("node:fs/promises");
const shot = captured.shots[0];
await fs.writeFile(path, shot.image);
```

`ok: true` confirms the capture succeeded; it does not prove every element
painted. Never treat zero `finished_animations` as proof that the page settled.
Never use it on a tab the user opened. Do not use the browser's own `viewport`
control, which resizes the user's browser.

For exact front-end sizes, add `measure: {selectors, properties?}`: 1 to 20 CSS
selectors and up to 32 CSS property names, with the same defaults as
[measure](inspection.md#measure). Each shot then has `elements`, one per
selector, for its first match after animations end: `{selector, found: false}`,
or `found: true` with `tag`, a viewport-relative `rect`, and `styles`. A
selector that matches nothing at one width, such as a desktop-only element,
reports `found: false` rather than failing. Measurements over 64 KiB at one
width refuse with `measure_response_too_large`.

`invalid_capture` lists the field to correct in `issues`, and nothing was
navigated or resized. `selector_not_found` means `selector` matched nothing at that width,
including after animations ended. A missing `states.selector` also returns
`selector_not_found`. `invalid_selector` puts the offending field in
`diagnostics.field`, `selector`, `states.selector`, or `measure.selectors.N`.

For a requested front-end screenshot, use `capture_page` in your own tab as
above, and close it afterward.
