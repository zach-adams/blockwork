# Active Gutenberg editors

Use `workflow: "attached"` when the user asks for a change in an open
internal-browser Gutenberg tab, selects a block or text, or annotates the
editor. Bind that exact tab, keep its visibility and navigation, and never
reload it. No extra WordPress plugin or injected editor UI is required.

The user may keep typing while you work. Edits change their live draft directly
and leave it unsaved. Never call `save` by default, even when the draft started
clean and every pending change came from Blockwork. Normal native autosave may
still store a draft; use an [unsaved preview](#unsaved-previews) when the user
asks for no persistence.

## Connect and read

`connect` reads the saved record, the live block tree, and pending settings. A
dirty draft is expected. A foreign post lock or an identity mismatch refuses, and
so does `saved_record_changed`: another tab, user, or tool saved the document
after this editor loaded it. Native autosave and the user's own saves in this
editor are fine. The result and every `read` include `native_selection`:
Gutenberg's selection endpoints (`clientId`, `attributeKey`, `offset`) and the
selected blocks' live `client_id`, `path`, and `name`.

Connect also reports `editor_mode`. `text` means the user's editor is in Code
Mode, which has no block canvas. `view`, `measure`, and edits that need rendered
blocks or container policies refuse with `editor_code_mode`. The mode is the
user's saved preference, so ask them to choose Visual editor from the Options
menu rather than switching it yourself.

## Find the requested block

For a native selection, use `native_selection.blocks`. For an annotation, treat
the captured comment and context as evidence of the location. Use its client ID
when captured; otherwise `read` with `blocks: {search: "captured text"}` and
require exactly one match. Resolve repeated text with surrounding blocks and the
user's intent before editing; never take the first match. Rectangles, DOM paths,
and screenshot coordinates are hints, never edit targets.

A sentence annotation authorizes only that sentence: read the rich-text
attribute, preserve its formatting and surrounding text, and send the smallest
`update`. An annotated area containing several blocks does not authorize
changing every block in it.

Gutenberg renders inside an iframe, and the host's optional annotation extension
API only supports top-level document elements. Do not claim custom iframe
annotation support or overlay the editor.

## Annotations on a live page

An annotation on a live page uses the background workflow, so leave the user's
tab as it is. Find the document from the page URL with
[`discover` and `url`](documents.md#discover-and-create-documents), as the
skill's page-URL step does. The captured text joins
several blocks and is cut off, so search a short distinctive phrase from it. The
match may sit inside the annotated element. Its `path[0]` indexes a root block in
the `connect` outline; read that block with enough `depth` and pick the block the
target selector names. A control the block renders itself, such as a carousel
arrow, maps to an attribute in its `attribute_guide`.

## Edit alongside the user

Blockwork pauses native autosave only while an edit applies or a save is
prepared; Heartbeat and the user's lock continue, and an autosave already
running makes edits and saves wait for it. Rendering new blocks restores the
user's selection afterward unless they changed it meanwhile.

The user's changes elsewhere never block an edit. When they change a block your
edit depends on, the edit refuses with `block_changed`; read that block and
decide again. A change anywhere during an edit's own application (a fraction of
a second to a few seconds) refuses that edit, and Blockwork restores the draft
only if nothing of theirs would be lost. Never overwrite, merge, or reset their
work automatically.

`revert` undoes your latest edit only while the draft is exactly as it left it,
including earlier human pending work and the original clean state. Native
Gutenberg Undo also works, but one Undo click is not guaranteed to cover a whole
Blockwork edit.

`view` switches the user's editor to each requested preview and scrolls to the
block, then restores their device and scroll positions before returning.
Blockwork never resizes their window: `desktop` shows their canvas at its own
width, and exact pixel widths need a background tab. It refuses rather than
reset a canvas width the user dragged by hand. See
[widths](inspection.md#widths).

## Save only on request

`save({save_all_pending: true})` requires the user's explicit request to save
the whole pending document, including changes made before Blockwork. If their
request is unclear about that, ask. A pending publication change also needs an
explicit status change through `post.status`. Never use the native Save button to
work around a refused Blockwork save.

Resource writes such as media uploads, new terms, and shared-entity saves persist
on their own; reverting the draft does not undo them.

## Release

Finish rendered checks and any authorized save, then `release`. The tab, its
native lock, Heartbeat, and autosave stay as they were. `unsaved_changes: true`
reports a draft left unsaved.

## Unsaved previews

For a request to preview or test changes without saving:

```js
const doc = await blockwork.connect({ target, workflow: "attached", unsaved_preview: true });
```

Connect records the initial draft, client IDs, pending settings, dirty state,
and saved baseline, then holds unique native autosave and Save locks for this
editor. Reconnecting requires `unsaved_preview: true` again. `save` refuses with
`unsaved_preview_save_forbidden`. Do not create media, terms, or shared entities
for a preview, since those persist.

After rendered checks, `release` restores the initial draft and releases the
locks, provided no one else changed the draft at any point during the preview
and no settings changed.
It refuses with `unsaved_preview_pending` when human edits or settings changes
remain, and with `unsaved_preview_saved_changed` when the saved record changed.
The locks then stay held. Preserve the human work and report the unresolved
cleanup; never reset the whole draft, reload, or clear all entity edits. A lost
lock reports `unsaved_preview_lock_lost`; do not claim the no-save condition
still holds.
