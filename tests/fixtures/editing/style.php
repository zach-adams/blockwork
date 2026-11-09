<?php
/**
 * Supplies Button hover styles and an opt-in filtered editing account.
 */

add_action('init', function () {
    register_block_style('core/button', [
        'name' => 'bw-hover',
        'label' => 'Fixture hover',
        'inline_style' => '.wp-block-button.is-style-bw-hover .wp-block-button__link:hover { background-color: rgb(0, 128, 0); }',
    ]);
});

add_filter('map_meta_cap', function ($caps, $cap) {
    if (get_option('bw_style_filtered_account') && in_array($cap, ['edit_css', 'unfiltered_html'], true)) {
        return ['do_not_allow'];
    }
    return $caps;
}, 10, 2);
