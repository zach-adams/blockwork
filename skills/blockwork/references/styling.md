# Styling updates

Read this before changing block styling. Style changes are ordinary `edit`
operations; see [edit](edit.md). Two operations write styles:

- `update` merges any attributes, including `style`, `layout`, and preset
  attributes, against the registered schema. Send only the keys you change.
- `update_style` sets or unsets property paths after checking them against the
  block's enabled native controls and the theme's presets, and clears a competing
  preset or custom value. Use it when that validation matters, such as choosing a
  preset slug or a responsive state.

The same rules apply to layout attributes in inserted and replaced trees. Base
those trees on content and nesting you have read. Preserve existing text,
rich-text markup, media attributes, and unrelated styling within the requested
scope.

## Work from a design reference

Design and copy references fill context fast, and compaction drops images and
old output. Keep raw Figma design context, PDF text, and large `read` results
in REPL variables and print only what the current section needs. Printing an
object directly shows deeper values only as `[Object]` and `[Array]`, so print
`JSON.stringify` of the narrowed part, such as one guide's controls. Fetch a
section's design context when you build it, not the whole page up front. Save
reference screenshots to files and keep their paths so you can view them again.

## Read the style guides

Request `style_guides` alongside a `blocks` selection for the subtree, one entry
per block or block type, up to 16, in the same read. Each entry is
`{"client_id":"…"}` for a live block or `{"name":"core/column"}` for a type you
plan to insert. Add `properties` to limit a guide to some controls: 1 to 32
prefixes, each an array of keys, such as `[["layout"], ["style","spacing"]]`.
Use a control's prefix for its sides, then read its `edges`. An empty `controls`
array means no enabled control matched.

```js
await blockwork.read({
  blocks: { client_id: groupId, depth: 1 },
  style_guides: [
    { client_id: groupId, properties: [["layout"], ["style", "spacing"], ["style", "border"]] },
    { name: "core/column" },
  ],
});
```

Each guide in `style_guides` (request order) has `controls`: the enabled native
controls, each with its exact `property` array, `value_type`, optional `values`,
accepted `edges`, `requires_edge`, `preset_value_format`, and `preset_catalog`.
It also has `registered_styles`, `pseudo_states`, `custom_css` (whether the
block supports instance CSS), `responsive` when its block type configures its
own viewport ranges, and for a live block its `existing` values, `parent`
context, and `editable` state. A name guide has no client ID, existing
values, or editability guarantee.

Preset catalogs appear once per read in `style_catalogs`. A control's
`preset_catalog` is a zero-based index into that array, including `0`; choose a
slug from `style_catalogs[control.preset_catalog].items` and write it in the
control's `preset_value_format`. Items have `slug`, optional `name`, and native
values such as `color`, `gradient`, `size`, `fontFamily`, `shadow`, or `colors`.
No index means the control has no selectable presets. Duotone controls can also
return `color_catalog`. Identical catalogs share an index; indices belong to
that response only.

`style_rules` appears once per read: the editor's `responsive` rules
(configured viewport ranges, whether state editing is enabled, and the runtime
evidence), which apply to every guide without its own, and `custom_css` (the
property path, `can_edit_css`, `document_has_custom_css`, and the CSS policy).

An absent control means `update_style` has no enabled control for that property,
not that WordPress lacks the feature; `update` can still set registered
attributes, so read `attribute_guide` and the native or plugin documentation
before choosing another operation. Guides read editor-level and block-type
settings. Per-instance settings inherited from an ancestor and plugin
`useSetting` filters need separate native inspection. Guides do not attribute a
setting to core, a theme, a plugin, or Global Styles, compute inherited theme
values, or prove front-end CSS precedence; use `measure` and front-end checks
for that.

## Choose the owner

Space between sibling blocks usually belongs in their parent's `blockGap`.
Space inside a block belongs in padding. Inspect layout and nesting before using
margins to compensate for a structural problem. Use native Row, Stack, Columns,
and wrapping controls when those express the layout. Block visibility is
separate from layout and responsive styling, and is outside `update_style`.

Gutenberg's layout keys do not map directly to CSS property names. In a vertical
flex layout, `justifyContent` controls horizontal `align-items`, and
`verticalAlignment` controls vertical `justify-content`. Check orientation and
parent sizing before changing alignment or compensating with margins.

For an icon above text, measure both the image's figure wrapper and the image. A
centered wrapper can fill the column while its image stays left aligned. A
centering Row needs available width and an image with a bounded flex basis; read
the parent's constraints before adding another alignment patch. Measure
icon-to-text spacing between the visible elements, not only block wrappers.

For columns and wrapping changes, check the wide result and a narrow width, and
inspect stacking and divider placement at each. If you cannot check a width,
report it as unchecked instead of inferring it from attributes.

Use native properties for a single instance. Use `set_block_style` with a name
from the guide's `registered_styles` for an existing selectable treatment.
Creating a reusable registered style, Global Styles, and theme CSS need separate
authorized theme or plugin work; these operations do not edit them. Unknown
custom block properties need their live attribute schema and the plugin's
documentation; do not guess names.

## Text and block alignment

Text alignment is a block support on WordPress 7.1 text blocks such as
Paragraph, Heading, Button, and Post Title: `["style","typography","textAlign"]`
with a value the guide lists, such as `left`, `center`, or `right`. These blocks
have no `textAlign` attribute. `align` is block alignment (`wide`, `full`, and on some blocks
`left`, `center`, or `right` floats), not text alignment.

## Set or remove one property

`update_style` patches the selected block's attributes and preserves everything
else, including other sides, responsive overrides, custom CSS, classes, and
unrelated attributes. Each edit takes 1 to 32 property changes; paths have 1 to
8 keys. Most values are strings or numbers accepted by the registered attribute;
the guide's `value_type` and `values` describe exceptions. Patch one padding or
margin side with an edge path; object replacement is not part of this
operation. When `requires_edge` is true, set an allowed edge instead of a
shorthand that would change every side. Overlapping paths and competing
representations in the same edit refuse.

```json
{
  "op": "update_style",
  "client_id": "…",
  "set": [
    {"property":["style","spacing","padding","top"],"value":"24px"},
    {"property":["style","@mobile","spacing","padding","top"],"value":"12px"}
  ],
  "unset": [["style","@tablet","spacing","padding","top"]]
}
```

The same change through `update`, validated against the attribute schema only,
is `{"op":"update","client_id":"…","attributes":{"style":{"spacing":{"padding":{"top":"24px"}},"@mobile":{"spacing":{"padding":{"top":"12px"}}}}},"unset":[["style","@tablet","spacing","padding","top"]]}`.

`unset` deletes an explicit override and prunes empty objects; Gutenberg then
applies the registered default or inherited style. Setting `0`, an empty string,
or `null` is not a reset. A side cannot be patched inside a scalar shorthand
such as `padding: "24px"`; read it and convert that representation with `update`
if necessary.

## Native property coverage

Guides cover the native controls a block's registration and the theme's settings
enable, including text alignment, text columns, indent, writing mode,
background image, size, position, repeat, attachment, and gradient, element
colors for links, buttons, heading levels, and captions, duotone, and borders.

- Borders include whole-border color, width, style, and radius, individual
  radius corners, and side paths such as `["style","border","right","color"]`,
  `width`, and `style`. Use nested color preset tokens for sides. A whole-border
  preset uses `borderColor` when registered; setting a base side color converts
  it into a nested token so its class cannot override the side.
- Background images take `"none"` or an object with an absolute `url`, optional
  positive attachment `id`, `source: "file"`, and `title`. Sizing controls
  follow `background.backgroundSize` support.
- Duotone lives at `["style","color","duotone"]` although its support flag is
  `filter.duotone`. It takes a nested preset token, `"unset"` to disable an
  inherited filter, or an array of two color strings.

Child flex and grid sizing, positioning, block-specific image sizing, and plugin
properties are outside the guide; use `attribute_guide` and their native parent
rules.

## Presets and custom values

Use the current guide's preset slugs, not remembered theme names. Base preset
attributes include `textColor`, `backgroundColor`, `gradient`, `fontSize`,
`fontFamily`, and `borderColor` when the block registers them. Their custom
counterparts live in `style.color`, `style.typography`, or `style.border`.
Setting either representation clears its competing base value; removing one
removes only that one. Do not set both in one patch.

A preset attribute takes the bare slug, such as `["fontSize"]` set to `"large"`
or `["fontFamily"]` set to `"sans"`. Nested properties take CSS values or the
guide's `preset_value_format`, such as `"var:preset|font-family|sans"`,
`"var:preset|font-size|large"`, or `"var:preset|spacing|40"`; never a bare slug.
Set `["style","typography","fontSize"]` to `"24px"` for a custom base size.
Responsive presets use the nested token and keep the inherited base preset.
Theme restrictions on custom colors and font sizes still apply, and catalogs
omit native defaults the theme disables.

## Responsive and pseudo states

`style_rules.responsive.states` gives the configured viewport ranges, and a
guide's own `responsive` replaces them for that block type; do not assume fixed
breakpoints. Without a configuration, the native defaults are
mobile through 480px and tablet above 480px through 782px. If the runtime
evidence is absent, responsive patches refuse.

When the request names no device, change the base value as the native control
does in its default state. Leave viewport and pseudo-state choices alone unless
the request names that case or asks every width to match. If an override keeps
the new base value off a width, say so in your report.

Base `style` values apply at any width without an override; there is no `@desktop`
key. `style["@mobile"]` and `style["@tablet"]` each override the base independently,
and tablet does not cascade into mobile. Removing a mobile property exposes the
base value even when tablet has one. Changing the base leaves overrides in place, as
native controls do, so a new base value doesn't reach a width that has its own.
Preserve other states when changing one.

A guide's `pseudo_states` lists supported states for native Button and
Navigation Link blocks, such as `["style",":hover","color","background"]`; a
pseudo state can also follow a viewport key. Arbitrary pseudo states and custom
style states are outside this operation.

## Custom CSS

Block instance CSS lives in `["style","css"]`: declarations and nested `&`
selectors, with Gutenberg generating the instance selector. Check the guide's
`custom_css` flag and `style_rules.custom_css.can_edit_css` first; WordPress's
`edit_css` permission governs it. A style patch also refuses when the document
already contains CSS (`document_has_custom_css`) and the user cannot edit it,
because a server save could strip that CSS.

Use native controls first. Repeated treatments belong in registered block
styles. Before proposing custom CSS, identify through rendered checks the
constraint that native controls cannot resolve. Page-scoped classes or styles
require explicit user permission, and instance CSS does not bypass that rule.
Author CSS only within the user's authorized scope. CSS syntax and
front-end appearance need their own verification; a verified save proves
persistence and block validity, not that the CSS achieves the intended look.

## Diagnose a styling failure

1. Confirm the affected block, the intended appearance, the viewport, and any
   responsive or interactive state. Read its attributes and check that its
   content and children are what the request needs.
2. Find the rendered element in the canvas. A wrapper's bounds do not prove its
   content's size or position. If the element is missing, look at rendering and
   validity before CSS. Check `measure`'s `fonts.failed` before typography work.
3. Measure the symptom with properties that distinguish the plausible causes.
4. Trace the unexpected computed value to its declaration or native attribute:
   selectors, specificity, source order, inheritance, media or state rules, and
   inline styles. Attributes and class names alone do not say which rule wins.
5. If the cause is a theme or plugin rule that applies to every instance, such
   as a registered style's own offsets, the fix belongs in that theme or
   plugin. Report the rule and ask before overriding it block by block.
6. Otherwise make the smallest correction the evidence supports, following
   [choose the owner](#choose-the-owner). When a correction fails, revisit the
   cause instead of stacking compensations.
7. Recheck the content, geometry, and appearance at the relevant viewport, and
   report the visual result separately from editor state and persistence.
