<?php
/**
 * Performs bounded mutations and observations on disposable fixture records.
 */

require '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/post.php';
$accounts = get_option('blockwork_fixture_accounts');
$documents = get_option('blockwork_fixture_documents');
$document = $documents[$input['document'] ?? 'roundtrip'];
$id = $document['wp_id'] ?? $document['post_id'];
$account = $accounts[$input['account'] ?? 'admin'];
wp_set_current_user($accounts['admin']);

switch ($input['action']) {
    case 'snapshot':
        break;
    case 'credentials':
        if (!wp_check_password($input['password'], get_userdata($account)->user_pass, $account)) {
            throw new Exception('Generated fixture credentials no longer match the WordPress account.');
        }
        break;
    case 'external_edit':
        $result = wp_update_post([
            'ID' => $id,
            'post_content' => "<!-- wp:paragraph -->\n<p>External writer wins.</p>\n<!-- /wp:paragraph -->",
        ], true);
        if (is_wp_error($result)) {
            throw new Exception($result->get_error_message());
        }
        break;
    case 'lock':
        wp_set_current_user($accounts['editor']);
        wp_set_post_lock($id);
        wp_set_current_user($accounts['admin']);
        break;
    case 'revoke':
        WP_Session_Tokens::get_instance($account)->destroy_all();
        break;
    case 'restrict':
        (new WP_User($accounts['author']))->set_role('subscriber');
        break;
    default:
        throw new Exception('Unknown fixture action.');
}

$post = get_post($id);
echo json_encode([
    'id' => $id,
    'status' => $post->post_status,
    'content' => $post->post_content,
    'lock' => get_post_meta($id, '_edit_lock', true),
    'other_lock_user_id' => wp_check_post_lock($id),
    'author_can_edit' => user_can($accounts['author'], 'edit_post', $documents['permission']['post_id']),
    'session_count' => count(WP_Session_Tokens::get_instance($account)->get_all()),
]);
