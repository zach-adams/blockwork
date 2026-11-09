<?php
/**
 * Test plugin for the real-editor suite: what real sites add to a stock install.
 */

add_action('init', function () {
    register_post_type('bw_book', [
        'label' => 'Books',
        'public' => true,
        'show_in_rest' => true,
        'supports' => ['title', 'editor', 'excerpt', 'thumbnail', 'custom-fields', 'revisions'],
    ]);

    register_post_meta('page', 'bw_subtitle', [
        'type' => 'string',
        'single' => true,
        'show_in_rest' => true,
    ]);

    register_block_type('bw/dynamic', [
        'api_version' => 3,
        'title' => 'Fixture dynamic',
        'category' => 'widgets',
        'attributes' => ['label' => ['type' => 'string', 'default' => '']],
        'render_callback' => fn ($attributes) => '<div class="bw-dynamic">' . esc_html($attributes['label']) . '</div>',
    ]);

    register_block_style('core/paragraph', ['name' => 'bw-callout', 'label' => 'Callout']);

    register_block_pattern('bw/hero', [
        'title' => 'Fixture hero',
        'content' => "<!-- wp:group {\"layout\":{\"type\":\"constrained\"}} -->\n<div class=\"wp-block-group\"><!-- wp:heading -->\n<h2 class=\"wp-block-heading\">Hero</h2>\n<!-- /wp:heading --></div>\n<!-- /wp:group -->",
    ]);
});

add_action('enqueue_block_editor_assets', function () {
    wp_add_inline_script('wp-blocks', <<<'JS'
wp.domReady(() => {
  const el = wp.element.createElement;
  const save = (props) => el('div', wp.blockEditor.useBlockProps.save(),
    el(wp.blockEditor.RichText.Content, { tagName: 'h3', value: props.attributes.title }),
    el(wp.blockEditor.InnerBlocks.Content));
  wp.blocks.registerBlockType('bw/card', {
    apiVersion: 3,
    title: 'Fixture card',
    category: 'widgets',
    attributes: { title: { type: 'string', source: 'html', selector: 'h3', default: '' } },
    edit: (props) => el('div', wp.blockEditor.useBlockProps(),
      el(wp.blockEditor.RichText, {
        tagName: 'h3',
        value: props.attributes.title,
        onChange: (title) => props.setAttributes({ title }),
      }),
      el(wp.blockEditor.InnerBlocks)),
    save,
  });
});
JS, 'after');
});
