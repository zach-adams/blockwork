# Anti-slop provenance

Copied from https://github.com/dmmulroy/anti-slop at
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` on October 2, 2026, using its
`skills/install-anti-slop/scripts/install.mjs` installer and bundled assets.

The rule implementations are unmodified. `oxlint.config.ts` enables every copied
rule and the recommended native accumulating-spread rule with upstream default
options. Some upstream rules were left out:

- the Effect rules, because this project does not use Effect;
- `no-module-mocking`, which recognizes only Jest and Vitest, while this project
  uses `node:test`;
- `no-runtime-typeof` and `no-unknown-parameters`, which pushed code into less
  clear checks (commit `1ce9557`);
- `require-readable-spacing`, because the maintainer wanted tighter grouping of
  related declarations. `readability/statement-spacing` in
  `../readability.ts` replaces it and reuses the unmodified vendored ESLint
  Stylistic engine with project options.

Keep the MIT license and nested ESLint Stylistic license and provenance.
Stage future upstream updates separately and review them against this revision.
