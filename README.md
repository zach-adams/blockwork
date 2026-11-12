# Blockwork

Blockwork is a plugin for OpenAI's ChatGPT/Codex desktop app. It gives the app's
agent a cleaner way to edit WordPress pages and posts in Gutenberg (the block
editor) through the app's built-in browser, without needing to install a
WordPress plugin first.

Without Blockwork, the agent can still edit a page by reading screenshots and
clicking through the editor the way a person would. That is slow and can miss
settings in side panels, nested blocks, and phone or tablet styles. The agent may
also switch to Code editor mode, which is more fragile and changes your editor
preferences.

Blockwork works with Gutenberg blocks through the app's built-in browser with the
editor's JavaScript API and checks each change against your site's block rules.
It uses its own hidden editor tab when one isn't already open, and tells you
exactly what changed afterward.

Blockwork is an early prototype, version 0.1.2, so expect gaps and rough edges.

## Demo

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

If your site runs the Gutenberg plugin's Guidelines experiment, Blockwork follows
the writing, image, and block guidelines you set there when it writes new
content. See [site guidelines](docs/site-guidelines.md) to set them up.

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

Blockwork doesn't use a server or any service besides your desktop app and its
built-in browser.

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

## Limits

Blockwork isn't an all-in-one WordPress editing tool. It connects the desktop
app's agent to the Gutenberg editor in the app's browser, and it exists only until
sites can turn on WebMCP, a draft browser standard that lets a site offer its own
tools to an agent. WebMCP is the right long-term fix; see
[WebMCP in WordPress](#webmcp-in-wordpress). Within that focus, Blockwork has
these limits:

- It edits block editor content and post settings. It doesn't edit theme files,
  PHP code, or site-wide styles, and it doesn't install plugins.
- It needs the block editor, so it can't edit pages built with page builders such
  as Elementor, or posts edited in the Classic Editor.
- Some blocks from plugins can't be edited safely. Blockwork reports them, leaves
  them unchanged, and can still edit the blocks around them.
- Multisite networks and WordPress installed in a subdirectory are untested.

See [feature support](docs/support.md) for current coverage and known limits.

## For developers

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

### WebMCP in WordPress

As of November 2026, WebMCP in WordPress is available only through experimental
plugins:

- The official [AI plugin](https://github.com/WordPress/ai) added a WebMCP
  experiment for the block editor in version 1.5.0.
- [webmcp-adapter](https://github.com/galatanovidiu/webmcp-adapter) is a
  separate proof of concept that exposes WordPress abilities as tools to the
  desktop app's built-in browser.

The [WordPress 7.2 roadmap](https://make.wordpress.org/core/2026/09/18/roadmap-to-7-2/)
lists WebMCP experimentation in the AI plugin, with no guarantee that it lands in
7.2, which is due in early December 2026. No core release has a WebMCP date yet.

## License

Blockwork is released under the [MIT license](LICENSE).
