# Real-editor test runs

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
