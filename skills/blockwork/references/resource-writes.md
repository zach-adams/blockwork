# Prepare, save, and recover resources

For site targets and resource-tab setup, read
[site targets](documents.md#site-targets).

## Prepare media and term changes

Preparation reads native REST schemas and current state but does not write. The
caller stores its complete `receipt` before `save_resource`. Receipts can
contain requested nonpublic text or metadata; keep them private and out of
plugin exports. Resource writes are separate from document saves; no transaction
spans an upload, a term change, and a post edit.

For media metadata, call `prepare_media` with `id`, its `edit_token`, and
`fields`: `title`, `alt`, `caption`, `description`, `parent_id`, and `slug`.
`parent_id: 0` detaches the media from its parent post but does not remove its
uses in block content. Image replacement and media deletion are unsupported.

For an upload, omit `id` and provide `upload` with `name`, `mime_type`, and
`base64`, plus `fields` with a unique explicit `slug`. Read only the
user-authorized source file through host file access and base64-encode it in
host memory; never print or embed the bytes in the conversation. The operation
sends one native multipart upload with the metadata. Decoded files are limited
to 5 MiB, a stopgap for the observed in-app browser transport failures. The
caller refuses oversized payloads before sending a browser command, with
`upload_too_large`, `operation_started: false`, and `next: "correct_request"`.
Resize or recompress an oversized image before preparing again. WordPress's
upload capabilities, MIME rules, site limits, and processing still apply. There
is no remote-URL importer or filesystem scanner.

Call `inspect_terms` with `target: {site_url, user_id?}`. The result includes
the resolved `target` and `user`. A supplied `user_id` must match the signed-in
user. Reads may reuse the page's cached identity.

`inspect_terms` without `taxonomy` lists REST taxonomies. With a taxonomy slug
it takes `id` for a record, or `search`, `page`, and `limit` for a list, with an
optional `parent_id` filter for hierarchical taxonomies. Records include
`edit_token`. A single term also reports its native count and, when
hierarchical, its direct children; the count is not a complete inventory of
relationships across all statuses or custom code.

`prepare_term` requires `taxonomy` and `action`:

| Action | Other required input |
| --- | --- |
| `create` | `fields` containing `name` and unique `slug`; no `id` |
| `update` | `id`, current `edit_token`, nonempty changed `fields` |
| `delete` | `id`, current `edit_token`, literal `scope: "all_relationships"`; no fields |

Term fields are `name`, `slug`, `description`, `parent_id`, and registered REST
`meta`; unmentioned metadata stays intact. Parents cannot introduce cycles, and
a parent change after preparation invalidates the save. Deleting permanently
removes the term and all its relationships, and WordPress cannot undo it. Get
authorization for that exact scope: show the inspected impact, say that the
deletion cannot be undone, and follow the host's deletion confirmation rules. A
request to remove a term from one document means changing that document's
assignment, not deleting the term. Direct children block deletion. WordPress
enforces default-term and capability protections on the write.

## Save and recover resources

Call `save_resource` with the same site target and the exact prepared receipt in
the same owned document. It rechecks identity, schema, record currentness, and
references, makes the native write, then rereads the record and compares the
requested fields and the unchanged editable fields. An acknowledged media create
with differing writable fields sends one corrective metadata update to that same
attachment ID, containing only those differing fields, then verifies again. A
stored slug equal to the requested slug followed by a hyphen and a number is
excluded. WordPress made that slug unique, so resending it cannot remove the
suffix. If only that slug differs, no corrective request is sent. The result
still reports `verification_mismatch`, with `slug` in `diagnostics.fields` and
`diagnostics.slug_made_unique: true`. Keep the stored slug or inspect that ID
and prepare an update with a different slug. Other differing fields still get
corrected. It never sends a second upload. Term creation and ordinary updates
have no automatic correction. When a correction ran, `corrective_update`
contains `fields`, the native field names sent, and `acknowledged`, whether
WordPress returned that exact attachment ID. This field also accompanies
failures and same-tab verification of that receipt. A lost correction response
is uncertain; use `verify_resource`, never replay it. Success is `ok: true`,
`persistence: "verified"`, and `resource_id`. Close an owned resource tab after
success; resource-only tabs hold no post locks and need no `release`.

When WordPress accepts the write but too little of the call's time is left to
reread the record and download an upload, `save_resource` returns
`verification_deferred` with `persistence: "uncertain"` and the new
`resource_id` instead of starting a verification that would be cut off. An
upload holds the resource session until WordPress finishes processing the image,
which can delete the attachment if it fails, so `verify_resource` returns
`operation_in_progress` until then; wait and call it again.

If the write throws, times out, returns `verification_deferred`, or returns
`different` or `uncertain`, keep the receipt and any returned resource ID. Do
not replay the write or treat a failed verification as proof that nothing
changed. Once any request settles, run `verify_resource` with that receipt, plus
`resource_id` for a known created record (update and delete receipts already
contain it; creation can look up the unique requested slug). A fresh resource
tab with the same target and receipt is fine for recovery. Verification
authenticates the tab before creating a resource session or adopting its
receipt. A sign-in, API-loading, or authentication failure keeps any existing
session unchanged and returns the supplied receipt with
`persistence: "uncertain"` and `next: "verify_resource_do_not_replay"`. A fresh
tab remains unbound, so a wrong-site verification does not block correct
inspections or preparations for that tab's own site.

After a lost upload response, recovery downloads only the same-origin native
attachment URL or WordPress's preserved original image, bounded by the receipt
size and the 5 MiB limit, and compares its byte length and SHA-256 with the
receipt. A foreign URL, redirect, missing original, different bytes, or
unreadable file leaves persistence uncertain even if metadata matches. It never
uploads again.

When all requested fields match but the file can't be compared, such as an upload
a plugin converted to another format, the error and outcome are
`upload_bytes_unavailable`. Don't upload again. Compare `record.mime_type` with the
upload, inspect `resource_id`, and use that attachment if its preview is right.

When all requested fields match but bytes differ, `upload_bytes_different`
directs you to inspect `resource_id` and compare its preview or dimensions.
The session settles, while persistence remains uncertain.

Outcomes are `matched_desired`, `matched_original`, `different`, `not_found`,
`ambiguous`, and verified `deleted`; uploads can also report
`upload_bytes_different` or `upload_bytes_unavailable`, and API, authentication,
or schema failures report `unavailable`. Differing requested fields return
`verification_mismatch` and `diagnostics.fields`, up to 12 native field names of
at most 160 characters each, without values. This can accompany uncertain upload
bytes; read `persistence` as well as `outcome`. A verified outcome completes the
intended change. Missing or ambiguous creation candidates never permit another
write. Receipts use a content hash to detect changed fields across storage and
reload; it is not a signature. Older random-key receipts cannot use this format;
keep them for manual inspection instead of replaying.

A session permits a fresh preparation after a verified match. It also permits
one after reading the exact acknowledged created resource with `different`
persistence, or the exact update/delete ID with `original` or `different`
persistence. These reads settle the write without claiming the intended change
succeeded. Inspect that ID for a fresh `edit_token`, then prepare only the
intended repair with `id` and `fields`. Never replay the old receipt or upload
again. `next: "inspect_resource"` directs a settled mismatch to this repair.

`verify_do_not_replay` refuses preparation while a write is unresolved. Verify
its stored receipt and known `resource_id` after the in-flight request ends. An
unacknowledged create with differing fields stays blocked, even if a unique slug
candidate exists; a verified desired match can settle it. Missing or ambiguous
candidates, unavailable native reads, and unreadable upload bytes stay blocked,
as do different upload bytes unless every requested field matches
(`upload_bytes_different`). Per-tab guards do not coordinate separate tabs or prevent a server
race between checks and writes, so serialize a site's writes in your workflow.
