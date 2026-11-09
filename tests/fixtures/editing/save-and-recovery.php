<?php

add_action('admin_menu', function (): void {
    add_dashboard_page('Recovery fixture', 'Recovery fixture', 'edit_pages', 'bw-recovery', '__return_null');
});

add_action('admin_enqueue_scripts', function (string $hook): void {
    if ($hook === 'dashboard_page_bw-recovery') {
        wp_enqueue_script('wp-api-fetch');
    }
});
