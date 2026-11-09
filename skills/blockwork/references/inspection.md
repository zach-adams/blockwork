# Read, measure, and view

## read

`read` reads the live editor and makes no network requests, except with
`source`.

| `blocks` | Result |
| --- | --- |
| `"roots"` (default) | Outlines of root blocks |
| `"all"` | Outlines in document order |
| `{client_id, depth?, limit?, markup?, media?}` | The block and descendants to `depth` (default 1, max 8; larger values clamp to 8), with attributes; `markup: true` adds the subtree's serialized `markup`, and `media: true` its attachments (see [copy a document](media.md#copy-a-document-to-another-site)) |
| `{depth, limit?}` | Every block down to `depth` from the document root, with attributes: `1` is the root blocks |
| `{search, client_id?, attributes?, limit?}` | Case-insensitive match on block name, metadata name, anchor, and visible text, including every rich-text attribute such as Table cells and Quote citations, optionally inside one block. Visible text has tags removed and entities decoded, and any whitespace, including a non-breaking space, matches one space; it never matches markup such as a `style` value |
| `{name, search?, client_id?, attributes?, limit?}` | Blocks of a type, in document order, so `blocks[0]` is the first one. `name` is a pattern or up to 16 of them, ignoring case: `core/table` is exact, `table` or `wp:table` matches in any namespace, and `*` is a wildcard, as in `core/*` or `*accordion*`. `search` narrows the matches, `client_id` limits them to a subtree, and `attributes` works as it does for `search` |

`limit` is 1 to 50 (default 20; outlines default to 60); a larger value clamps to 50. An outline row has
`path`, `name`, `client_id`, `preview` (that same visible text), `child_count`,
`support`, `reason`, and `editable`. `editable` describes unrestricted attribute editing. `removable`
reports removal separately, including native removal permission and container
policy; when false, `removal_restriction` gives its `reason` and any
`section_client_id` or `editing_mode`. A block can allow attribute edits while
forbidding removal. A read leaves a blank canvas blank, so a lock that only
rendering reports, such as `core/accordion-item`'s, is missing from `removable`
until an edit or `view` loads the canvas. These are live policy checks, not permission to bypass
request validation or currentness checks. When `editable` is false, `reason`
says why: `pattern_section` (inside an unsynced pattern, `section_client_id`,
that Gutenberg keeps content-only until explicitly opened), `content_only` (a
contentOnly template lock or the editor's mode), `editing_disabled` (such as
while another pattern section is open), `block_locked`, `bound_attributes`,
`unsupported_subtree`, or a `support` reason. The editing-mode reasons add
Gutenberg's `editing_mode`. A block whose `editing_mode` is `contentOnly` still
accepts `update` of attributes its `attribute_guide` lists with
`role: "content"`, such as text, links, and an image's `url` and `alt`, as
Gutenberg allows a user. Any other change refuses with `block_not_editable` and
the same `reason`; use `open_pattern_section` for an intended pattern opening,
never toolbar clicks through raw CDP.

`selection` reports `total`, `returned`, and `truncated`. A `depth` read adds
`depth_limited`, true when descendants below `depth` were left out; read a
deeper block by its `client_id` to see them. `clamped` appears only when a
bound was lowered, with the `depth` or `limit` actually used. `validity` lists
unsupported and invalid blocks. A search for an annotation's text must match
exactly one block before you edit it. Attached reads also return
`native_selection`.

Optional guides in the same call:

- `attribute_guide: {name}` or `{client_id}`: registered attributes with types,
  enums, defaults and sources, registered `styles`, and inserter `variations`.
- `style_guides: [{client_id | name, properties?}]`: up to 16 styling contracts,
  plus shared `style_catalogs` and `style_rules`; see [styling](styling.md).
- `insertion: {parent_client_id?}`: the native template lock and inserter
  candidates for a container, or the root.
- `patterns: true`: registered unsynced pattern names and titles.
- `settings: true`: writable document fields, current values, and taxonomies. It
  can be large; request it for settings work only.

Responses are capped at 64 KiB. `inspection_too_large` reports `section_bytes`
and `guide_bytes`; narrow the selection or the guides' `properties`.

### Other documents

```js
const page = await blockwork.read({ source: { post_id: 42, post_type: "page" } });
const faq = await blockwork.read({
  source: { post_id: 42, post_type: "page" },
  blocks: { client_id: page.blocks[4].client_id, depth: 3, markup: true },
});
await blockwork.edit({ edits: [{ op: "insert", markup: faq.markup }] });
```

`source` reads another saved post, page, or shared entity on the same site
through this editor's registrations, with any `blocks` selection. Find IDs with
[`discover`](documents.md#discover-and-create-documents). The result adds
`source` `{post_id, post_type, title, status, link}`. Its client IDs stay valid
for later source reads while that document's saved content is unchanged, but
never select blocks in this editor. It cannot be combined with guides. A missing
document returns `source_not_found`. A lock attribute at its registered default,
such as an Accordion panel's `templateLock: false`, is dropped from inserted
blocks; other lock values refuse.

## measure

```js
await blockwork.measure({ blocks: [clientId], width: "mobile", properties: ["margin-bottom", "gap"] });
```

`blocks` takes 1 to 20 client IDs, or `client_id` takes one; `properties` takes up to 32 CSS property
names, including custom properties. Defaults are font family, size, weight, line
height, color, background color, padding, and margin. `width` takes one value
from [widths](#widths) and adds `width`, `canvas_width`, and `width_source` to
the result; the editor and Blockwork's own tab are restored before it returns.
Without `width`, measure reads the canvas as it is, and so does `edit`'s
`measure`; `viewport.width` says how wide that was.

Each block reports `rendered` and `elements` for its wrapper and its first
button link, image, and text descendant, each with `tag`, a viewport-relative
`rect`, and `styles`. A hidden block, such as a closed accordion panel or one
hidden at that width, has no box and reports `rendered: false` without elements;
check its open state on the saved page. `viewport` gives the canvas size.
`fonts` reports the canvas `status`, `failed` faces (family, weight, style), and
how many are still `loading`; a failed face explains wrong typography before any
restyling. Measure never scrolls, selects, or edits; a blank canvas is reloaded
first, as described under [view](#view). Bounds do not prove visibility through
clipping or overlap.

## view

```js
const view = await blockwork.view({ client_id: "…", widths: ["desktop", "mobile"] });
for (const shot of view.shots) if (shot.image) await nodeRepl.emitImage(shot.image);
```

`view` shows one block in the editor canvas at each of one to six distinct
[widths](#widths), default `["desktop"]`, without reloading. The block is
scrolled to the top of the canvas and into view in any scrolling row around it,
such as a card row; images and fonts get up to 3 seconds to load, and the
visible part is captured through the tab's `cdp` capability. A block taller than
the canvas comes back in up to four slices per width; `incomplete` lists widths
whose slices ran out, with a `hint` to view the block's children for the rest or
check the saved page with `capture_page`.

Each shot has `width`, `rendered`, `canvas_width`, and `width_source`. A
rendered shot adds `image` (JPEG bytes at CSS-pixel size), `image_size`,
`clipped` (a container in the canvas, or the canvas's sides, hide part of the
block from every slice; slices start at the first part a container shows),
`from` and `to` (canvas pixels within the block), and `block_height`.
`rendered: false` means the block still had no box at that width after a
second's wait for layout, for example when hidden on mobile. `block_clipped` means a container hides it, such as a carousel
slide outside its track; view the container instead. Editor chrome such as block
appenders, placeholder outlines, and a user's block toolbar can appear in the
images. In a user's pinch-zoomed editor, `view` refuses with `tab_zoomed`,
because the capture would reset the zoom; use `measure` or ask the user to zoom
back out.

The in-app browser can leave the editor canvas blank. `view` and `measure` then
reload Gutenberg's own canvas document, as edits do, and wait up to 5 seconds
for the block to render. `native_render_unavailable` means the canvas still did
not render; check the saved page on the front end instead. An attached editor
in Code Mode has no canvas, so both refuse with `editor_code_mode`; see
[active editors](active-editors.md#connect-and-read).

The editor's device and scroll positions, and the size of Blockwork's own tab,
are restored before `view` returns; other calls on the same caller refuse with
`host_operation_in_progress` until then. A view interrupted by a host failure is
restored by the next operation. `tab_resize` beside a result means the tab's
size could not be reset; the result stands, and the next call tries the reset
again first. In a user's editor they see it switch previews for a moment.

### Widths

| Width | Background tab | User's editor (attached) |
| --- | --- | --- |
| `"desktop"` | Exactly 1440 pixels (`exact`) | Their own Desktop canvas, as wide as it is (`user_editor`) |
| `"tablet"`, `"mobile"` | Gutenberg's preview at the site's breakpoint less 1 pixel, 781 and 479 by default (`preset`) | The same, or `width_unavailable` when their window is too narrow for it |
| 320 to 2560 | Exactly that many pixels (`exact`) | `width_requires_background` |

In a background tab, Blockwork resizes its own tab's window, which the user
never sees. Below a 782-pixel window wp-admin switches to a small-screen layout
that covers the canvas, so a width the editor's sidebars would push below that
refuses with `width_unavailable`; check phone widths on the front end. A
`user_editor` shot shows the draft as the user sees it, not a 1440-pixel layout,
so read `canvas_width` before calling a layout broken. If the user dragged their
canvas to a width of their own, or zoomed out, any width that would change it
refuses with `custom_canvas_width`, because Gutenberg cannot set that width
again.

Attributes with source: "meta" are not directly editable block attributes. The
attribute guide exposes their registered meta_key when present. Read with
settings: true to discover the writable REST meta contract, then edit
settings.meta with only user-supplied keys. Preserve the whole-meta guard. A
registered block meta key absent from the settings guide is not writable.
