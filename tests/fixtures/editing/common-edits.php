<?php
/**
 * Registers blocks and approved metadata for whole-page editing jobs.
 */
add_action('init', function () {
    register_block_pattern('example/approach', [
        'title' => 'Job approach',
        'categories' => ['featured'],
        'content' => '<!-- wp:group {"layout":{"type":"constrained"}} --><div class="wp-block-group"><!-- wp:heading --><h2 class="wp-block-heading">Approach</h2><!-- /wp:heading --><!-- wp:paragraph --><p>Listen first.</p><!-- /wp:paragraph --></div><!-- /wp:group -->',
    ]);
    foreach (['bw_seo_title', 'bw_seo_description', 'bw_unrelated'] as $key) {
        register_post_meta('page', $key, ['type' => 'string', 'single' => true, 'show_in_rest' => true]);
    }
    register_block_type('bw/job-post-card', [
        'api_version' => 3,
        'title' => 'Job post card',
        'category' => 'widgets',
        'attributes' => [
            'imageId' => ['type' => 'number', 'default' => 0],
            'headingLevel' => ['type' => 'number', 'default' => 2],
            'text' => ['type' => 'string', 'default' => 'Story'],
        ],
        'render_callback' => static function ($attributes) {
            $level = min(6, max(1, (int) $attributes['headingLevel']));
            return '<article ' . get_block_wrapper_attributes() . '><h' . $level . '>' . esc_html($attributes['text']) . '</h' . $level . '>' . wp_get_attachment_image($attributes['imageId']) . '</article>';
        },
    ]);
});
add_action('enqueue_block_editor_assets', function () {
    wp_add_inline_script('wp-blocks', <<<'JS'
wp.domReady(() => {
  const el = wp.element.createElement;
  wp.blocks.registerBlockType('bw/job-post-card', {
    apiVersion: 3, title: 'Job post card', category: 'widgets',
    attributes: { imageId: { type: 'number', default: 0 }, headingLevel: { type: 'number', default: 2 }, text: { type: 'string', default: 'Story' } },
    edit: ({ attributes }) => el('article', wp.blockEditor.useBlockProps(), el('h' + attributes.headingLevel, {}, attributes.text)),
    save: () => null,
  });
  for (const name of ['job-container', 'job-item']) {
    wp.blocks.registerBlockType('bw/' + name, {
      apiVersion: 3, title: name, category: 'widgets',
      edit: () => el('div', wp.blockEditor.useBlockProps(), el(wp.blockEditor.InnerBlocks)),
      save: () => el('div', wp.blockEditor.useBlockProps.save(), el(wp.blockEditor.InnerBlocks.Content)),
      styles: [{ name: 'large', label: 'Large' }],
    });
  }
});
JS, 'after');
});
add_action('enqueue_block_assets', function () {
    wp_register_style('bw-job-scroll', false);
    wp_enqueue_style('bw-job-scroll');
    wp_add_inline_style('bw-job-scroll', '.bw-job-scroll{overflow-x:auto}@media(max-width:600px){.bw-job-scroll>.wp-block-group{min-width:260px}}');
});
