# Anti-slop provenance

Copied from https://github.com/dmmulroy/anti-slop at
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` on October 2, 2026, using its
`skills/install-anti-slop/scripts/install.mjs` installer and bundled assets.

The rule implementations are unmodified. `oxlint.config.ts` enables the generic
rules and the recommended native accumulating-spread rule with upstream default
options, except `require-readable-spacing`. The maintainer requested tighter
grouping of related declarations on October 4, 2026.
`readability/statement-spacing` replaces
that rule and reuses the unmodified vendored ESLint Stylistic engine with project
options. The upstream Effect rules were left out because this project does not use Effect.

Keep the MIT license and nested ESLint Stylistic license and provenance.
Stage future upstream updates separately and review them against this revision.
