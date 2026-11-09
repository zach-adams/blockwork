<?php
/** Structural editing fixtures. */

add_action('init', function () {
    register_post_type('bw_locked', [
        'label' => 'Locked fixture',
        'public' => true,
        'show_in_rest' => true,
        'supports' => ['title', 'editor'],
        'template' => [['core/paragraph', ['content' => 'Template text']]],
        'template_lock' => 'all',
    ]);
});

add_action('enqueue_block_editor_assets', function () {
    wp_add_inline_script('wp-blocks', <<<'JS'
wp.domReady(() => {
  const el = wp.element.createElement;
  const container = (name, settings = {}) => wp.blocks.registerBlockType(name, {
    apiVersion: 3, title: name, category: 'widgets',
    edit: () => el('div', wp.blockEditor.useBlockProps(), el(wp.blockEditor.InnerBlocks)),
    save: () => el('div', wp.blockEditor.useBlockProps.save(), el(wp.blockEditor.InnerBlocks.Content)),
    ...settings,
  });
  container('bw/structure-box', { allowedBlocks: ['bw/structure-item'] });
  container('bw/context-box', {
    attributes: { tone: { type: 'string', default: 'red' } },
    providesContext: { 'bw/tone': 'tone' },
  });
  const leaf = (name, settings = {}) => wp.blocks.registerBlockType(name, {
    apiVersion: 3, title: name, category: 'widgets', ...settings,
    edit: () => el('div', wp.blockEditor.useBlockProps(), name),
    save: () => el('div', wp.blockEditor.useBlockProps.save(), name),
  });
  leaf('bw/structure-item', { parent: ['core/group'] });
  leaf('bw/ancestor-item', { ancestor: ['bw/context-box'] });
  container('bw/template-card', {
    edit: () => el('div', wp.blockEditor.useBlockProps(), el(wp.blockEditor.InnerBlocks, {template: [['core/paragraph', {content:'Template child'}]]})),
  });
  leaf('bw/singleton', { supports: { multiple: false } });
  leaf('bw/no-inserter', { supports: { inserter: false } });
  wp.blocks.registerBlockType('bw/context-label', {
    apiVersion: 3, title: 'Context label', category: 'widgets',
    usesContext: ['bw/tone'],
    attributes: { resolvedTone: { type: 'string', default: '' } },
    edit: (props) => {
      wp.element.useEffect(() => { props.setAttributes({ resolvedTone: props.context['bw/tone'] || '' }); }, [props.context['bw/tone']]);
      return el('div', wp.blockEditor.useBlockProps(), props.attributes.resolvedTone);
    },
    save: (props) => el('div', wp.blockEditor.useBlockProps.save(), props.attributes.resolvedTone),
  });
  wp.blocks.registerBlockType('bw/mount-label', {
    apiVersion: 3, title: 'Mount label', category: 'widgets',
    attributes: { initialized: { type: 'boolean', default: false } },
    edit: (props) => {
      wp.element.useEffect(() => { props.setAttributes({ initialized: true }); }, []);
      return el('div', wp.blockEditor.useBlockProps(), String(props.attributes.initialized));
    },
    save: (props) => el('div', wp.blockEditor.useBlockProps.save(), String(props.attributes.initialized)),
  });
});
JS, 'after');
});
