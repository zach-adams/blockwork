# Real-editor test results

Each slug below is a `{ todo: 'finding: slug' }` mark in `tests/editing/`, so the case
runs and stays visible until the defect is fixed. Remove the mark and its row with the
fix. [Real-editor tests](editing-tests.md) covers running them. Everything here
reproduced on Playground with WordPress 7.1.2 and Twenty Twenty-Five.

The final complete engine run took 88.2 minutes and executed 1,952 leaf cases,
with 4 additional skipped leaves. It exposed 9 unmarked failures in reverting
temporary edits beside existing content. The correction passed all 9 cases in a
targeted rerun. Two passing REST-route cases had stale finding marks; those marks
were removed and both cases passed again. The full suite was not repeated after
these corrections. There are 13 remaining marked cases across the 8 findings below.

The leaf-name audit accounts for all 1,912 leaves in the previous complete run.
Seven preservation batches contain the same 80 block types in a different order.
Explicit renames cover Navigation replacements and the withdrawn hidden-meta
expectation. Two native-control persistence leaves are now shared group assertions.
The current run has 1,956 leaves, including 46 additional selectable cases, with
no unexplained missing coverage.

## Findings

### A reasonable request is refused

| Slug | What happens | Where |
| --- | --- | --- |
| `native-default-serialization` | Audio and Video with sources work. Blank Video and the default File variation still refuse before a source URL is supplied. | `src/edits.ts` |
| `post-date-roundtrip` | Root and explicit populated Query contexts work. Automatic Post Template children and unresolved or nested preview contexts remain unsupported. | `src/query.ts` |
| `query-requested-values` | Native Query effects replace contradictory `perPage` and `excludeCurrent` values. Preflight refuses before mutation. | `src/edits.ts:1351` |
| `query-inherited-normalization` | Inherited Query updates cannot retain values that native effects replace. Refusal names the properties and native values. | `src/edits.ts:1481` |
| `tabs-label-sync-outside-plan` | Complete rename, addition, removal, and move requests work. Requests omitting companion writes remain unsupported. | `src/edits.ts` |
| `mount-default-change` | An explicit known mount value works. An omitted default cannot authorize an arbitrary mount effect. | `src/edits.ts:1350` |
| `context-move-partial` | A complete leaf move with explicit final derived attributes works. Move-only requests cannot infer custom effects. | `src/edits.ts:1481` |
| `gallery-native-media-coordination` | Complete bindings to fresh unlinked Images work with explicit matching Gallery settings. The original default-size request remains unsupported. | `src/edits.ts` |

## Withdrawn expectations

- `hidden-plugin-meta-erased-verified`: REST does not expose the deleted plugin
  metadata, so verified document persistence cannot establish its preservation.
  The test verifies this visibility limit and preservation of observable fields.

## Visible limits

These findings remain marked and open. Safer refusals do not resolve their
native-supported requests.

- `post-date-roundtrip`: dynamic root insertion, explicit Query templates,
  existing-template insertion, and moves across those contexts pass. Automatic
  empty-template population and nested or unresolved contexts remain unsupported.
  Supply an explicit inspected template tree when it preserves the requested
  intent. The remaining automatic-population case stays marked.
- `native-default-serialization`: refusal improved, request still unsupported
  for blank Video and File placeholders. Native output loses Video's default
  `controls` value and File's download text without a source URL. Inserting with
  an inspected media URL works. Insertion and token-checked media binding in the
  same request also preserve Video controls and File download text through save
  and reopen. Native saving and reopening a blank placeholder loses those values;
  later binding does not restore them.

- `query-requested-values` and `query-inherited-normalization`: refusal improved, request still unsupported when core necessarily replaces supplied `perPage` or `excludeCurrent`. Preflight names the affected paths and native values before mutation. Matching native values is a working route only when it preserves the requested intent. Existing empty-result Query updates now work.

- `tabs-label-sync-outside-plan`: complete supplied rename, add, remove, and move requests pass. Refusal improved, request still unsupported for omitted companion lists. The hint gives the complete request shape. Adding a panel requires an explicit empty Paragraph and the complete final list and active index. Incomplete requests remain marked.

- `gallery-native-media-coordination`: complete bindings to a fresh, unlinked Image
  pass with matching explicit Gallery size and link settings, a chosen caption,
  and the token-checked media binding. Native UI companion fields are planned
  before dispatch and remain exact in live comparisons. The original binding
  asks for full size under a Gallery's default large size. Refusal improved,
  request still unsupported for that conflicting request. Inspect both blocks
  and the attachment, then use the complete call in the media reference only
  when those parent changes preserve the authorized intent.

- `context-move-partial`: a complete move followed by an explicit update of the
  same leaf works for the supported custom context. Move-only remains unsupported
  because context declarations do not define the attribute derivation. Supply
  documented final attributes with the move. Unknown derivations remain a limit.

- `mount-default-change`: refusal improved, request still unsupported when an
  omitted default changes during mounting. A registration declares defaults, not
  arbitrary effect results. Insertion with the documented final value works.
  Inspect the block documentation and supply that value explicitly; preserve the
  draft and report the limit when the final value is unknown.

## Natural-language requests

The 61 tasks in `tests/agent/tasks.mjs` ran on `gpt-6.1-terra` at medium. The 36 medium
and trap tasks ran on `gpt-6.1-sol` at medium as well. After the fixes, `page-break`,
`table-header-older-markup`, `hide-on-phones`, `decorative-image`, `video-autoplay`,
`columns-center`, `accordion-heading-level`, `gallery-media-square`, and
`table-align-column` passed on Terra. Focused desktop reruns also passed
`page-title`, `footnote-reorder`, `new-section`, `copy-section`, and `save-hedged`.
The complete natural-language task set was not repeated.

`invalid-neighbor`, `locked-block`, and `synced-pattern-local` end with
the agent honestly declining and the page unchanged on at least one model. `unregistered-neighbor`
passes.

## Not covered

- Subdirectory installs and multisite. Playground needs a default port for multisite, and
  the fixture can't yet start under a path.
- Desktop host behavior such as hidden tabs, sign-in handoff, and an editor a person already has open.
- Real plugins, apart from the ACF Pro cases, which run only with a local copy. Other
  fixtures imitate plugin behavior generically.
