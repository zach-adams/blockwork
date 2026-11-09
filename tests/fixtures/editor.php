<?php
/**
 * Seeds disposable native-editor integration scenarios.
 */

require '/wordpress/wp-load.php';

switch_theme('twentytwentyfive');
if (!wp_is_block_theme()) {
    throw new Exception('The fixture requires the bundled Twenty Twenty-Five block theme.');
}

$accounts = ['admin' => get_user_by('login', 'admin')->ID];
wp_set_password(BLOCKWORK_FIXTURE_PASSWORD, $accounts['admin']);
foreach (['editor', 'author', 'subscriber'] as $role) {
    $id = wp_insert_user([
        'user_login' => 'blockwork_' . $role,
        'user_pass' => BLOCKWORK_FIXTURE_PASSWORD,
        'role' => $role,
    ]);
    if (is_wp_error($id)) {
        throw new Exception($id->get_error_message());
    }
    $accounts[$role] = $id;
}

$paragraphs = "<!-- wp:paragraph -->\n<p>Blockwork fixture.</p>\n<!-- /wp:paragraph -->\n\n"
    . "<!-- wp:paragraph -->\n<p>Keep this paragraph.</p>\n<!-- /wp:paragraph -->";
$documents = [];
foreach (['roundtrip', 'stale', 'lock', 'revocation', 'permission'] as $scenario) {
    $id = wp_insert_post([
        'post_type' => $scenario === 'permission' ? 'post' : 'page',
        'post_status' => 'draft',
        'post_author' => $scenario === 'permission' ? $accounts['author'] : $accounts['admin'],
        'post_title' => 'Blockwork integration ' . $scenario,
        'post_content' => $paragraphs,
    ], true);
    if (is_wp_error($id)) {
        throw new Exception($id->get_error_message());
    }
    $documents[$scenario] = ['post_id' => $id, 'post_type' => get_post_type($id)];
}

foreach (['wp_template', 'wp_template_part', 'wp_navigation'] as $type) {
    $slug = 'blockwork-integration-' . str_replace('wp_', '', $type);
    $content = $type === 'wp_navigation'
        ? '<!-- wp:navigation-link {"label":"Fixture link","url":"https://example.test/"} /-->'
        : $paragraphs;
    $id = wp_insert_post([
        'post_type' => $type,
        'post_status' => 'publish',
        'post_author' => $accounts['admin'],
        'post_name' => $slug,
        'post_title' => 'Blockwork integration ' . $type,
        'post_content' => $content,
    ], true);
    if (is_wp_error($id)) {
        throw new Exception($id->get_error_message());
    }
    if ($type !== 'wp_navigation') {
        wp_set_object_terms($id, 'twentytwentyfive', 'wp_theme');
    }
    if ($type === 'wp_template_part') {
        wp_set_object_terms($id, 'header', 'wp_template_part_area');
    }
    $documents[$type] = [
        'post_id' => $type === 'wp_navigation' ? $id : 'twentytwentyfive//' . $slug,
        'post_type' => $type,
        'wp_id' => $id,
    ];
}

update_option('blockwork_fixture_page_id', $documents['roundtrip']['post_id'], false);
update_option('blockwork_fixture_accounts', $accounts, false);
update_option('blockwork_fixture_documents', $documents, false);
