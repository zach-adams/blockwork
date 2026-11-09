<?php
/** Fixture binding source for the real-editor shared document tests. */
add_action('init', static function () {
    add_post_type_support('page', 'custom-fields');
    register_post_meta('page', 'bw_shared_field', [
        'type' => 'string',
        'single' => true,
        'show_in_rest' => true,
        'auth_callback' => static fn () => current_user_can('edit_posts'),
    ]);
    register_block_bindings_source('blockwork/fixture', [
        'label' => 'Fixture binding',
        'get_value_callback' => static fn () => 'Fixture value',
    ]);
});
add_action('init', static function () {
    register_post_type('bw_shared_item', [
        'label' => 'Shared fixture items',
        'public' => true,
        'show_in_rest' => true,
        'supports' => ['title', 'editor'],
    ]);
});
