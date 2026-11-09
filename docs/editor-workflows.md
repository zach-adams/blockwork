# Background and active editor workflows

Both workflows are primary Blockwork use cases. They share the native planner,
registrations, permissions, preservation checks, settings validators, and bounded
initialization. They differ in ownership and completion.
An edit in an active Gutenberg tab defaults to applying the draft without a
save call, regardless of its initial dirty state. Saving requires an explicit
whole-pending-document request. Editing through an owned background tab
defaults to saving and verifying the authorized change. Neither workflow changes
the document's publication status unless the user asks, or shows or hides the
user's in-app browser.

| Decision | Background | Attached |
| --- | --- | --- |
| Browser target | Fresh owned editor tab | Exact existing internal-browser editor |
| Connect | Clean editor, owned lock pulse, autosave locked for the session | Dirty draft expected; saved record must match the loaded one |
| Saved record | Changes only through Blockwork's saves | May also change through native autosave and the user's saves in this editor; another tab's save refuses |
| Edits | Applied to the live owned draft | Applied to the user's live draft |
| Completion | Edit, save, release, close | Edit, release, retain |
| Explicit save | Default completion; only blocks Blockwork produced or the agent read may be saved | Separate whole-pending-document request |
| Autosave | Locked for the session | Brief pause per edit and save preparation; a running autosave is awaited; held with Save lock for an unsaved preview |
| Visual checks | `view` at exact widths in the owned tab, which Blockwork resizes and restores | `view` uses Gutenberg's previews and the user's own desktop width, then restores their device and scroll; never resizes the window |
| Code Mode | The owned tab shows the visual editor without saving a preference | Stays in the user's mode; connect reports it and rendered work refuses |
| Native lock and Heartbeat | Owned and released at closure; Site Editor documents have no post lock | Retained for the user |
| After a save | Keep editing in the same tab | Keep editing in the same tab |
| Undo | Guarded revert of the latest edit | Guarded revert of the latest edit |

`src/session.ts` implements both workflows on one session per page
(`window.__blockwork_editor`). Both call `src/edits.ts` and the native settings
and inspection modules. Connect verifies identity and caches it with the REST
field schema; reads and edits make no network requests unless settings or
resources need them, and saves verify identity again. Save receipts identify the
workflow and editor instance.

The session records, per block, what Blockwork last read or produced: name,
attributes, and child IDs. An edit refuses with `block_changed` only when a
foreign change touches what it depends on: target attributes, a structural
target's subtree, an indexed destination's children, or a path selector's
ancestors. Unrelated typing never blocks. A change during an edit's own
application window refuses that edit, which rolls back only when the draft
exactly matches a state Blockwork produced. Native text selection remains
distinct from a browser annotation capture.

The host skill chooses the exact internal-browser tab and checks visible tab
inventory before creating a competing editor. That check belongs in the host,
which knows tab ownership and source mentions. A page-scoped engine cannot discover
all browser tabs. WordPress's account-based lock and fresh reads are advisory;
they cannot make a server write atomic against unrelated clients.

## Scenarios and required behavior

- A background edit proceeds when older stored markup differs only in block
  delimiters, and its result names the blocks the save will upgrade.
- A background edit that refuses because older markup changes HTML or block state
  hands the document to the
  user, the one case where an agent shows the in-app browser. It opens an attached
  editor with Save ready, waits for the user's Save, which is the only write of the
  older markup, and finishes the request in that tab.
- "Rewrite this paragraph" in a dirty editor preserves other text and pending
  title, metadata, taxonomy, and document settings, then leaves the result open.
- A selected sentence preserves its surrounding rich-text formatting. Selected
  blocks resolve through native client IDs from `native_selection`.
- A browser annotation resolves captured text or ID against the live tree through
  `read`, and must match exactly one block. Repeated text refuses an ambiguous change.
- Several comments produce one bounded edit once their targets and scope are
  resolved. No previews occur while waiting for clarification.
- The user's later change to a block an edit depends on refuses that edit; their
  typing elsewhere does not. A change during native application preserves
  intervening work and reports any partial application.
- "Try another version" edits the current draft in the same tab. "Undo that"
  uses guarded revert only while the latest edit's result remains unchanged.
- "Save it" saves all pending work only when the request covers that consequence.
  A pending publication change is never adopted as Blockwork authorization.
- "Test without saving" uses attached `unsaved_preview: true`. Native autosave and
  Save locks remain held across calls and failures. Release restores the initial
  draft when only Blockwork's edits remain; a changed saved record, settings
  changes, or human edits prevent automatic release.
- Two editor tabs for the same document require exact target resolution. A
  navigation or reload ends the session; unsaved edits do not survive it.
- Shared patterns/templates/navigation retain explicit shared scope. Reverting a
  draft does not undo separately persisted media or term writes.
- A lost edit response leads to `status`; a lost save response leads to
  `recover` with the stored receipt. Neither is ever replayed.

## Footnote reference updates

Paragraph content updates at any depth pair the complete final
`settings.meta.footnotes` JSON list with the planned blocks when the reference
order changes. Include a bare root Footnotes insertion only when none exists.
The list follows depth-first reference order, including references in headings,
and repeats bodies for repeated IDs. Each label uses its ID's first position.
Supply every paragraph update needed to renumber references in the same request.
Reference changes outside paragraphs are unsupported. Other edits and settings
belong in separate requests. Text changes that keep reference order and body-only
settings writes use the ordinary path. Both workflows use guarded revert; attached
saves require whole-pending-document intent. See the [complete callable examples](../skills/blockwork/references/edit.md#insert-a-footnote-with-its-body).

## Root paragraph structural Footnotes

Root paragraph moves, removals, and insertions of copied markup preserve native
Footnote numbering and body order. The editor reads the observed metadata and
pairs the final numbered blocks with the complete metadata in one native entity
edit. Repeated reference IDs repeat their body records, and every occurrence uses
the first occurrence's number. Unrelated headings and nested blocks remain in
place. Footnote references inside them are outside this operation's scope.

Use ordinary `move`, `remove`, or `insert` edits at the root. The session must
have observed the paragraph references and complete metadata before the edit.
Metadata and reference conflicts require a fresh read. Numbering changes to
existing paragraphs require their native attribute permission as well as the
requested structural permissions. Inserted paragraphs receive attribute
validation and the native root insertion policy on their final numbered content.
Other edits, pattern opening, and unrelated settings require separate requests.
Raw `update` requests that change reference order use the paired path above.

For a copy between documents, read the source with `blocks: {
client_id: source_id, markup: true }, settings: true`, then read the destination
with `settings: true`. Insert the source markup and a root `core/footnotes` block
if the destination lacks one. Supply `settings.meta.footnotes` as a JSON string
containing the complete final `{ id, content }` list in reference order, including
destination bodies and repeated records for repeated IDs. Existing body contents
must remain unchanged. Markup alone cannot supply a missing source body.

A successful structural Footnote edit adds `footnote_writes`. It reports
`source` as `document` or `settings`, `requested_edits`,
`companion_writes` for existing paragraphs, `numbered_paragraphs`, and up to 80
final `affected_paths` for numbering changes. `affected_paths_truncated` gives
the total when needed. `body_count_before`, `body_count_after`,
`reference_count`, and `order_changed` describe the metadata change without
returning bodies in this evidence. The existing `settings` result still reports
written settings. Companion writes do not increase the requested edit count.

This path uses the existing exact checkpoint and guarded `revert`. It preserves
pending fields, key presence, client IDs, selection, and dirty state. An uncertain
partial mutation keeps the recovery lock. Read the draft and complete settings;
do not replay the request or restore over foreign work.

## Canvas loading

Connect does not load the editor canvas. Operations that need it load it through
`src/canvas.ts`, so where a host blocks Gutenberg's `blob:` iframe, a background
tab stays blank until then. Loading it at every connect was measured and
rejected:

- Loading runs every block's edit component, and those can change the document.
  Query, Heading, and Embed write attributes after mounting. A slow Embed response
  can arrive during an unrelated edit and cause a refusal, which a root edit on a
  blank canvas avoids.
- Empty Buttons, List, and Details blocks gain template children on load without
  marking the editor dirty. No public API shows who added those children, so
  Blockwork cannot tell Gutenberg's template from a plugin's insertion, and
  accepting them without a read could save content nobody asked for.
- Loading took 0.5 to 1.4 seconds for 15 to 1000 blocks on a local site, but it
  starts requests that keep running after any wait expires. The cost on hosted
  sites is unmeasured.
- The benefit is small. Operations that need the canvas already load it, and the
  tab is normally off screen. It would save about half a second on the first
  `view` and show a rendered editor if someone opened the tab.

Reopen this only with a concrete need for the canvas before the first operation,
hosted measurements, and tests against delayed Embeds. Navigation fallback records
are not a reason either way: opening an editor on a page with an empty Navigation
block creates one on the server, with or without a canvas.

Where the canvas does load by itself, Gutenberg fills those empty blocks before
connect. Background connect accepts that only when nothing else differs from the
saved record, reports the blocks in `template_fills`, and leaves their children
unread. Because nothing proves who added them, the read a save then requires is
the safeguard. Shared references, deprecated markup, and content that needs
format normalization never count as fills.

## Evidence and remaining gates

The evidence below predates the 2026-10-07 protocol refactor to connect, read,
edit, and save. The engine checks it exercised still apply; the desktop
acceptance runs must be repeated with the new calls.

Unit tests cover both lifecycles, dirty settings, live/server staleness, native
initialization, guarded revert, annotation ambiguity, editor-instance isolation,
publication intent, and lost-save recovery. The existing background suite remains.
The desktop integration suite includes an attached scenario beside the background
scenarios. Local native verification uses a disposable draft on a local site
and the internal browser.

The 2026-10-05 installed-bundle run passed attached dirty-draft inspection,
annotation-hint resolution, mixed paragraph/container application, retained native
text selection, guarded revert, explicit whole-draft save, and retained-editor
release. A separate fresh background editor passed save and owned-lock release.
All 214 unit tests, formatting, lint, type checks, and packaging passed. Installed
files match all eight packaged files. The disposable draft was moved to WordPress Trash;
no users were created and all test-owned browser tabs were closed. The added
Playground attached scenario and full integration matrix were not run here.

These implementation checks are not full acceptance. Before describing
the full annotation/Undo experience as verified, prove host annotation capture in
Gutenberg's iframe and one native toolbar Undo level across asynchronous block
initialization. The current supported undo path is Blockwork's guarded `revert`.
Test attached shared entities and realistic latency before calling them verified.
Keep background acceptance checks equally required.
