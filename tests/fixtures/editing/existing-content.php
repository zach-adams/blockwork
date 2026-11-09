<?php
/**
 * Registers blocks used to test existing content.
 */

add_action('init', function () {
    register_post_meta('page', 'bw_existing_note', ['type' => 'string', 'single' => true, 'show_in_rest' => true]);
});

add_action('enqueue_block_editor_assets', function () {
    if (get_option('bw_existing_plugin_active')) {
        wp_add_inline_script('wp-blocks', "wp.domReady(() => wp.blocks.registerBlockType('bw/existing-plugin', {apiVersion:3,title:'Plugin fixture',category:'widgets',attributes:{meaning:{type:'string'}},edit:()=>null,save:()=>null}));", 'after');
    }
    if (get_option('bw_existing_plugin_active')) {
        wp_add_inline_script('wp-blocks', "wp.hooks.addFilter('blocks.registerBlockType','bw/existing-extension',(settings,name)=>name==='core/paragraph'?{...settings,attributes:{...settings.attributes,pluginMeaning:{type:'string'}}}:settings);", 'after');
    }
    wp_add_inline_script('wp-blocks', <<<'JS'
wp.domReady(() => {
  const el = wp.element.createElement;
  const register = (name, attributes, save, deprecated = []) => wp.blocks.registerBlockType(name, {
    apiVersion: 3, title: name, category: 'widgets', attributes,
    edit: () => el('div', wp.blockEditor.useBlockProps(), 'Fixture'), save, deprecated: deprecated.map(d => ({apiVersion:3,...d})),
  });
  register('bw/existing-local', { previewIndex: { type: 'integer', role: 'local', default: 0 } }, () => el('div', null, 'Local'));
  register('bw/existing-meta', { note: { type: 'string', source: 'meta', meta: 'bw_existing_note' } }, () => el('div', null, 'Meta'));
  register('bw/existing-pre', { marker: { type: 'integer' } }, () => el('pre', null, 'A  B'));
  register('bw/existing-shape', { config: { type: ['object', 'array'] } }, () => null);
  const attributes = { legacyTone: { type: 'string' }, tone: { type: 'string' } };
  const save = () => el('div', null, 'Eligible');
  register('bw/existing-eligible', attributes, save, [{ attributes, save, isEligible: (a) => !!a.legacyTone, migrate: (a) => ({ tone: a.legacyTone }) }]);
  register('bw/existing-deprecated', { text: { type: 'string' } }, (p) => el('div', null, p.attributes.text), [{
    attributes: { text: { type: 'string' } }, save: (p) => el('p', null, p.attributes.text),
  }]);
});
JS, 'after');
});

add_filter('content_save_pre', function ($content) {
    $mode = get_option('bw_existing_filter');
    if ($mode === 'pre') {
        return str_replace('<pre>A  B</pre>', '<pre>A B</pre>', $content);
    }
    if ($mode === 'script_entity') {
        return str_replace('literal&nbsp;value', 'literal value', $content);
    }
    if ($mode === 'union') {
        return str_replace('"config":{}', '"config":[]', $content);
    }
    return $content;
});
