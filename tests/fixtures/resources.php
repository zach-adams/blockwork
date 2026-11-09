<?php
/**
 * Rewrites disposable resource upload titles during attachment creation.
 */

add_action('add_attachment', function (int $id): void {
    $title = str_replace('-', ' ', strtolower(get_post_field('post_title', $id)));

    if (!str_starts_with($title, 'blockwork resource')) {
        return;
    }

    $rewrites = get_option('blockwork_fixture_resource_rewrites', []);
    $rewrites[$id] = $title;
    update_option('blockwork_fixture_resource_rewrites', $rewrites, false);
    wp_update_post(['ID' => $id, 'post_title' => $title]);
});
