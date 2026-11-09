<?php
/**
 * Registers document fixtures for real-editor tests.
 */

add_action('init', function () {
    $types = [
        'bw_template' => ['template' => [['core/paragraph', ['placeholder' => 'Template']]]],
        'bw_locked' => ['template' => [['core/paragraph']], 'template_lock' => 'all'],
        'bw_no_editor' => ['supports' => ['title']],
        'bw_hidden' => ['show_in_rest' => false],
        'bw_base' => ['rest_base' => 'library'],
        'bw_namespace' => ['rest_namespace' => 'fixture/v1'],
        'bw_no_revision' => ['supports' => ['title', 'editor']],
        'bw_hierarchical' => ['hierarchical' => true, 'supports' => ['title', 'editor', 'page-attributes', 'revisions']],
    ];
    if (get_option('bw_unusual_routes')) {
        $types['bw_dot'] = ['rest_base' => 'items.v2'];
        $types['bw_path'] = ['rest_base' => 'library/items', 'rest_namespace' => 'fixture/v1'];
    }
    foreach ($types as $name => $options) {
        register_post_type($name, array_merge([
            'label' => $name,
            'public' => true,
            'show_in_rest' => true,
            'supports' => ['title', 'editor', 'custom-fields', 'revisions'],
        ], $options));
    }
    register_taxonomy('bw_topic', ['post', 'page'], ['label' => 'Topics', 'public' => true, 'show_in_rest' => true]);
    foreach (['string', 'integer', 'boolean', 'array', 'object'] as $type) {
        $schema = ['type' => $type];
        if ($type === 'array') {
            $schema['items'] = ['type' => 'string'];
        }
        if ($type === 'object') {
            $schema['properties'] = ['note' => ['type' => 'string']];
        }
        register_post_meta('page', 'bw_' . $type, [
            'type' => $type,
            'single' => true,
            'show_in_rest' => ['schema' => $schema],
        ]);
    }
    if (get_option('bw_denied_meta')) {
        register_post_meta('page', 'bw_denied', [
            'type' => 'string', 'single' => true, 'show_in_rest' => true,
            'auth_callback' => '__return_false',
        ]);
    }
});

add_filter('wp_revisions_to_keep', function ($count) {
    return get_option('bw_disable_revisions') ? 0 : $count;
});

add_action('rest_after_insert_page', function ($post) {
    if (get_option('bw_rewrite_meta')) {
        update_post_meta($post->ID, 'bw_string', 'plugin-value');
    }
});

add_filter('wp_handle_upload_prefilter', function ($file) {
    if (get_option('bw_rename_upload')) {
        $file['name'] = 'renamed-' . $file['name'];
    }
    return $file;
});

add_filter('wp_handle_upload', function ($upload) {
    if (get_option('bw_recompress_upload') && $upload['type'] === 'image/png') {
        $image = imagecreatefrompng($upload['file']);
        imagepng($image, $upload['file'], 9);
    }
    return $upload;
});

add_filter('wp_handle_upload', function ($upload) {
    if (get_option('bw_convert_upload') && $upload['type'] === 'image/png') {
        $image = imagecreatefrompng($upload['file']);
        $converted = preg_replace('/\.png$/i', '.jpg', $upload['file']);
        imagejpeg($image, $converted);
        $upload['file'] = $converted;
        $upload['url'] = preg_replace('/\.png$/i', '.jpg', $upload['url']);
        $upload['type'] = 'image/jpeg';
    }
    return $upload;
});

add_action('template_redirect', function () {
    if (isset($_GET['bw_fixture_redirect'])) {
        wp_safe_redirect(get_permalink(absint($_GET['bw_fixture_redirect'])));
        exit;
    }
});

add_action('add_meta_boxes', function () {
    if (get_option('bw_document_metabox')) {
        add_meta_box('bw-document-meta', 'Fixture meta input', function ($post) {
            echo '<label for="bw-meta-input">Fixture value</label><input id="bw-meta-input" name="meta_input[bw_string]" value="' . esc_attr(get_post_meta($post->ID, 'bw_string', true)) . '">';
        }, 'page');
    }
});

add_filter('theme_page_templates', function ($templates) {
    if (get_option('bw_document_template')) {
        $templates['bw-fixture.php'] = 'Fixture template';
    }
    return $templates;
});

add_action('init', function () {
    register_term_meta('bw_topic', 'bw_term_label', [
        'type' => 'string', 'single' => true, 'show_in_rest' => true,
    ]);
});

add_action('admin_enqueue_scripts', function ($hook) {
    if ($hook === 'profile.php') {
        wp_enqueue_script('wp-api-fetch');
    }
});

add_action('save_post_page', function ($id) {
    if (!get_option('bw_document_metabox') || !isset($_POST['meta_input']['bw_string'], $_POST['_wpnonce'])) {
        return;
    }
    if (!is_string($_POST['meta_input']['bw_string']) || !is_string($_POST['_wpnonce'])) {
        return;
    }
    if (!current_user_can('edit_post', $id) || !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['_wpnonce'])), 'update-post_' . $id)) {
        return;
    }
    update_post_meta($id, 'bw_string', sanitize_text_field(wp_unslash($_POST['meta_input']['bw_string'])));
});

add_filter('upload_mimes', function ($mimes) {
    if (get_option('bw_allow_svg')) {
        $mimes['svg'] = 'image/svg+xml';
    }
    return $mimes;
});

add_action('rest_after_insert_attachment', function ($post, $request, $creating) {
    if ($creating && get_option('bw_rewrite_upload_text')) {
        wp_update_post(['ID' => $post->ID, 'post_title' => 'Plugin title', 'post_excerpt' => 'Plugin caption']);
    }
}, 10, 3);
