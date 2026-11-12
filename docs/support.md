# Feature support

Supported means the feature has passing coverage in the current test results.
Experimental means coverage is incomplete or a known failure limits the feature.
Results from older desktop runs are historical and do not establish current behavior.

| Feature | Status | Note |
| --- | --- | --- |
| Pages, posts, and custom post types | Supported | Create and edit block content and post settings using WordPress registrations. |
| Text, layout, styles, and responsive settings | Supported | The real-editor suite covers common edits and style families. |
| Media, categories, and tags | Supported | Upload and attach media and manage terms; some Gallery bindings remain limited. [Finding](editing-results.md#visible-limits) |
| Synced patterns | Supported | Shared editing, overrides, creation from copied sections, and detaching one reference use native registrations. Creation and page replacement are separate verified saves. Detach preserves instance overrides and leaves the shared source unchanged. |
| Templates and template parts | Experimental | An older desktop run saved both but failed to release their locks. [Result](history/integration-results.md#deferred-plugin-issues) |
| Navigation menus | Experimental | An older desktop run refused inspection before editing. [Result](history/integration-results.md#deferred-plugin-issues) |
| Query loops, dynamic dates, tabs, and custom block effects | Experimental | Some requests require explicit companion values or are refused. [Findings](editing-results.md#findings) |
| Blank Video and File placeholders | Experimental | Native serialization loses defaults without a media source. [Finding](editing-results.md#visible-limits) |
| Editing locks and recovery | Experimental | A foreign-lock test had an inconsistent result, and cleanup failed in some older desktop cases. [Result](history/integration-results.md#deferred-plugin-issues) |
| Site guidelines | Experimental | Reads the Gutenberg plugin's Guidelines experiment, whose storage can still change. [Guide](site-guidelines.md) |
| WordPress abilities | Supported | Integration tests run fixture abilities on WordPress 7.0 and 7.1 and Yoast SEO's own abilities, and a desktop agent run used Yoast's ability to turn off its sitemaps. Blockwork can't verify what an ability changed. [Reference](../skills/blockwork/references/shared-and-abilities.md#run-site-abilities) |
| Multisite and subdirectory installations | Untested | These configurations lack complete coverage. [Coverage](editing-results.md#not-covered) |
