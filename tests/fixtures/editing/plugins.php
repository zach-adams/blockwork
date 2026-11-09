<?php
/** Fixture hooks enabled only for individual real-editor tests. */

add_filter('content_save_pre', function ($content) {
    $rewrite = get_option('bw_test_rewrite');
    if ($rewrite === 'comment') {
        return $content . "\n<!-- fixture comment -->";
    }
    if ($rewrite === 'class') {
        return str_replace('<p>', '<p class="fixture-class">', $content);
    }
    if ($rewrite === 'pre') {
        return str_replace('A  B', 'A B', $content);
    }
    return $content;
});

add_filter('wp_insert_post_data', function ($data, $postarr) {
    if (!empty($postarr['ID']) && get_option('bw_test_fields')) {
        $data['post_title'] = 'Changed by fixture';
    }
    return $data;
}, 10, 2);

add_filter('rest_prepare_page', function ($response) {
    if (get_option('bw_test_hide_raw')) {
        $data = $response->get_data();
        unset($data['content']['raw']);
        $response->set_data($data);
    }
    return $response;
});

add_action('init', function () {
    register_block_type('bw/pre-space', [
        'api_version' => 3,
        'title' => 'Fixture preformatted spacing',
        'category' => 'text',
        'attributes' => ['marker' => ['type' => 'integer', 'default' => 1]],
    ]);
});

add_action('enqueue_block_editor_assets', function () {
    wp_add_inline_script('wp-blocks', <<<'JS'
wp.blocks.registerBlockType('bw/pre-space', {
  apiVersion: 3,
  title: 'Fixture preformatted spacing',
  category: 'text',
  attributes: { marker: { type: 'integer', default: 1 } },
  edit: () => wp.element.createElement('pre', null, 'A  B'),
  save: () => wp.element.createElement('pre', null, 'A  B'),
});
JS, 'after');
});

add_filter('gettext', function ($translated, $text) {
    if (get_option('bw_test_translate') && $text === 'Edit Page') {
        return 'Seite bearbeiten';
    }
    return $translated;
}, 10, 2);

add_action('wp_footer', function () {
    $notice = get_option('bw_test_notice');
    if ($notice === 'german') {
        echo '<div style="position:fixed;bottom:0">Datenschutz <button>Zustimmen</button><button>Ablehnen</button></div>';
    } elseif ($notice === 'tool') {
        echo '<div style="position:fixed;bottom:0">Cookie policy <button>OK</button></div>';
    }
});

function bw_fixture_transform(string $content, string|false $mode): string {
    switch ($mode) {
        case 'comment': return $content . "\n<!-- fixture comment -->";
        case 'class': return str_replace('<p>', '<p class="fixture-class">', $content);
        case 'pre': return str_replace('A  B', 'A B', $content);
        case 'strip_style': return str_replace(' style="color:#123456"', '', $content);
        case 'shortcode': return '[fixture]' . $content . '[/fixture]';
        case 'whitespace': return str_replace("\n\n", "\n", $content);
        case 'entity': return str_replace('A & B', 'A &amp; B', $content);
        case 'cdn': return str_replace('https://example.test/image.png', 'https://cdn.example.test/image.png', $content);
        case 'analytics': return $content . "\n\n<!-- wp:paragraph -->\n<p>Fixture analytics</p>\n<!-- /wp:paragraph -->";
        case 'shape': return serialize_blocks(parse_blocks($content));
    }
    return $content;
}

add_filter('content_save_pre', function ($content) {
    return wp_slash(bw_fixture_transform(wp_unslash($content), get_option('bw_test_transform')));
});

add_filter('wp_insert_post_data', function ($data) {
    if ($data['post_type'] === 'page' && get_option('bw_test_insert_transform')) {
        $data['post_content'] = wp_slash(bw_fixture_transform(wp_unslash($data['post_content']), get_option('bw_test_insert_transform')));
    }
    return $data;
});

add_filter('wp_insert_post_data', function ($data) {
    $field = get_option('bw_test_post_field');
    if ($field === 'post_name') { $data[$field] = 'fixture-rewritten'; }
    if ($field === 'post_status') { $data[$field] = 'pending'; }
    return $data;
});

add_filter('rest_pre_insert_page', function ($prepared) {
    if (get_option('bw_test_rest') === 'reject') {
        return new WP_Error('fixture_linked', 'Fixture linked content cannot save.', ['status' => 403]);
    }
    if (get_option('bw_test_rest') === 'title') { $prepared->post_title = 'Fixture REST title'; }
    return $prepared;
});

add_action('rest_after_insert_page', function ($post) {
    $mode = get_option('bw_test_rest');
    if ($mode === 'erase_meta') { delete_post_meta($post->ID, 'fixture_owned'); }
    if ($mode === 'after_title') { wp_update_post(['ID' => $post->ID, 'post_title' => 'Fixture after title']); }
}, 10, 1);

add_action('save_post_page', function ($id) {
    $delay = (int) get_option('bw_test_delay');
    if ($delay && defined('REST_REQUEST') && REST_REQUEST) { sleep($delay); }
});

add_action('add_meta_boxes', function () {
    if (get_option('bw_test_metabox')) {
        add_meta_box('fixture-panel', 'Fixture panel', function () {
            echo '<label for="fixture_value">Fixture value</label><input id="fixture_value" name="fixture_value" value="Before">';
        }, 'page');
    }
});

add_action('admin_init', function () {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST' || !isset($_POST['fixture_value'])) { return; }
    $mode = get_option('bw_test_metabox');
    if ($mode === 'fail') { status_header(500); exit; }
    if ($mode === 'login') { wp_redirect(wp_login_url()); exit; }
});

add_action('save_post_page', function ($id) {
    if (isset($_POST['fixture_value'])) {
        update_post_meta($id, 'fixture_panel', sanitize_text_field(wp_unslash($_POST['fixture_value'])));
    }
});

add_action('enqueue_block_editor_assets', function () {
    $mode = get_option('bw_test_extension');
    if (!$mode) { return; }
    wp_add_inline_script('wp-edit-post', 'wp.domReady(() => {' . match ($mode) {
        'saving_lock' => 'wp.data.dispatch("core/editor").lockPostSaving("fixture");',
        'autosaving_lock' => 'wp.data.dispatch("core/editor").lockPostAutosaving("fixture");',
        'dirty' => 'let applied=false; let stop=()=>{}; const apply=()=>{const b=wp.data.select("core/block-editor").getBlocks()[0]; if(b && wp.data.select("core/editor").__unstableIsEditorReady() && !applied){applied=true;stop();queueMicrotask(()=>wp.data.dispatch("core/block-editor").updateBlockAttributes(b.clientId,{content:"Fixture changed"}));}}; stop=wp.data.subscribe(apply); apply();',
        'fetch_accessor' => 'let current = window.fetch.bind(window); const proxy=(...args)=>current(...args); Object.defineProperty(window,"fetch",{configurable:true,get(){return proxy;},set(value){current=value;}});',
        'modal' => 'const d=document.createElement("dialog"); d.setAttribute("aria-label","Fixture modal"); d.textContent="Fixture editor notice"; document.body.append(d); d.showModal();',
        default => '',
    } . '});', 'after');
});

add_filter('gettext', function ($translated, $text) {
    return get_option('bw_test_translate_all') && $text !== '' ? 'Übersetzt ' . $text : $translated;
}, 99, 2);

add_action('init', function () {
    register_block_type('bw/fatal', [
        'api_version' => 3,
        'render_callback' => function () { throw new RuntimeException('Fixture render failure'); },
    ]);
    register_block_type('bw/shape', [
        'api_version' => 3,
        'attributes' => ['config' => ['type' => ['object', 'array']]],
        'render_callback' => function () {
            preg_match('/<!-- wp:bw\/shape (.*?) \/-->/', get_post()->post_content, $matches);
            $attributes = json_decode($matches[1] ?? '{}');
            return '<p ' . get_block_wrapper_attributes() . '>' . (is_object($attributes->config ?? null) ? 'Object configuration' : 'Array configuration') . '</p>';
        },
    ]);
});

add_action('enqueue_block_editor_assets', function () {
    wp_add_inline_script('wp-blocks', 'wp.blocks.registerBlockType("bw/shape", {apiVersion:3,title:"Fixture shape",category:"text",attributes:{config:{type:["object","array"]}},edit:()=>null,save:()=>null});', 'after');
});

add_filter('block_editor_settings_all', function ($settings) {
    if (get_option('bw_test_media_fatal')) { throw new ValueError('Fixture media settings failure'); }
    return $settings;
});

add_filter('rest_url_prefix', function ($prefix) {
    return get_option('bw_test_rest_prefix') ? 'fixture-api' : $prefix;
});

add_action('rest_api_init', function () {
    if (get_option('bw_test_stale_schema')) {
        register_post_meta('page', 'fixture_late', ['type' => 'string', 'single' => true, 'show_in_rest' => true]);
    }
});

add_action('enqueue_block_editor_assets', function () {
    $mode = get_option('bw_test_registration');
    if ($mode === 'attributes') {
        wp_add_inline_script('wp-hooks', 'wp.hooks.addFilter("blocks.registerBlockType","fixture/attributes",s=>({...s,attributes:{...s.attributes,fixture_flag:{type:"string",default:"fixture"}}}));', 'after');
    }
    if ($mode === 'extra_class') {
        wp_add_inline_script('wp-hooks', 'wp.hooks.addFilter("blocks.getSaveContent.extraProps","fixture/class",p=>({...p,className:[p.className,"fixture-added"].filter(Boolean).join(" ")}));', 'after');
    }
});

add_filter('render_block_core/image', function ($html) {
    return get_option('bw_test_picture') ? preg_replace('/(<img[^>]*>)/', '<picture>$1</picture>', $html) : $html;
});

add_action('admin_init', function () {
    if (get_option('bw_test_csp')) { header_register_callback(function () { header("Content-Security-Policy: frame-ancestors 'self'; script-src 'self'; object-src 'none'"); }); }
});

add_action('init', function () {
    $base = get_option('bw_test_route');
    if ($base) {
        register_post_type('bw_route', ['label'=>'Fixture records','public'=>true,'show_in_rest'=>true,'rest_namespace'=>'fixture/v1','rest_base'=>$base,'supports'=>['editor','title']]);
    }
});

add_action('admin_init', function () {
    $redirect = get_option('bw_test_redirect');
    if ($redirect === 'frontend') { wp_redirect(home_url('/')); exit; }
    if ($redirect === 'renamed_login') { wp_redirect(home_url('/fixture-login')); exit; }
});

add_action('enqueue_block_editor_assets', function () {
    if (get_option('bw_test_extension') === 'panel') {
        wp_add_inline_script('wp-edit-post', 'wp.plugins.registerPlugin("fixture-panel",{render:()=>wp.element.createElement(wp.editor.PluginDocumentSettingPanel,{name:"fixture",title:"Fixture settings"},wp.element.createElement("p",null,"Fixture panel"))});', 'after');
    }
});

add_action('save_post_page', function ($id) {
    static $running = false;
    if (!$running && isset($_POST['fixture_value']) && get_option('bw_test_metabox') === 'content') {
        $running = true;
        wp_update_post(['ID'=>$id,'post_content'=>get_post($id)->post_content . "\n<!-- Fixture panel changed content -->"]);
    }
});

foreach (['siteurl', 'home'] as $option) {
    add_filter('pre_option_' . $option, function ($value) {
        return get_option('bw_test_installation_url') ?: $value;
    }, PHP_INT_MAX);
}

add_action('init', function () {
    register_block_type('bw/preview-failure', [
        'api_version'=>3,
        'attributes'=>['members'=>['type'=>'array','items'=>['type'=>'string'],'default'=>[]]],
        'render_callback'=>function ($attributes) {
            if (defined('REST_REQUEST') && REST_REQUEST && str_contains($_SERVER['REQUEST_URI'] ?? '', 'block-renderer')) {
                throw new RuntimeException('Fixture dynamic preview failure');
            }
            $items = array_map(static fn(string $label): string => '<li>' . esc_html($label) . '</li>', $attributes['members']);
            return '<div ' . get_block_wrapper_attributes() . '><p>Fixture dynamic output</p><ul>' . implode('', $items) . '</ul></div>';
        },
    ]);
});

add_action('enqueue_block_editor_assets', function () {
    wp_add_inline_script('wp-edit-post', <<<'JS'
wp.blocks.registerBlockType('bw/preview-failure', {
  apiVersion: 3, title: 'Fixture preview failure', category: 'widgets',
  attributes: {members:{type:'array',default:[]}},
  edit: function () {
    const [failed, setFailed] = wp.element.useState(false);
    wp.element.useEffect(() => {
      wp.apiFetch({path:'/wp/v2/block-renderer/bw/preview-failure?context=edit'}).catch(() => setFailed(true));
    }, []);
    return wp.element.createElement('p', null, failed ? 'Fixture preview failed' : 'Fixture preview loading');
  },
  save: () => null,
});
JS, 'after');
});

add_filter('the_content', function ($content) {
    return get_option('bw_test_cached_front') && !(defined('REST_REQUEST') && REST_REQUEST) && !is_admin()
        ? '<p>Fixture stale cached content</p>' : $content;
}, 99);

add_action('rest_pre_serve_request', function ($served, $result, $request) {
    if (get_option('bw_test_php_notice') && in_array($request->get_method(), ['POST','PUT'], true) && str_contains($request->get_route(), '/wp/v2/pages/')) {
        ini_set('display_errors', '1');
        error_reporting(E_ALL);
        trigger_error('Fixture PHP notice before JSON', E_USER_NOTICE);
    }
    return $served;
}, 10, 3);

add_action('save_post_page', function ($id) {
    static $running = false;
    $field = get_option('bw_test_after_field');
    if (!$running && in_array($field, ['post_title','post_name','post_status'], true)) {
        $running = true;
        wp_update_post(['ID'=>$id, $field=>$field === 'post_status' ? 'pending' : 'fixture-after-save']);
    }
});

add_action('admin_init', function () {
    global $pagenow;
    if (get_option('bw_test_redirect') === 'admin_route' && ($_SERVER['REQUEST_METHOD'] ?? '') === 'GET' && $pagenow === 'post.php' && !isset($_GET['fixture_redirected'])) {
        update_option('bw_test_redirect_hits', (int)get_option('bw_test_redirect_hits') + 1);
        wp_safe_redirect(add_query_arg(array_merge(wp_unslash($_GET), ['fixture_redirected'=>'1']), admin_url('post.php')));
        exit;
    }
});

add_action('init', function () {
    if (get_option('bw_test_metabox') === 'stale_registered') {
        add_post_type_support('page', 'custom-fields');
        register_post_meta('page', 'fixture_panel', ['type'=>'string','single'=>true,'show_in_rest'=>true]);
    }
});

add_action('save_post_page', function ($id) {
    if (isset($_POST['fixture_value']) && get_option('bw_test_metabox') === 'cache_exclusion') {
        update_post_meta($id, 'fixture_excluded_url', get_permalink($id));
    }
});

add_action('wp_footer', function () {
    if (get_option('bw_test_notice') !== 'restore_failure') { return; }
    echo '<div id="fixture_notice" style="position:fixed;bottom:0">Cookies <button type="button">Accept</button></div>';
    echo <<<'HTML'
<script>
const fixtureNotice = document.getElementById('fixture_notice');
fixtureNotice.removeAttribute = function (name) {
  if (name === 'data-blockwork-hidden-notice') { throw new Error('Fixture notice cleanup failure'); }
  return Element.prototype.removeAttribute.call(this, name);
};
</script>
HTML;
});

add_action('wp_abilities_api_init', function () {
    blockwork_fixture_ability('blockwork-fixture/multibyte-output', [
        'label'=>'Fixture multibyte output',
        'execute'=>static fn() => ['text'=>str_repeat('界',30000)],
        'permission'=>static fn() => current_user_can('read'),
        'annotations'=>BLOCKWORK_FIXTURE_READ,
    ]);
});

add_filter('rest_pre_serve_request', function ($served, $result, $request) {
    if (get_option('bw_test_ability_html') && $request->get_method() === 'POST' && str_ends_with($request->get_route(), '/blockwork-fixture/set-marker/run')) {
        header('Content-Type: text/html');
        echo '<html><body>Fixture non-JSON response</body></html>';
        return true;
    }
    return $served;
}, 20, 3);

add_action('init', function () {
    if (get_option('bw_test_rendered_getter')) {
        add_post_type_support('page', 'custom-fields');
        register_post_meta('page', 'fixture_rendered', ['type'=>'string','single'=>true,'show_in_rest'=>true]);
    }
});

add_filter('rest_prepare_page', function ($response) {
    if (get_option('bw_test_rendered_getter')) {
        $data = $response->get_data();
        $data['meta']['fixture_rendered'] = isset($data['content']['rendered']) ? 'with_rendered' : 'without_rendered';
        $response->set_data($data);
    }
    return $response;
}, 30);

add_action('enqueue_block_editor_assets', function () {
    if (get_option('bw_test_hierarchy_query')) {
        $ids = wp_json_encode(get_option('bw_test_hierarchy_ids',[]));
        wp_add_inline_script('wp-edit-post', 'wp.domReady(()=>wp.data.resolveSelect("core").getEntityRecords("postType","page",{context:"edit",per_page:100,include:'.$ids.'}).then(records=>{window.fixture_hierarchy_count=records.length;}).catch(()=>{window.fixture_hierarchy_count=-1;}));', 'after');
    }
});

add_action('enqueue_block_editor_assets', function () {
    $mode = get_option('bw_test_pattern_action');
    if ($mode) {
        $replacement = $mode === 'missing' ? 'undefined' : '()=>undefined';
        wp_add_inline_script('wp-edit-post', 'wp.domReady(()=>{const actions=wp.data.dispatch("core/block-editor");actions.__unstableSetTemporarilyEditingAsBlocks='.$replacement.';});', 'after');
    }
});

add_action('rest_api_init', function () {
    if (get_option('bw_test_odd_fields')) {
        register_rest_field('bw_route', 'menu_order', [
            'get_callback'=>static fn($record) => (int)get_post_field('menu_order',$record['id']),
            'update_callback'=>static fn($value,$post) => wp_update_post(['ID'=>$post->ID,'menu_order'=>(int)$value]),
            'schema'=>['type'=>'integer','context'=>['view','edit']],
        ]);
        register_rest_field('bw_route', 'fixture.value', [
            'get_callback'=>static fn() => get_option('bw_test_dot_value','original'),
            'update_callback'=>static fn() => true,
            'schema'=>['type'=>'string','context'=>['view','edit']],
        ]);
    }
});
