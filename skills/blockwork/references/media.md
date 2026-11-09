# Inspect and copy media

For site targets and resource-tab setup, read
[site targets](documents.md#site-targets).

## Inspect media and attach it to blocks

Call `inspect_media` with `target: {site_url, user_id?}`. The result includes
the resolved `target` and `user`. A supplied `user_id` must match the signed-in
user. Reads may reuse the page's cached identity.

`inspect_media` takes `id` for one attachment, `ids` for up to 50, `slugs` for
up to 50 exact native slugs, or `search`, `page`, and `limit` for a list, with
optional `media_type` (`image`, `video`, `audio`, `application`, or `text`).
Send at most one of `id`, `ids`, and `slugs`. `ids` and `slugs` each make one
request and return `{ok, records, missing}`: full records like `id` returns, and
the requested IDs or slugs WordPress did not return. `search` matches titles and
text, not file names; to find an existing copy of a file, look up its likely
slug, such as `hero-photo` for `hero-photo.jpg`, and compare each record's
`source_url` file name. List records are compact: `id`, `title.raw`, `alt_text`,
`media_type`, `mime_type`, `source_url`, `width`, `height`, `sizes` (each named
size as `"WIDTHxHEIGHT"`), and `edit_token`. Inspect one `id` for a compact
editable `record`: `id`, `edit_token`, `title.raw`, `caption.raw`,
`description.raw`, `slug`, native parent `post`, `alt_text`, `source_url`,
`media_type`, `mime_type`, and native `link` and `type` when present.
`media_details` contains `width`, `height`, and `sizes`, with each named size's
`source_url`, `width`, and `height`. Dimensions can be absent for nonimages.
`save_resource` and `verify_resource` return the same compact attachment shape.
Rendered HTML, plugin metadata, image metadata, class lists, GUIDs, and per-size
file details are omitted. The `edit_token` still hashes the full native record,
so changes to omitted metadata invalidate it.

For a core Image, set `id`, `url` (`source_url`, or a size's URL with a matching
`sizeSlug`), and `alt` directly with `update` or in an inserted tree. Media
bindings do the same with a currentness check: carry the attachment's
`edit_token` as `media_token`.

```json
{
  "media_bindings": [{
    "path": [1], "name": "core/image", "media_id": 87,
    "media_token": "COPY_MEDIA_EDIT_TOKEN", "size": "full",
    "bind": { "id": "id", "url": "url", "alt": "alt", "size_slug": "sizeSlug" }
  }]
}
```

Bindings become `update` edits after the explicit `edits` array, so paths refer
to its resulting tree, and the combined limit is 32 edits. Images support `id`,
`url`, `alt`, and `size_slug`; other attachment types support `id` and `url` at
`size: "full"`, such as a File block's registered `href`. Named sizes must
exist, destination attributes must be unique and match the block schema, and
nested attributes are not addressable; use an inspected value in a complete
object update instead.

For a new Video or default File variation, put insertion and media binding in
the same edit request before saving. Video maps `id` to `id` and `url` to `src`.
The File `default` variation maps `id` to `id` and `url` to `href`. Supply its
intended `fileName` text and set `textLinkHref` to the inspected source URL. This keeps
the native Video controls and File download text through save and reopen.
Native saving and reopening a blank placeholder loses those values. Binding
afterward does not restore them. Supply any intended controls or download text
explicitly alongside the source binding when editing an already reopened block.

## Bind a fresh Gallery Image

For an existing Gallery with a fresh, unlinked direct Image child, supply the
complete final parent and Image attributes with one media binding. The Gallery's
`sizeSlug` must match the binding's `size`. Set `linkTo: "none"` on the Gallery
and `linkDestination: "none"` on the Image. Choose a nonempty caption explicitly;
retain an existing caption when the task does not request a change.

This example binds the first Image in the second root. Inspect the live Gallery,
Image attributes and media first, then use their current paths and media token.

```json
{
  "edits": [
    {
      "op": "update", "path": [1], "name": "core/gallery",
      "attributes": { "sizeSlug": "full", "linkTo": "none" }
    },
    {
      "op": "update", "path": [1, 0], "name": "core/image",
      "attributes": {
        "caption": "Chosen caption", "sizeSlug": "full", "linkDestination": "none"
      }
    }
  ],
  "media_bindings": [{
    "path": [1, 0], "name": "core/image", "media_id": 87,
    "media_token": "COPY_MEDIA_EDIT_TOKEN", "size": "full",
    "bind": { "id": "id", "url": "url", "alt": "alt", "size_slug": "sizeSlug" }
  }]
}
```

If the inspected fresh Image has values that Gallery would reset, declare those
resets in the Image update's `unset`, such as `["align"]`. Keep caption, link,
class and other choices explicit. Blockwork refuses a plan whose final registered
attributes would be changed by native Gallery preparation. It never silently
normalizes them. The complete request applies all attribute patches together
with one native action and checks the whole document immediately and after
settling. Unrelated Images retain their IDs, order, captions, links and attributes.

Gallery also keeps unregistered Image `fullUrl` and `link` UI values. Blockwork
resolves its public attachment query, checks it against the token-checked media
record, and supplies those values internally. Do not send them as raw Image
attributes. `fullUrl` comes only from an available full-size entry. A saved-state
comparison may omit these exact unregistered UI values only after native
serialization proves that removing each value and both together, or restoring
them on parsed copies, leaves the whole document's bytes unchanged. Live state
checks remain exact. Registered versions follow ordinary schema validation.

Images with native saved content retain ordinary strict media binding. The fresh-Image
path accepts one binding and attribute updates only. Insert a
Gallery or fresh Image in a separate edit first. Fresh linked target Images,
structural edits in the same call, settings, and implicit parent-size changes
remain unsupported. A Gallery at `sizeSlug: "large"` with a `size: "full"`
binding alone returns `gallery_companion_required` before dispatch. Read the
Gallery and use the complete call above. Do not repeat a partial or uncertain
mutation; inspect its result and follow the reported recovery step. Media tokens
remain save-time currentness guards while their bound block retains the bound
identity. Moving or styling that block retains the guard. Removing, replacing or
retargeting it retires that owner only; a separate featured-media setting keeps
its own guard. Reverting restores the previous owners.

## Copy a document to another site

Moving a page between sites, such as staging to live, uses one caller per site,
each in its own owned tab. Keep markup and records in REPL variables and print
only counts and IDs.

1. Source: connect, then read each root with
   `{client_id, depth: 0, markup: true, media: true}` and keep its `markup` and
   `media`. `media` lists `{id, url, paths}` for each attribute object that
   pairs an attachment ID with an uploads URL, and every place it occurs: the
   block `path`, block `name`, and `attribute`. It misses files referenced by
   URL alone, such as a Video's `poster` or caption tracks. Synced patterns and
   template parts are separate entities and are not included. Read
   `settings: true` for the title, excerpt, template, and meta.
2. Inspect the listed IDs with `inspect_media({ids})`, at most 50 per call, for
   their files, size URLs, and text fields. Skip a section with no IDs.
3. Target: `discover` with `target: {site_url}` for the target user. Look up
   existing copies with `inspect_media({slugs})` from the source records' slugs,
   at most 50 per call, and reuse a record only when its `source_url` file name
   matches. For the remaining files, use
   [`target.copy_media`](#copy-attachments-in-bounded-batches) and repeat the
   same request until `complete` is true. Keep its upload receipts.
4. Build one `media_map` for the copy. `ids` maps each source attachment ID, as
   a string key, to the target's; it is optional and holds up to 500. `urls`
   maps each source `source_url` and size URL to the target's same size, or its
   full URL when that size is missing; it holds 1 to 2,000 absolute http or
   https URLs of up to 2,048 characters. Omit `media_map` for a section that
   uses no source files.
5. `create` the target document or connect to it, and insert one section per
   `edit` with the source markup as read. Blockwork rewrites the parsed blocks
   and Gutenberg writes the markup, so an Image's `src` and `wp-image` class
   follow its new ID. An attribute changes only when its whole value is a map
   key, and only a `wp-image-N` token in a `className` follows `ids`. An `id` or
   `<prefix>Id` changes only beside a URL the map moves, so a link's post ID
   stays. If the blocks still use an upload URL on a source host, one that
   appears among the map's keys but not its values, the edit refuses with
   `unmapped_media_url`, naming each block's path within the inserted blocks and
   its attribute. For a whole-value URL, resolve that file as in step 3, add it
   to the map, and send the same edit again. A URL inside text, such as an
   inline image in a paragraph, never changes; change it in the section's markup
   first. Save a draft after the first section. Copy only settings and meta keys
   whose values differ from the target's, then check and save as usual.

```js
await target.edit({ edits: [{
  op: "insert",
  markup: section.markup,
  media_map: {
    ids: { "12": 34 },
    urls: { "https://staging.example/wp-content/uploads/photo.jpg": "https://example.com/wp-content/uploads/photo.jpg" },
  },
}] });
```

## Copy sections between sites

Connect a caller to the destination document and retain the source section's
`markup`. Copy its attachments with `copy_media` until `complete` is true, then
resolve its page links on the destination. Nothing is looked up on the source
site by `map_links`.

```js
const copied = await target.copy_media(copyRequest); // repeat unchanged until complete
if (!copied.ok || !copied.complete) throw new Error(JSON.stringify(copied));
const mapped = await target.call({
  operation: "map_links",
  markup: section.markup,
  source_site_url: "https://source.example.test/local",
  overrides: [{
    source_url: "https://source.example.test/local/old-slug/",
    target_url: "https://destination.example.test/new-slug/",
  }],
});
if (!mapped.ok) throw new Error(JSON.stringify(mapped));
const edited = await target.edit({ edits: [{
  op: "replace", client_id: destinationSection.client_id,
  markup: section.markup, media_map: copied.media_map, link_map: mapped.link_map,
}] });
if (!edited.ok) throw new Error(JSON.stringify(edited));
await target.save(); // attached editors require explicit whole-pending-document save intent
```

For a section without attachments, skip `copy_media` and omit `media_map`.
`replace` requires exactly one root. Inspect the result with `view`, save through
the usual [save workflow](saving.md), then use `capture_page` to check the saved
front end and its links.

`call({operation: "map_links", markup, source_site_url, overrides?})` uses the
connected document target. For a raw call, supply the full document `target`
`{site_url, user_id, post_id, post_type}` too. No currentness token is needed.
`source_site_url` is an absolute http or https installation URL, including its
install path, without credentials, query, or fragment. `markup` has the same
256 KiB limit as inserts. Optional `overrides` contains up to 50
`{source_url, target_url}` entries with distinct source URLs. All URLs have a
2,048-character limit.

The native parser collects up to 50 distinct absolute source links from `url`
and `href` attributes and anchor `href` values inside string attributes. It
ignores relative links, other sites, and uploads under `/uploads/`, including
`/wp-content/uploads/`. Arbitrary custom source upload paths cannot be
discovered without source access. Handle those files explicitly before mapping.
The installation root maps to the destination root. Other candidates retain
the path relative to the installation, query, and fragment. Destination
viewable post types use their native REST routes, excluding attachments.
Only a unique published post with an exact matching permalink is accepted.
Titles and source IDs are never used. Overrides are accepted as given and may
point to archives or external URLs; they supply no destination post ID.

Success returns `{ok: true, operation: "map_links", persistence:
"not_attempted", link_map, links}`. `links` contains `{source_url, target_url,
post_type, post_id}`; root and override records use null for type and ID.
`link_map` contains `source_site_url`, `urls` mapping source URLs to target URLs,
and `ids` mapping source URLs to destination post IDs. Keep the complete map,
including `source_site_url` when `urls` is empty.

`insert` and `replace` accept `link_map` beside `media_map`, for both markup and
block trees. Whole-value strings change only when they equal a map key.
Anchors change only matching `href` values, comparing decoded `&amp;` and
escaping the replacement. Navigation Link and Navigation Submenu blocks set
their `id` from `ids` when their `url` moves, clearing the source ID when no
destination ID is supplied. Other post IDs remain unchanged. No origin-wide
replacement runs, and links are not rechecked at save time.

`link_resolution_incomplete` refuses the entire map. `diagnostics.links` lists
up to 10 source URLs with `missing`, `ambiguous`, or `candidate_limit` reasons,
and `truncated` reports more. `candidate_limit` means a type returned a full
100-post slug window, so uniqueness was not proven. Publish the destination
page or pass explicit overrides, then call again. `unmapped_internal_link`
refuses an edit before mutation if an unmatched absolute source link remains
in attributes. Mapped destination URLs may share the source origin or install
path. `diagnostics.references` lists up to 10 block paths, names, and
attributes, with `truncated` for more; `diagnostics.field` is
`edits.N.link_map`. Resolve the missing map entries or explicitly change source
URLs in non-anchor text before editing. Uploads remain `media_map`'s concern.

## Copy attachments in bounded batches

`target.copy_media(request)` copies authorized attachments between packaged
callers from the same `bootstrap.mjs` import. Discover both site targets first.
Use owned admin tabs. Run one sequential copy at a time per target, including
across separate callers or processes. The helper never saves a document.

```js
const copied = await target.copy_media({
  source,
  source_target: { site_url: "https://source.example", user_id: 5 },
  target: { site_url: "https://target.example", user_id: 3 },
  ids: [101, 102],
  copy_id: "service-page-images",
  deadline_ms: 55000,
  parent_id: 0,
});
nodeRepl.write({ ok: copied.ok, complete: copied.complete,
  remaining: copied.remaining, error: copied.error, hint: copied.hint });
```

Required fields are `source`, a caller; `source_target` and `target`, each
containing only the exact http or https `site_url` and positive integer
`user_id`; `ids`, 1 to 50 distinct positive attachment IDs; and `copy_id`, 1 to
80 lowercase letters, digits, underscores, or hyphens, starting with a letter or
digit. Optional `deadline_ms` is an integer from 45000 to 55000, default 55000.
Optional `parent_id` is a nonnegative target post ID, default 0. There are no
field overrides or reuse guesses. Downloads run in the signed-in source tab,
using its certificate trust, cookies, and browser authentication. Attachment URLs
must stay on that tab's origin without URL credentials or redirects, containing
1 byte to 5 MiB. Use explicit byte uploads for CDN URLs. Raw title, alt, caption,
and description follow the source; the source parent ID never does.

Each item uses `bw-<copy hash>-<source ID>`, where the hash binds `copy_id`,
both site/user targets, and `parent_id`. Repeat those fields unchanged. `ids`
may be split into smaller batches. Exact-slug lookup finds completed copies.
Previously verified receipts are remembered by the caller; other receipts
require `verify_resource` before mapping, even when the slug is absent.
Recreated callers verify those receipts once. Only a live native preparation
that explicitly reports `attempted: false` may proceed directly to its first
save. Otherwise an absent slug never permits another upload: an aborted request
may still be running in PHP before attachment insertion. Keep the normal receipt
directory across caller recreation. No copy checkpoint, digest envelope, or disk
lock is created. If WordPress suffixes a slug, retain the different result and
attachment ID, inspect it, and never upload that item again. A slug can collide
with another post type even when no media record matches it.

A busy caller or page returns `ok: true`, `complete: false`, and
`next: "wait_for_media_copy"` without starting copy work. Otherwise the batch
leaves two seconds before its requested deadline and starts another step while
at least three seconds remain. Downloads have a 12-second timeout capped by that
deadline. Browser observation uses the smaller of its ordinary 45-second limit
and the batch deadline; an upload may continue afterward. It is never cancelled
or replayed. Use a 60000 ms enclosing REPL timeout. For explicit byte uploads,
send one `save_resource` per `js` call; several uploads in one call can pass the
host's 60-second limit and reset the kernel. `verification_deferred`
resumes through `verify_resource` on the next call.

Results contain `ok`, `operation: "copy_media"`, `copy_id`, `complete`,
`persistence`, `media_map`, `remaining`, `items`, `timings`, `elapsed_ms`,
`next`, and `hint`. A deadline pause is successful but incomplete. Each item has
`source_id`, `state`, and per-call `timings`; when known it also has its
ordinary `receipt`, target `resource_id`, and latest target operation `result`.
Failed source downloads retain their error and repair hint in `result`; downloaded
base64 never appears in the copy result or receipts.
States are `pending`, `prepared`, `attempted`, `verified`, and
`upload_bytes_different`. The last state means requested fields matched but the
stored bytes differ. The item is mapped and the copy can complete; inspect the
image if needed and do not upload it again. Its result retains the native
verification outcome. Root `timings`
includes shared `lookup_ms` and `inspect_ms` for bulk reads. Per-item timings
include `fetch_ms`, `prepare_ms`, `save_ms`, and `verify_ms` for stages that
ran. Fetch includes base64 encoding; save includes processing and its native
verification. Keep results in memory and print counts and IDs.

The map contains verified uploads, uploads with different stored bytes and matching
fields, or existing exact-slug copies. Size URLs
map to the target's same size, falling back to its full URL. It obeys `edit`'s
2000-URL limit. Aggregate persistence is `verified` when complete with verified
bytes, `partial` for
a partly mapped batch, `uncertain` for unresolved attempts or busy work, and
`not_attempted` when no write was attempted or observed. A mapped item with
different stored bytes keeps aggregate persistence `uncertain`. Failures retain the
native write persistence when supplied, including `different`. Source download
failures preserve earlier verified items. Read `error`, `hint`,
`diagnostics.stage`, and the item's `result` for repair. Validation failures
include `issues` with field paths and expected constraints. Never change
`copy_id` or discard receipts to bypass an unresolved result.

`call({operation: "download_media", target: {site_url, user_id}, id, timeout_ms?})`
reads one positive attachment `id` through REST and downloads that record's own
`source_url` in the source tab. It accepts no URL or currentness token and writes
nothing. Optional `timeout_ms` is 1 to 12000 milliseconds, default 12000. Identity
and attachment reads consume that budget before the download starts, and the page's
remaining budget also caps it. Success returns `{ok: true, upload: {name,
mime_type, base64}}`, ready for `prepare_media`. Only this download response may
exceed the ordinary resource response limit, up to the base64 encoding of 5 MiB
plus bounded metadata. Keep it in memory. Failure returns an authored `hint`
for authorization, source URL, unavailable response, timeout, size, or empty-file
conditions. Confirm the file loads in the source tab or follow the named repair,
then resume the same `copy_id`; no upload was sent for this download.

`call({operation: "resource_status", target})` reads only local page state. It
returns `ok`, `busy`, `attempted`, `verified`, and optional `receipt` and
`resource_id`. It checks the page origin and any existing session target, makes
no REST requests, acquires no session, and leaves a running operation's budget
unchanged. It observes resource and editor activity, including after caller
recreation. It does not freshly authenticate the user; subsequent resource reads
and writes keep their normal identity checks.
