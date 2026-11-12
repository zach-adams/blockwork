# Edit requests and native constraints

Blockwork-owned keys use `snake_case`, such as `client_id`, `parent_client_id`,
and `update_style`. Gutenberg data keeps its registered spelling, such as
`fontSize`, `className`, and `@mobile`. Block trees use `inner_blocks`;
Gutenberg runtime objects use `innerBlocks`.

## Before building a section

1. Print `doc.custom_blocks` and check for a theme or plugin block that already
   does the job, such as a carousel, tabs, accordion, or form. Use it instead of
   composing the same thing from core blocks. Read its `attribute_guide`, insert
   containers empty when they add their own children, and fill those reported in
   `changed` before inserting more. Leave no blank child behind.
2. Read existing sections and other pages with `read({source})` for typography,
   colors, and spacing. Use theme presets and native controls. To reuse a section,
   read it with `markup: true`, change its text, and insert that markup to retain
   styling and responsive attributes. For other saved pages, read
   [source documents](inspection.md#other-documents).
3. For images, read [media inspection](media.md#inspect-media-and-attach-it-to-blocks)
   and use inspected attachment values.

Build a section in one `edit`, then refine it in small batches. Repeated custom
items need one or two per edit; see [native initialization](#native-initialization).

## edit

```js
const result = await blockwork.edit({
  edits: [
    { op: "update", client_id: "…", attributes: { style: { spacing: { margin: { bottom: "12px" } } } } },
    { op: "insert", parent_client_id: "…", index: 2, block: {
      name: "core/group",
      attributes: { metadata: { name: "Pricing" }, layout: { type: "constrained" } },
      inner_blocks: [{ name: "core/paragraph", attributes: { content: "New section." } }],
    } },
  ],
  measure: true,
});
```

`edit` takes up to 32 ordered `edits` and optional `post`, `settings`,
`binding_writes` (see
[settings](documents.md#document-properties-and-settings)), `media_bindings`
(see [media](media.md#inspect-media-and-attach-it-to-blocks)), `scope` for
shared entities, `open_pattern_section`, and `measure`. It plans the whole batch
on a copy, checks every native rule, applies it to the live editor, and verifies
the result. It never saves.

`open_pattern_section: {section_client_id: "…"}` opens and verifies that
unsynced section through Gutenberg's public action before planning; it requires
explicit opt-in and changes the user's visible section in an attached editor. An
ancestor's explicit `templateLock: "contentOnly"` still limits updates to
content-role attributes, even when the native mode becomes `default`. Edit
results and `status()` report
`pattern_section: {section_client_id, state_available}`; see
[pattern section recovery](recovery.md#pattern-sections) for failures and
recovery.

| Operation | Fields beyond `op` |
| --- | --- |
| `update` | target, `attributes` to merge, optional `unset` paths |
| `update_style` | target, optional `set` `[{property, value}]` and `unset` property paths; see [styling](styling.md) |
| `insert` | `block` tree or `markup`; optional destination, `index`, `media_map`, and `link_map` ([copy sections between sites](media.md#copy-sections-between-sites)) |
| `replace` | target, `block` tree or `markup` with exactly one root; optional `media_map` and `link_map` |
| `move` | target; optional destination and `index` |
| `remove` | target |
| `insert_pattern` | registered `pattern` name; optional destination and `index` |
| `insert_variation` | block `name`, registered `variation`, optional `attributes`; optional destination and `index` |
| `set_block_style` | target, registered `style` name, or `null` to clear |
| `insert_reference`, `update_reference` | shared `reference`; see [shared documents](shared-and-abilities.md#shared-documents-and-references) |
| `detach_reference` | target of a synced `core/block` reference; replaces it with static blocks, preserving instance overrides; see [detach a pattern](shared-and-abilities.md#detach-a-pattern-in-one-document) |

A target is `client_id` or `path`; an optional `name` must match. A destination
is `parent_client_id` or `parent` (a path); omit both for the document root.
Omitted `index` appends; a move's index counts after removing the source.
Selectors resolve against the tree left by earlier edits in the same batch. Use
`client_id` for existing blocks, and paths only for blocks inserted earlier in
the same batch.

To wrap existing blocks, insert the empty wrapper, then move the existing blocks
into it. Do not replace them with copies. A move reuses the existing block and
avoids initializing a new copy of a dynamic block.

```js
await blockwork.edit({ edits: [
  { op: "insert", index: 0, block: { name: "core/group" } },
  { op: "move", client_id: "existing-client-id", parent: [0], index: 0 },
] });
```

`update` merges objects into the current value and replaces arrays and scalars,
so `{style: {spacing: {padding: {top: "32px"}}}}` keeps every other style.
`unset` paths such as `["style","spacing","margin","top"]` run after the merge,
remove that key, and drop emptied parent objects; a one-key path, or a bare name
such as `"caption"`, resets the attribute to its registered default. Written values drop nested empty objects,
as native controls do. Values must match the registered schema. `metadata`
accepts only `name`, which labels a block in List View, `blockVisibility`, and the
`patternName` and `categories` members Gutenberg writes when a pattern is inserted,
so markup from `read` can be sent back. `blockVisibility` is what core's Hide control
writes: `{viewport: {mobile: false}}` hides a block at that width (`mobile`, `tablet`,
or `desktop`), `false` hides it everywhere, and `unset: [["metadata","blockVisibility"]]`
shows it again. A block with `supports.visibility: false` refuses it. An `update` may resend a block's current
`patternName` but not change or clear it. Other members, such as `bindings`, refuse with
`diagnostics.attribute` naming the member, such as `metadata.bindings`. An attribute that a
block support now stores under `style`, such as `textAlign`, refuses with
`diagnostics.use_instead` naming its style path.

`block` trees use registered names, attributes, and `inner_blocks`. `markup`
takes serialized `<!-- wp:… -->` content parsed by the site's registrations;
several root blocks become consecutive inserts. Invalid or unsupported markup
refuses.

### Insert a footnote with its body

Read all blocks and document settings first. When the document has no
Footnotes block, one request can update a paragraph's `content` at any depth, append
`core/footnotes` at the document root, and supply the complete final
`settings.meta.footnotes` JSON string. Preserve existing bodies and use the
reference's `data-fn` value as its body ID. For an inspected paragraph and an
otherwise empty footnote list, the request is:

```js
await blockwork.edit({
  edits: [
    { op: "update", client_id: "inspected-paragraph-id", attributes: {
      content: 'Claim <sup data-fn="note_a" class="fn"><a href="#note_a" id="note_a-link">1</a></sup>',
    } },
    { op: "insert", block: { name: "core/footnotes" } },
  ],
  settings: { meta: { footnotes: JSON.stringify([
    { id: "note_a", content: "Authorized note body" },
  ]) } },
});
```

Keep these two edits in this order, with no other settings, attributes, bindings,
media operations, or pattern-section opening in this request. Blockwork checks
both native policies, then applies the explicitly supplied blocks and metadata
together. It verifies the complete document, metadata, selection, and pending
settings after native rendering. Unrelated blocks and metadata remain exact.
The usual `applied` result and explicit save workflow apply. Attached saving
still requires `save_all_pending: true`. A guarded `revert` restores the paired
state only while its complete checkpoint still matches.

For a nested paragraph, `path` may replace `client_id`, for example
`{ op: "update", path: [0, 1, 0], attributes: { content: 'Claim <sup data-fn="note_a" class="fn"><a href="#note_a" id="note_a-link">1</a></sup>' } }`.
Use it as the first edit in the complete request above.

When a Footnotes block already exists, omit the insert. To add a second note
after the first, submit both bodies and the correctly numbered reference:

```js
await blockwork.edit({
  edits: [{ op: "update", client_id: "inspected-second-paragraph-id", attributes: {
    content: 'Second claim <sup data-fn="note_b" class="fn"><a href="#note_b" id="note_b-link">2</a></sup>',
  } }],
  settings: { meta: { footnotes: JSON.stringify([
    { id: "note_a", content: "First body" },
    { id: "note_b", content: "Second body" },
  ]) } },
});
```

The list follows depth-first document reference order, including references in
headings. Repeat a body for each occurrence of its ID. Every label is the
one-based index of that ID's first occurrence. If a new reference comes before
an existing one, include a `content` update for each paragraph whose label
changes in the same request. For example, with the new note first:

```js
await blockwork.edit({
  edits: [
    { op: "update", client_id: "new-paragraph-id", attributes: { content: 'New <sup data-fn="note_b" class="fn"><a href="#note_b" id="note_b-link">1</a></sup>' } },
    { op: "update", client_id: "existing-paragraph-id", attributes: { content: 'Existing <sup data-fn="note_a" class="fn"><a href="#note_a" id="note_a-link">2</a></sup>' } },
  ],
  settings: { meta: { footnotes: JSON.stringify([{ id: "note_b", content: "Second body" }, { id: "note_a", content: "First body" }]) } },
});
```

Removing the only reference keeps the Footnotes block and supplies an empty list:

```js
await blockwork.edit({ edits: [{ op: "update", client_id: "paragraph-id", attributes: { content: "Claim" } }], settings: { meta: { footnotes: JSON.stringify([]) } } });
```

To swap two references in one paragraph, supply their new labels and body order:

```js
await blockwork.edit({ edits: [{ op: "update", client_id: "paragraph-id", attributes: { content: 'Claim <sup data-fn="note_b" class="fn"><a href="#note_b" id="note_b-link">1</a></sup> <sup data-fn="note_a" class="fn"><a href="#note_a" id="note_a-link">2</a></sup>' } }], settings: { meta: { footnotes: JSON.stringify([{ id: "note_b", content: "Second body" }, { id: "note_a", content: "First body" }]) } } });
```

Use only paragraph `content` updates and the optional bare root insert in a
paired request. References outside paragraphs count in the order but cannot be
added, removed, or renumbered by this request. Preserve the draft and report the
limit when that is necessary. Put unrelated changes in another request.

For a partial result, follow [paired footnote recovery](recovery.md#paired-footnote-edits).

### Move, remove, or copy root footnoted paragraphs

Read all document blocks and settings before a structural Footnote edit. Root
paragraph moves, removals, and copies use ordinary requests. For example:

```js
await blockwork.read({ blocks: "all", settings: true });
await blockwork.edit({ edits: [
  { op: "move", client_id: "inspected-footnoted-paragraph-id", index: 0 },
] });
```

Blockwork plans the final reference numbering and complete body list from the
observed document. It explicitly authorizes and writes those companion changes
with the requested structural edits. Existing body contents stay unchanged.
A local copy repeats its referenced bodies and uses core's numbering for repeated
IDs. Unrelated structural edits use their ordinary path. Raw `update` requests
that change reference order require the paired request above; text edits that
keep the same references use the ordinary path.

For a copy between documents, read the source paragraph's markup and settings,
then read every destination block and its settings. For a source paragraph with
one inspected reference and a destination that already has a Footnotes block:

```js
const source = await sourceBlockwork.read({
  blocks: { client_id: "inspected-source-paragraph-id", markup: true },
  settings: true,
});
const destination = await destinationBlockwork.read({ blocks: "all", settings: true });
const sourceBody = JSON.parse(source.settings.values.meta.footnotes)
  .find(note => note.id === "inspected-source-reference-id");
const finalBodies = [
  ...JSON.parse(destination.settings.values.meta.footnotes || "[]"),
  sourceBody,
];
await destinationBlockwork.edit({
  edits: [{ op: "insert", markup: source.markup }],
  settings: { meta: { footnotes: JSON.stringify(finalBodies) } },
});
```

Use the actual inspected IDs and preserve all destination bodies. If the
destination lacks a Footnotes block, append `{op: "insert", block: {name:
"core/footnotes"}}` after the paragraph insertion in that request. The declared
body list must contain exactly the final references in order, repeating a body
for a repeated ID. Markup alone contains no source body. Missing bodies refuse
before mutation and require the source and destination reads above.

Successful structural requests add `footnote_writes` with `source`
(`document` or `settings`), `requested_edits`, `companion_writes`,
`numbered_paragraphs`, bounded `affected_paths`, body/reference counts, and
`order_changed`. Companion writes do not increase the requested edit count.
Saving stays explicit, and guarded `revert` restores the complete checkpoint.
Keep other edits, pattern opening, and unrelated settings in separate requests.
Moving, removing, or copying a nested footnoted paragraph, or deleting a section
that contains one, refuses with `footnote_root_operations`. References in other
block types can't be moved this way either. Preserve those requests and report
the limit rather than adopting a native write outside the plan.

### Coordinate existing Tabs panels

Read the Tabs root, tab list, and panels before a rename, removal, or move.
Supply every companion write in the same request. To rename the first panel
of an inspected two-panel Tabs block, send:

```js
await blockwork.edit({ edits: [
  { op: "update", client_id: "inspected-panel-id", attributes: { label: "Revised" } },
  { op: "update", client_id: "inspected-tab-list-id", attributes: {
    tabs: [{ label: "Revised" }, { label: "Retained second label" }],
  } },
] });
```

Use the actual inspected labels and IDs. For removal or a move within the same
Tabs block, send that structural operation first, the Tabs root's
`editorActiveTabIndex` update second, and the complete final tab list last.
The tab list must match the final panel order and each panel's `label || ""`.
Indexes are zero-based. A move sets `editorActiveTabIndex` to its destination
index. Removing panel `i` from `n` panels sets it to `i` when `i < n - 1`,
or `n - 2` when removing the last panel. Keep at least one panel, as core does.
Keep extra attributes, settings, bindings, media operations, and pattern-section
opening in separate requests.

For inspected panels named First, Second, and Third, remove Second with:

```js
await blockwork.edit({ edits: [
  { op: "remove", client_id: "inspected-second-panel-id" },
  { op: "update", client_id: "inspected-tabs-root-id", attributes: { editorActiveTabIndex: 1 } },
  { op: "update", client_id: "inspected-tab-list-id", attributes: {
    tabs: [{ label: "First" }, { label: "Third" }],
  } },
] });
```

Starting from those three panels, move First after Second with:

```js
await blockwork.edit({ edits: [
  { op: "move", client_id: "inspected-first-panel-id", parent_client_id: "inspected-panels-container-id", index: 1 },
  { op: "update", client_id: "inspected-tabs-root-id", attributes: { editorActiveTabIndex: 1 } },
  { op: "update", client_id: "inspected-tab-list-id", attributes: {
    tabs: [{ label: "Second" }, { label: "First" }, { label: "Third" }],
  } },
] });
```

Blockwork resolves both native policies before applying the supplied changes
together. It checks the complete document and leaves metadata untouched.
The normal `applied` result, explicit save, and guarded `revert` apply.
A missing or mismatched companion list refuses before mutation with
`tabs_companion_required`; rebuild the complete request from fresh reads.
Partial requests do not acquire silent companion writes. To append a fourth
panel to the inspected three-panel example, explicitly supply its empty child:

```js
await blockwork.edit({ edits: [
  { op: "insert", parent: [0, 1], block: {
    name: "core/tab-panel", attributes: { label: "Fourth" },
    inner_blocks: [{ name: "core/paragraph" }],
  } },
  { op: "update", path: [0], attributes: { editorActiveTabIndex: 3 } },
  { op: "update", path: [0, 0], attributes: {
    tabs: [{ label: "First" }, { label: "Second" }, { label: "Third" }, { label: "Fourth" }],
  } },
] });
```

Use inspected paths and labels. ADD accepts only this explicit single empty
Paragraph child, and checks its mounted parent's allowed blocks before success.
A denied new child restores the draft only while the exact reached state is still
owned. Preserve any partial result and read before another edit.

### Supply known context-derived attributes

A move between existing parents of the same registered type can carry an explicit
update of the moved leaf in the same request. The leaf must use custom namespaced
context declared by both parents. WordPress entity and core contexts, subtrees,
new parents, and unrelated operations are outside this paired path.

When the inspected fixture's destination provides blue and its documented label
attribute is resolvedTone, supply that known final value explicitly:

```js
await blockwork.edit({ edits: [
  { op: "move", path: [0, 0], parent: [1], index: 0 },
  { op: "update", path: [1, 0], attributes: { resolvedTone: "blue" } },
] });
```

Paths resolve sequentially. Use values established by the block's documentation
or the user. Blockwork does not infer a custom block's derivation algorithm.
Move-only requests that trigger unsupplied attribute changes remain unsupported.
The complete request checks native move, insertion, and edit permissions before
one content write, then verifies the whole document, IDs, metadata, settings, and
selection. Save and guarded revert use their normal operations.

### Result

`editor_result: "applied"`, `edit_count`, `dirty`, `valid`, `block_count`, and
`changed`: up to 80 `{client_id, name, path, preview}` entries for every block
the edit created or changed, including native template children. Use those IDs
for follow-up edits. A block that existed before the edit and whose attributes
changed adds `properties`, up to 20 dotted attribute paths such as
`style.spacing.blockGap.top`, and `properties_truncated: true` past that; use
them to confirm the edit changed only what you meant to. `measure: true` adds
measurements of each edit's primary block; `measure: {blocks?, properties?}`
chooses blocks and CSS properties. A measurement failure appears as
`measure.ok: false` and does not affect the applied edit. Non-identifier keys in
`properties` appear as `<key>`.

`notes` appears when the edit changed a value that one of core's controls writes
together with others, and the block doesn't hold the rest. The edit is applied either
way, and a note changes nothing by itself. Each note has `control`, `client_id`,
`name`, `path`, `message`, and `edits`, which holds ready-to-send `update` operations
for what core also writes. Send them in your next `edit`, in batches of 32, unless the
request asks for something else, such as a video that autoplays with sound. A note
appears only on the edit that changes the value, so act on it before saving.

`incomplete: true` means `edits` can't cover everything, such as a Cover's `isDark`
over an image or an attachment's size URL, and `message` says what else to send.
`restricted` lists `{client_id, reason}` for blocks whose writes a native lock or
editing mode holds back. Leave those as they are and say so in your report; don't
remove the lock to send them. A new block gets a note only for autoplay, a decorative
image, or a new Accordion item, because its other values may be a copy or pattern
someone chose.

A note's `edits` stop at 64, with the full count in `edits_truncated`, and `notes`
stops at 32, with the full count in `notes_truncated`. Past either limit, make the same
write on the remaining blocks you changed, because a note doesn't come back.

### Native initialization

New blocks other than Paragraph and Separator, and any new block with children,
render once in tree order so their edit components finish initializing. An edit
fails only when rendering stops making progress or runs 30 seconds in total. On a
local site, inserting 50 blocks into an 800-block page took about 7 seconds and
inserting 200 blocks took about 25, and hosted sites take longer, so split inserts
above about 100 blocks. Custom blocks in a hidden tab are slower: one tab panel of
about 15 blocks took 6 seconds, and four in one edit reached the 30-second cap.
Insert repeated custom items, such as tab panels, slides, or cards, one or two
per edit. A move remounts the block and its descendants, so moving a large
section costs about as much as inserting it.

Initialization may add registered attributes to new blocks, including template
locks. A block inserted with no children (omitted or empty `inner_blocks`) may
add its own template children, as it does for a user; they must be supported,
correctly nested blocks. Read them from `changed` and fill them in the next
edit. Requested values, existing blocks, and requested children must stay exact,
and nested children must be in their parent's allowed-block list. A locked
template that disagrees with requested children resyncs natively and fails the
check, so insert such blocks empty.

### Conflicts

Between calls, edits check changes to the blocks they depend on. An edit refuses
with `block_changed` only when someone else changed what it depends on since
Blockwork last read or changed it; read the listed blocks and decide again. A
failed edit reports `editor_result` `not_applied`, `rolled_back`, or `partial`.
`editor_content_changed` means the live tree changed during planning, before the
edit ran. `diagnostics.mismatches.blocks` lists paths, names, and changed
properties or `children`, without values. Preserve the draft, `view` the
container if it has not rendered, then `read` its subtree, review the changes,
and prepare a new edit. Never retry automatically. A page `template` change can
change server-derived editor policy, such as allowed blocks, so make structural
edits before it. See [recovery](recovery.md#conflicts-and-rollbacks) for the
exact rules.

## Limits and native behavior

- WordPress 7.0 or later. Calls on an older site, or on a wp-admin page that
  does not name its version, refuse with `wordpress_unsupported` before changing
  anything; `diagnostics.wordpress_version` and `minimum_version` say why.
- 32 edits per call after markup expansion; 200 blocks per inserted tree; 15
  path levels; 2,000 blocks per document; 256 KiB of stored block content per
  document; 1 MiB per document read, including metadata and any rendered fields;
  256 KiB per other REST response read. `connect`, `read({source})`, and `prepare_save` refuse
  content over the limit with `content_too_large`, the last before writing. Save
  verification and `recover` skip it, so a save WordPress grew past it still
  settles.
- Structural edits require a fully supported, valid document. On documents with
  unsupported blocks, only `update` and `update_style` run, and the planner
  proves that the serialized bytes change only inside the targets.
- If the saved content does not round-trip through Gutenberg's serializer,
  background `connect` reports `normalization_required: true`. When the stored
  blocks are valid, any deprecated markup keeps its stored HTML, and unsupported
  blocks are limited to raw content whose exact regions and native save output
  pass preservation proof, edits plan from Gutenberg's own markup. The next save
  also rewrites those blocks' formatting and delimiter attributes. The first such
  `edit` result names them in `rewritten_blocks`, up to 10 with `path`, `name`, and
  `client_id`, and counts them in `rewritten_block_count`, which can include the
  requested blocks. When you report the save, tell the user it also rewrote the
  stored markup of about that many blocks.
  Otherwise edits refuse with `initial_serialization_changed`, whose diagnostics
  carry the same two fields. When markup differs but block state matches, they also
  report `markup_changed: true` and `block_state_equal: true`.
  [Have the user re-save the document](recovery.md#older-stored-markup) instead of
  changing unrelated attributes or saving through the UI.
- Registered rich-text values, including query-sourced table cells, compare in
  the spelling a browser parses them to, so U+00A0 and `&nbsp;`, `>` and `&gt;`,
  and `&copy;` and `©` are the same text. Other text and markup differences still
  fail verification. String-typed attributes keep exact
  comparisons regardless of source, including HTML-sourced script content.
- Rich-text values are HTML. A bare `&` in a requested value is written as
  `&amp;`, and a `<` that opens no complete tag as `&lt;`, as the editor writes
  them; entities such as `&amp;` stay as sent. `a<b then c` is literal text, but
  `a<b and c>d` holds a complete tag, so write that `<` as `&lt;`.
- Round-trip checks accept added comment-attribute defaults, on touched or
  untouched blocks, only when filling them into the planned block leaves native
  serialization byte-identical. The same proof accepts an omitted HTML boolean
  attribute parsing as `false`. Other sourced attributes stay strict; do not write
  unrelated defaults or save through the UI to bypass a refusal. Local-role
  attributes, such as Tabs' `editorActiveTabIndex`, are editor state core never
  saves, so round-trip checks ignore them.
- Markup from `read` and registered patterns can contain defaults that violate
  their declared schemas. Blockwork accepts only those exact defaults whose
  omission from the request recreates the same native attributes and markup.
  Explicit block attributes must still match their schemas.
- Insert a dynamic Post Date with `{ name: "core/post-date" }`, or use the
  inspected native `post-date` or `post-date-modified` variation. Blockwork
  preserves the exact native `core/post-data` datetime binding for `date` or
  `modified`. Every affected current-post or Query preview entity must resolve
  a valid backing date before native rendering. Supply explicit Post Template
  children. Automatic empty-template population and nested Post Template
  contexts remain unsupported. `post_date_context_unavailable` identifies the
  affected path and repair step. Preserve the draft if the context cannot resolve.
- Existing supported Post Date bindings permit unbound style edits and native
  moves and removals. Bound `datetime` writes and unsets, and caller-supplied
  binding definitions, refuse. A supplied literal `datetime` stays literal;
  an empty value cannot request a dynamic date. Never invent a date.
- A File variation without a file URL and a blank Video can hold values native
  serialization cannot preserve. Those placeholder requests remain unsupported.
  Inspect the media record and supply its URL during insertion before binding it;
  do not remove requested attributes to force a blank insertion.
- An offered, registered, unsynced Comments pattern can be inserted alone at the
  current post or page root when its native comment query resolves empty. Native
  pattern metadata and all hidden content are preserved. This authorizes that
  complete recipe only. Later edits inside hidden Comment Template descendants
  still need their ordinary native editing context. Other destinations and
  unresolved contexts keep the normal insertion checks. Do not add comments or
  bypass a native policy to force insertion.
- Insertion follows core's own policy: `canInsertBlockType` for a live parent, and
  a block whose registered parents include `core/post-content`, such as Page Break,
  fits at the document root. Children of a new container are checked once it
  mounts, against its own allowed list, so a Link fits in a new Navigation Submenu.
  A `multiple: false` block, such as More or Footnotes, refuses a second copy with
  `insertion_refused` and `diagnostics.constraint: "single_use_block"`.
- Template locks inherit as core's do: the nearest explicit lock governs, so an
  inner `templateLock: false` lifts an outer `all` or `insert`. An outer
  `contentOnly` always applies.
- A blank page's single unmodified default paragraph can be updated, replaced,
  or removed through its client ID.
- Shared references are leaves; their content is a separate document target.
  Bound blocks, raw HTML and classic content, and lock changes are out of scope.
- Inserting a Query first reads its editor preview (12-second budget). For an
  inherited Query, Gutenberg ignores taxonomy filters and adjusts the preview
  for supported template slugs. In the post editor without a template context,
  it previews the Query's other attributes. When a post editor renders a
  surrounding template, Blockwork cannot read that template's context, so its
  preflight may differ from Gutenberg's preview. Unavailable context refuses with
  `query_preview_context_unavailable` and `diagnostics.reason`. An empty preview refuses with
  `query_preview_empty` before any change. Updates to an existing Query or Post
  Template read no preview, even beside an insert elsewhere in the same edit.
- Templates, template parts, and navigation have no post lock, since the Site
  Editor neither takes nor checks one. Only `prepare_save`'s saved-record check,
  which compares fields and content, catches a change another editor already
  saved.
- The post lock is advisory and identifies users, not tabs. Another client can
  still write between the last check and the save. WordPress ignores a lock held
  by the current user, opening an editor overwrites it, and REST does not expose
  it, so another editor signed in as the same user is undetectable.
  `prepare_save` refuses with `saved_record_changed` when that editor already
  changed a compared document field, as a save or an author's autosave of their
  own draft does. An autosave stored as a revision, or a write after
  `prepare_save`, goes unnoticed. A later save from that editor overwrites
  Blockwork's change, so the skill tells the user about such an editor.

Pattern insertion can prepare a new Spacer inside a new explicit vertical flex Group in
the representation Gutenberg uses. An explicit pixel height or a spacing preset
resolving to pixels becomes the Spacer's fixed flex basis, with height zero. The current
settings must stay unchanged through application. Relevant setting callbacks, ancestor
overrides, unresolved presets, and other layouts are outside this conversion. It does
not change existing Spacers or normalize direct updates. A resolved preset follows
native insertion under the current settings, so it no longer tracks later changes to
that preset.

Query normalization preflight checks each affected state that native rendering can
observe. When core would replace supplied properties, the error names their paths and
reports `diagnostics.native_values`. Read the Query and its context, then use those
values only if they preserve the intended query. A valid independent Query can supply a
positive `perPage` with `excludeCurrent: null`. An incompatible inherited count or
exclusion request remains unsupported. Existing Query updates can return no results
without mounting their absent descendants. Other containers and inserted subtrees retain
their native rendering and insertion checks.
