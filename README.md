# Blockwork

Blockwork is a plugin for OpenAI's ChatGPT/Codex desktop app. It lets you ask the
app's agent to edit pages and posts on your WordPress site in plain language. It
runs in the app's built-in browser, so you don't install a plugin on your
WordPress site.

Without Blockwork, the agent can still edit a page by reading screenshots and
clicking through Gutenberg, WordPress's block editor, the way a person would.
That is slow and can miss settings in side panels, nested blocks, and phone or
tablet styles. The agent may also switch to Code editor mode, which is more
fragile and changes your editor preferences. Blockwork works with Gutenberg
blocks directly through the editor's JavaScript APIs and checks each change
against your site's block rules. It uses its own hidden editor tab when one isn't
already open, and tells you exactly what changed afterward.

Blockwork is an early prototype, version 0.1.2, so expect gaps and rough edges.

![A chat in the desktop app asks Blockwork to restyle a landing page's hero, then
add a photo background, then make it taller on phones. The editor beside the chat
updates after each request.](docs/demo.gif)

The demo shows three requests in one chat. The waits while the agent works are
sped up, and a label shows by how much.

## What you can ask for

Ask in the same words you'd use with a person who knows WordPress:

- "Make the hero headline "Fund Your Next Move", center it, and turn the overlay
  bright orange, then save."
- "Use this photo as the hero background." with an image attached to the message.
- "On mobile, make the hero taller and the headline smaller."
- "Add a three-question FAQ under the pricing table on the Services page."
- "Create a draft page called Careers with a heading, an intro paragraph, and a
  Contact Us button."
- "Set this post's featured image and add it to the News category."

Blockwork can change text, layout, colors, spacing, and typography, including
separate settings for tablets and phones. It can upload media, create posts,
pages, and custom post type entries, and change a post's title, URL slug, status,
template, featured image, categories, and tags. It also works with blocks your
theme and plugins add, and edits synced patterns when you ask. Editing templates
and navigation menus is experimental; see [support status](docs/support.md).

## What you need

- The ChatGPT/Codex desktop app. Blockwork has been tested on macOS. It doesn't
  work in ChatGPT on the web or in cloud tasks, because their browsers don't give
  plugins the page access that editing needs.
- Full browser access for your site. The app asks you to allow it the first time
  Blockwork works on a site. A workspace admin can turn this access off, and then
  Blockwork can't edit.
- A WordPress 7.0 or later site that uses the block editor and HTTPS. A local
  development site on your computer works too, and it can use plain HTTP only at
  a `localhost` address.
- A WordPress account that can edit the content you ask about. You sign in
  yourself, in the app's browser.

Blockwork doesn't use a server or any service besides the desktop app.

## Install

Blockwork isn't listed in the app's plugin directory yet, so for now you build it
from this repository. You need Git, Node 22.18 or later, pnpm, and the Codex CLI,
which the desktop app shares its plugin settings with.

```sh
git clone https://github.com/zach-adams/blockwork.git
cd blockwork
pnpm install --frozen-lockfile
pnpm package
codex plugin marketplace add .
codex plugin add blockwork@blockwork-local
```

`pnpm package` builds the plugin without running the project's checks. Blockwork
then appears in the app's Plugins directory under "Blockwork local". If a chat
that was already open doesn't find it, reload the app. To update, pull the
latest changes, then build and install again:

```sh
git pull
pnpm install --frozen-lockfile
pnpm package
codex plugin add blockwork@blockwork-local
```

## Make your first edit

Start with a draft page, so nothing changes on your live site while you try it.

1. Open a chat in the desktop app and describe the change, naming the site and
   page. For example: "Use Blockwork to change the main heading of my draft page
   About on example.com to "About our team"."
2. If the app asks to allow full browser access for the site, allow it.
3. If WordPress asks you to sign in, the app shows you its browser. Sign in there.
   The agent waits, then carries on. Blockwork never asks for your password, and
   the app's browser keeps you signed in for later requests.
4. When the agent finishes, it tells you what changed and whether it saved. Open
   the page to check the result.

## How editing and saving work

Blockwork works in one of two ways, depending on whether you have the page open:

| You ask about | What Blockwork does |
| --- | --- |
| A page or post that isn't open in the editor, including one you're viewing on the live site | It opens the editor in a background tab of the app's browser, makes the change, and saves it. |
| A page or post open in the WordPress editor in the app's browser | It edits that editor, keeps any changes you haven't saved, and leaves its work unsaved for you to review. It saves only when you ask. Saving then saves everything pending in that editor, your changes included. |

Some work is stored right away even in an open editor. WordPress's own autosave
keeps running, and uploaded media, new categories or tags, and changes to shared
content such as a synced pattern are saved on their own.

- Saving a published page changes the live page right away. Blockwork keeps a
  page's status, such as draft, scheduled, or published, unless you ask to change
  it.
- After each save, Blockwork reads the page back from WordPress to confirm what
  was stored. If it can't tell whether a save went through, for example after a
  dropped connection, it says so and checks again instead of saving twice.
- It checks WordPress's editing locks and stops when someone else is editing the
  same page. One test run still saved under another editor's lock, so this check
  isn't proven reliable yet.
- A change to a synced pattern, template, or navigation menu shows up on every
  page that uses it. Blockwork changes shared content only when the request
  covers it.
- Before a save, Blockwork can undo its latest edit, but only while the draft is
  exactly as that edit left it. After a save, WordPress's revisions screen can
  restore earlier content if the site keeps revisions. Revisions don't cover the
  slug, status, parent page, categories, or tags.
- It uses Chrome only when you ask it to.

## What Blockwork keeps

Blockwork writes no files to your computer. It adds nothing to your site except
the changes you ask for. Content the agent reads from your site becomes part of
the chat, like anything else the agent reads, under your ChatGPT account's data
settings. Each request uses your plan's usage like any other agent task.

## Limits

- It edits block editor content and post settings. It doesn't edit theme files,
  PHP code, or site-wide styles, and it doesn't install plugins.
- It needs the block editor, so it can't edit pages built with page builders such
  as Elementor, or posts edited in the Classic Editor.
- Some blocks from plugins can't be edited safely. Blockwork reports them, leaves
  them unchanged, and can still edit the blocks around them.
- Multisite networks and WordPress installed in a subdirectory are untested.

See [feature support](docs/support.md) for current coverage and known limits.

## For WordPress developers

Blockwork is a skill, which is a set of instructions the agent reads, plus a
JavaScript file. The agent loads that file into the editor page through the
desktop browser's developer access, the Chrome DevTools Protocol. It then calls
operations such as `connect`, `read`, `edit`, and `save`.

Those operations use Gutenberg's own data stores and block APIs. Blocks are
created and serialized by the site's real block registrations, so custom blocks
from your theme and plugins behave as they would for a person. After a save,
Blockwork reports whether every block in the stored page passed validation. When a
page holds blocks it can't handle, it confirms instead that those blocks came
through unchanged. Saves go through the editor's native save action.
Media, terms, and settings use the REST API with the signed-in user's cookie and
nonce, so WordPress permissions apply as usual. Each save is checked by fetching
the stored post and parsing it again. Abilities that plugins register through the
WordPress Abilities API can also be run from a chat.

Generating block markup and writing `post_content` directly skips those
safeguards. A block's save function, its validation, and attributes that only the
editor computes are easy to get wrong by hand.

- [The skill](skills/blockwork/SKILL.md) and its references define each
  operation, its request shape, and its errors.
- [Editor workflows](docs/editor-workflows.md) explains how Blockwork shares an
  editor with a person, tracks what changed, and recovers from failures.
- [Feature support](docs/support.md) lists coverage and known limits.
- [Contributing](CONTRIBUTING.md) maps the code and checks.
- [Developing Blockwork](docs/development.md) covers building, testing, and the
  local tools for working on it.
- [AGENTS.md](AGENTS.md) holds the rules for agents working on this repository.

## License

Blockwork is released under the [MIT license](LICENSE).
