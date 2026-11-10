# TypeScript style

Blockwork follows the [Google TypeScript style guide](https://google.github.io/styleguide/tsguide.html)
with project readability additions. Write source for a person reviewing a
change. Compress the generated package when needed, not the implementation.

## Automatic checks

The configurations are the source of truth for enforceable conventions:

- [Oxfmt](../.oxfmtrc.json) owns formatting, including 100-column wrapping and
  compact objects that fit on a line.
- [Oxlint](../oxlint.config.ts) owns code conventions through native rules
  wherever available, alongside the existing anti-slop rules.
- [The local plugin](../tools/oxlint/readability.ts) fills three gaps in the
  installed native rules: top-level function declarations while allowing local
  closures, PascalCase type names, and statement spacing. It groups short
  declarations and keeps gaps around control flow. The spacing engine is already
  vendored by anti-slop. No extra plugin dependencies are needed.

Oxfmt covers implementation, configuration, and build scripts. Generated output
and vendored code are excluded. The Oxlint configuration and plugin entry point
use default exports because Oxlint requires them.

## JSON interfaces

The [project API naming rule](../AGENTS.md#api-conventions) uses
`snake_case` for Blockwork-owned request, response, and fixture data, including
operation and error identifiers. Local implementation names can follow the
TypeScript guide's camelCase and PascalCase conventions. A variable carrying
an API field can retain its snake_case spelling. Preserve native keys when
passing through Gutenberg, WordPress, JSON Schema, or host data.

Named JSON records use interfaces too. Extend `JsonObject` when a record must
pass through the JSON hashing or serialization helpers. This native Gutenberg
registration keeps its `isDefault` spelling:

```ts
export interface BlockStyle extends JsonObject {
  name: string;
  label: string;
  isDefault?: boolean;
}
```

TypeScript does not infer an interface's compatibility with a string index
signature the same way it does for an object type alias. Extending `JsonObject`
states that every property must hold JSON-compatible data. It also permits extra
JSON-valued properties during construction. Runtime schemas still validate
external input under their existing contracts. This is the chosen tradeoff for
using interfaces consistently.

## Review conventions

Tools cannot determine whether a name explains its purpose or whether a
function does too much. Review these points:

- Use names that explain purpose. A mechanically valid name can still be
  unhelpful. Short names are fine in small callbacks. Preserve names required
  by WordPress or another external API.
- Split dense expressions into named steps when the intermediate value helps
  explain the decision. Use guard clauses for eligibility checks and `if` or
  `switch` for several outcomes. Preserve short-circuiting around expensive or
  stateful calls. Declarative validation schemas can remain nested.
- Keep functions focused on one operation. Extract a helper when it names a
  real responsibility, not just to lower a line count.
- Let TypeScript infer obvious local types. Annotate public contracts and
  recursive functions where the declaration helps a reader.
- Comment non-obvious intent, constraints, and usage contracts. Avoid comments
  that repeat the statement beneath them.

## Development commands

```sh
pnpm format
pnpm lint:fix
pnpm format
pnpm check
```

`pnpm check` includes formatting, linting, type checking, compilation, and tests.
The pre-commit hook runs all of it except compilation and tests, and CI runs the checked build. Fix the code rather
than adding suppressions or changing rules to pass a check.
