# Site guidelines

Blockwork follows a site's guidelines when it writes new content. Guidelines are
notes a site admin writes once about the site's audience, writing style, images,
and how to use particular blocks. They come from the Gutenberg plugin's Guidelines
experiment, which WordPress plans to bring into core. Support is experimental
because that storage can still change.

## Use guidelines on your site

1. Install and activate the [Gutenberg plugin](https://wordpress.org/plugins/gutenberg/).
   Blockwork is tested against its latest release.
2. In wp-admin, open Gutenberg, then Experiments, check Guidelines, and save.
3. Open Settings, then Guidelines, and fill in the sections you want: Site, Copy,
   Images, Blocks, and Additional. Plugins can add more sections. Only an
   administrator can edit this screen.
4. Ask for edits as usual. When the agent writes new copy, chooses images, or
   builds a section, it reads the guidelines first. A change to them applies
   to the next request.

Your request always wins. If the copy guideline says to write casually and you
ask for a formal paragraph, the paragraph is formal. Guidelines never make
Blockwork change, save, or publish anything you didn't ask for, and Blockwork
ignores guideline text that asks for anything besides wording, images, or
block choices. Any account that can edit posts can read the guidelines, so
keep passwords and other private details out of them.

Blockwork only reads guidelines. To change them, use the Guidelines screen.

## How it works

`connect` and `read` accept `guidelines: true`. The
[inspection reference](../skills/blockwork/references/inspection.md#site-guidelines)
documents the result and when the agent asks for it. The skill's edit rules
in [SKILL.md](../skills/blockwork/SKILL.md#edit) tell the agent to ask before
writing copy, choosing images, or building a section.

`guidelines()` in `src/catalog.ts` makes two REST requests with the signed-in
user's session:

- `/wp/v2/knowledge/guideline-scopes` lists the screen's sections, with their
  titles and order.
- `/wp/v2/knowledge?status=publish&per_page=-1` returns the published
  `wp_knowledge` posts. The experiment stores each section as a post named
  `guideline-{scope}`, and each block's guideline as
  `guideline-block-{namespace}_{name}`, such as `guideline-block-core_heading`.

The scope list goes first, because only it reports a missing route as WordPress's
`rest_no_route`. Blockwork reads each guideline's rendered text and removes its
HTML tags. The raw text comes only with edit context, which leaves out every
guideline the account can't edit, and the experiment lets only administrators
edit published guidelines. A plugin that adds to rendered post content can
therefore add to a guideline's text.

Blockwork keeps what the Guidelines screen itself shows. It skips posts that
aren't published, sections the scope list doesn't name, block types this editor
hasn't registered, and every block guideline when a plugin removes the Blocks
section. It cuts each guideline at 5,000 characters, the experiment's default
limit. When the routes don't exist, the guide reports `guidelines_not_enabled`
instead of failing the read.

## Keep up with Gutenberg

As of Gutenberg 24.3.1 in November 2026, Guidelines is still an experiment, and
WordPress core doesn't include `wp_knowledge`. It has been renamed before. The
case "Gutenberg Guidelines reach read for registered scopes and blocks" in
`tests/editing/plugins.test.mjs` installs the latest Gutenberg release on each
run, so it fails when the storage changes. Run it after a Gutenberg release
whose changelog mentions Guidelines or knowledge:

```sh
pnpm test:editing tests/editing/plugins.test.mjs --test-name-pattern='Guidelines'
```

These changes would need work in Blockwork:

- A new post type, REST base, or scope route means updating the paths in
  `guidelines()`.
- A new naming scheme for guideline posts means updating the slug parsing in
  `guidelines()` and the slugs the test seeds.
- A different default length means updating `guidelineLength` and the
  5,000-character note in the inspection reference.
- New kinds of guidelines beyond sections and blocks need a decision on how the
  agent applies them, recorded in the inspection reference.
- When core ships Guidelines, drop step 1 and 2 above, list the first WordPress
  version that has it, and run the test case without `gutenberg: true` in
  `startEditingSite`. Delete that option if nothing else uses it.

The WordPress AI plugin reads the same storage in
[`includes/Services/Guidelines.php`](https://github.com/WordPress/ai/blob/develop/includes/Services/Guidelines.php),
which is a useful second reference when the storage changes.
