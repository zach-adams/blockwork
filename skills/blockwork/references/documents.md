# Documents and settings

For caller setup, read [invocation](invocation.md); before editing, read
[edit](edit.md); before saving, read [saving](saving.md). Resource and
shared-entity operations go through `blockwork.call(request)` with the site's
native `wp.apiFetch`. Their writes keep a prepare, receipt, save, and verify
sequence because they persist on their own. Plugin abilities are the exception;
see [run site abilities](shared-and-abilities.md#run-site-abilities).

## Site targets

Resource operations take a site target without a post identity:

```json
{"operation":"discover","target":{"site_url":"https://example.com","user_id":5}}
```

`user_id` is the signed-in user's ID. Before a caller is connected, learn it
with `discover` and `target: {site_url}` alone; its result returns the complete
`target` to use for the other operations. Never read it from the page or CDP. A
wrong `user_id` fails with `user_mismatch`, whose
`diagnostics.signed_in_user_id` names the tab's user. Reads reuse the site and
user that tab last verified; `save_resource` and `verify_resource` confirm them
again before they write or settle anything.

After `connect`, the caller fills in the connected site and user when `target`
is omitted, so `blockwork.call({operation: "inspect_media", search: "hero"})`
works in the editor tab. Without a connected caller, run them in an owned
wp-admin tab where `wp.apiFetch` is available, such as
`SITE/wp-admin/upload.php`, with the exact installation and signed-in user. Do
not open a post editor just for resource work. An owned editor keeps its normal
cleanup obligations. If the document is still loading, Blockwork waits up to 2
seconds for `wp.apiFetch`; a fully loaded page without it fails immediately with
`native_api_unavailable`. Let native loading finish and retry the read or
preparation in the same resource tab. Preserve any unresolved receipt and use
`verify_resource` when the API becomes available.

## Discover and create documents

For an authorized creation, bind a new caller to a fresh owned wp-admin tab
where `wp.apiFetch` is available, such as `SITE/wp-admin/upload.php`. Check the
tab inventory first and leave the user's tabs alone. Create and connect in one
caller method:

```js
const doc = await blockwork.create({
  target: { site_url: "https://example.com", user_id: 5 },
  post_type: "page",
});
```

These are the complete required keys. `site_url` is the exact WordPress
installation URL, `user_id` is the signed-in user's positive integer ID, and
`post_type` is a REST-visible type with editor support. There are no workflow,
content, title, or timeout options. The caller discovers the type's native
`new_editor_url`, navigates only its bound tab, waits up to 10 seconds for a
positive post ID and that exact type, then connects with
`workflow: "background"`. It refuses callers that already have a document,
release, or unresolved operation. Once navigation is attempted, this caller
refuses further `create` calls even if creation fails. `connect` remains
available to recover the first document. It creates a native auto-draft without
clicking Save draft or calling save.

Success returns the complete `connect` result, including `ok`, authenticated
`target` with `user_id`, `user`, `workflow`, `editor_instance`, `save`, `title`,
`status`, `link`, `dirty`, `blocks`, `selection`, `block_count`, `validity`,
`custom_blocks`, `normalization_required`, `template_fills` when present, and
`unsaved_preview`. It also
returns `document: {site_url, post_id, post_type}`, the new document identity.
The caller is connected, so use `read`, `edit`, `save`, and `release` directly.
`create` never sets publication status. WordPress blanks an auto-draft's loaded
title while it stores a placeholder, so `connect` does not compare an
auto-draft's title. When a post type registers a block template, Gutenberg
inserts its blocks into the new post as the editor loads. `connect` admits
content that exactly matches that native insertion; the template blocks stay
unsaved until the first save writes them. The template's lock still applies, so
a `template_lock` of `all` refuses inserted blocks. Other saved-field
differences and pending edits still refuse.

WordPress generates a slug when a draft with none stops being a draft, and that save
still verifies. Before the first save, set `post` with a nonempty `title`, an explicit `slug`,
and a `status` of `draft` or `publish`. Slugs must be lowercase ASCII words
separated by hyphens. Creation refuses an existing same-type slug when the edit
is planned and again before saving, but cannot stop another tab from claiming
that slug concurrently. WordPress gives a post with no category the site's
default one, so set `settings.taxonomies.category` when the user named a
category; otherwise the save returns `applied_with_differences` naming
`categories`. Of the document settings, only a page `template` change
affects editor policy, so the same tab can add structure before saving. With new
content, save a draft with it, then publish through a final status-only edit and
save if authorized. Do not publish an empty intermediate document. Release and
close the owned tab when finished.

Save a draft once the first structure is in place. A draft save publishes
nothing, and unsaved editor work is lost if the turn is interrupted or the
browser session resets.

Every failure has `error`, `hint`, and `next`. Handle them as follows:

- `invalid_create` or `invalid_resource_request`: correct the field path and
  expected type in `issues` before calling again. Native discovery validates the
  site target and post type before navigation.
- `host_operation_in_progress`: wait for this caller's operation to return.
- `create_requires_owned_tab`: finish the existing document's release or
  recovery, preserve it, and bind a new caller in a fresh owned admin tab.
- `create_already_attempted`: inspect the owned tab for the document already
  created, record its identity, and `connect` with `workflow: "background"`.
  This refusal starts no operation and never navigates again.
- `unsupported_post_type`: choose a name from `discover.types`. No navigation or
  creation occurred.
- A discovery failure returns its original operation and guidance. Follow `hint`
  and `next`; creation has not navigated yet.
- `reauthorization_required`: ask the user to sign in in this tab. If creation
  already navigated, inspect the tab for a document before deciding what to do.
- `create_editor_timeout` or `create_browser_failed`: navigation may have
  created an auto-draft. Keep the tab, inspect its identity after native loading
  finishes, and connect to that identity with `workflow: "background"`.
  `operation_started` reports whether navigation was attempted; timeout
  diagnostics give `stage: "new_editor"` and `waited_ms: 10000`. Do not repeat
  `create`, click Save draft, or silently create another document.
- A connect refusal returns its original guidance plus `document`. Record that
  ID and follow the refusal's recovery instructions for that same document.
  `saved_record_changed` includes `diagnostics.fields`, up to 20 names with
  `meta.<key>` detail and no values. The difference does not establish a cause.
  Never reload a user's editor; only the user decides whether to reload it.
  `editor_not_clean`, with `next: "report_pending_changes"`, means the new
  editor loaded unsaved changes. Its `diagnostics.fields` names pending settings,
  and `diagnostics.content_changed` reports content other than the saved record
  and the type's own template. Changes made on load may appear again in another
  background editor, so do not retry one. Tell the user; if they want the
  changes kept, connect to this tab with `workflow: "attached"`, whose save
  needs `save_all_pending: true`.

A lost creation response also requires inspecting the owned tab before another
creation. A lost save requires the stored receipt and `recover`, never replay.

To discover existing documents or types directly, use `blockwork.call`:

```js
await blockwork.call({
  operation: "discover",
  target: { site_url: "https://example.com", user_id: 5 },
});
await blockwork.call({
  operation: "discover",
  target: { site_url: "https://example.com", user_id: 5 },
  post_type: "page", search: "Contact", page: 1, limit: 20,
});
await blockwork.call({
  operation: "discover",
  target: { site_url: "https://example.com" },
  url: "https://example.com/about/team/",
});
```

`target` may omit `user_id`. Without `post_type`, the result is
`{ok: true, target, user, types}`. `types` is an array, not `types.post_types`;
each item has `name`, `collection`, and `new_editor_url`. With `post_type`, the
result is
`{ok: true, target, user, records, page, may_have_more, new_editor_url}`. Each
record has `id`, `type`, `status`, `title` with native `raw` and `rendered`
fields, `slug`, and `link`. `search` defaults to an empty string, `page` to 1,
and `limit` to 20 with a maximum of 50. `may_have_more` means the returned count
equals the limit, so another page may exist.

With `url`, an absolute front-end address, the result is
`{ok: true, target, user, record, editor_url}`. `record` is the one document
the signed-in user can edit whose permalink is that address, ignoring a
trailing slash, query, and fragment, with the same fields as above. An address
whose query has `page_id` or `p`, such as a plain permalink, a shortlink, or a
draft's preview link, resolves by that ID instead. `editor_url` is its editor,
to open before `connect`. The site's home address resolves to its static front
page. `post_type` limits the lookup to one type; `search`, `page`, and `limit`
don't apply. An address outside the site's home URL refuses with
`url_outside_site`. When no single document matches, `document_not_found`
gives `diagnostics.reason`: `missing`, `ambiguous`, or `no_front_page` for a
home address that shows the latest posts or carries another query, such as a
search.

Custom types and REST namespaces
come from the site. Shared entities use their own discovery below. Attachments,
revisions, and menu items are excluded from document editing.

## Document properties and settings

Add `settings: true` to `read` for the writable field schemas, current values,
and attached REST taxonomies; it can be large. They arrive under `settings`,
where `fields` and `values` are objects keyed by field name:

```js
const { settings } = await blockwork.read({ settings: true });
settings.fields.title; // one field's REST schema
settings.fields.meta.properties.my_key; // one registered meta key's schema
settings.values.meta.my_key; // that key's current value
settings.taxonomies; // attached REST taxonomies
```

`edit` accepts these beside `edits`, and a settings-only edit may omit `edits`:

| Request | Supported fields |
| --- | --- |
| `post` | `title`, `excerpt`, `slug`, `status`, `template`, `parent_id`, `menu_order`, `date_gmt` |
| `settings` | `featured_media`, `meta`, `taxonomies` |
| `binding_writes` | Up to 32 existing block paths, block names, bound attributes, and values |
| `media_bindings` | Inspected attachments mapped to flat registered block attributes |

Keep the status unless the user asked to change it. Allowed requested statuses
are `draft`, `publish`, `private`, `pending`, and `future`. Scheduling requires
`status: "future"` and a future UTC `date_gmt` such as `2099-01-01T12:00:00`.
Explicit GMT dates are verified exactly; automatic dates are excluded when no
date was requested. A status request does not override WordPress permissions.
Trashing or deleting documents and changing post type are not supported.
Assigning a post template does not edit that shared template.

`featured_media` takes `0` to clear or `{ "id": 87, "media_token": "..." }` from
`inspect_media`. `meta` uses registered REST names and schemas; only supplied
keys change. `taxonomies` maps taxonomy slugs to complete term ID arrays, such
as `{ "category": [4, 9] }`; an empty array clears the assignment, and lists are
never additions. Each taxonomy's route, post types, and terms are checked again
before saving. Parents must stay in the same type without cycles.

Ordinary metadata edits return only their requested keys in `settings.meta`.
They preserve other pending keys without authorizing their save. A change to a
different meta key does not block the edit. Reading settings observes those
values but does not authorize saving them. After a read, explicitly send each
pending key to keep through `settings.meta`, even when its value is unchanged.
Authorization accumulates across edits. Paired Footnote edits still write the
complete metadata object, but authorize only their requested Footnote key.

Settings require a valid, fully supported document. An unknown field, a stale
reference, or a setting someone else changed refuses. A page `template` change
can change server-side allowed-block rules, which Gutenberg loads only when the
editor opens: while it is unsaved, structural edits refuse with
`settings_before_structure`, and after saving, with `reopen_required` until the
editor is reopened. Make structural edits before a template change when you can.
Other settings, such as featured image, terms, parent, and meta, never block
structural edits. Saving rechecks the field schema when settings are pending and
verifies every exposed editable field and the block tree.

### Existing post-meta bindings

```js
await blockwork.edit({
  binding_writes: [{ path: [0], name: "core/paragraph", attribute: "content", value: "Requested field value" }],
});
```

Read the block's `metadata.bindings` first. This writes the backing REST meta
field of an existing exact `core/post-meta` binding and keeps the block's
fallback markup and binding declaration. The key must be public and present
under the same name in the writable REST meta schema, the source must allow
editing, and Gutenberg must support the bound attribute. Ancestors that provide
another post or query context, and conflicting direct meta writes, refuse. Paths
address the current tree. Aliased keys, private ACF fields, custom sources, and
changing binding definitions are unsupported; this browser-level check cannot
prove PHP-side registration, filters, or key mapping. Do not present a bound
fallback attribute as its writable value.
