<?php
// ACF field groups and a block like a site's, so cases cover what ACF's meta box
// form and block previews do around a save. Inert unless ACF is active.

$blockwork_field = fn ($name, $type, $extra = []) => [
    'key' => "field_blockwork_$name",
    'label' => $name,
    'name' => "blockwork_$name",
    'type' => $type,
] + $extra;

add_action('acf/init', function () use ($blockwork_field) {
    $choices = ['choices' => ['a' => 'A', 'b' => 'B']];

    // Shown in REST as the acf field, as a group with "Show in REST API" turned on is.
    acf_add_local_field_group([
        'key' => 'group_blockwork_fixture',
        'title' => 'Blockwork fixture fields',
        'show_in_rest' => 1,
        'location' => [[['param' => 'post_type', 'operator' => '==', 'value' => 'page']]],
        'fields' => [
            $blockwork_field('text', 'text', ['default_value' => 'Default text']),
            $blockwork_field('textarea', 'textarea'),
            $blockwork_field('number', 'number'),
            $blockwork_field('email', 'email'),
            $blockwork_field('url', 'url'),
            $blockwork_field('toggle', 'true_false', ['default_value' => 1, 'ui' => 1]),
            $blockwork_field('select', 'select', $choices + ['multiple' => 1, 'ui' => 1]),
            $blockwork_field('checkbox', 'checkbox', $choices),
            $blockwork_field('radio', 'radio', $choices + ['default_value' => 'b']),
            $blockwork_field('buttons', 'button_group', $choices),
            $blockwork_field('image', 'image', ['return_format' => 'array']),
            $blockwork_field('file', 'file', ['return_format' => 'id']),
            $blockwork_field('gallery', 'gallery'),
            $blockwork_field('link', 'link'),
            $blockwork_field('wysiwyg', 'wysiwyg'),
            $blockwork_field('related', 'relationship', ['post_type' => ['page']]),
            $blockwork_field('object', 'post_object', ['post_type' => ['page'], 'allow_null' => 1]),
            $blockwork_field('date', 'date_picker'),
            $blockwork_field('color', 'color_picker'),
            $blockwork_field('note', 'message', ['message' => 'Fixture note']),
            $blockwork_field('group', 'group', ['sub_fields' => [$blockwork_field('group_text', 'text')]]),
            $blockwork_field('rows', 'repeater', ['sub_fields' => [$blockwork_field('row_text', 'text')]]),
            $blockwork_field('layouts', 'flexible_content', [
                'layouts' => [
                    'layout_blockwork' => [
                        'key' => 'layout_blockwork',
                        'name' => 'blockwork_layout',
                        'label' => 'Layout',
                        'display' => 'block',
                        'sub_fields' => [$blockwork_field('layout_text', 'text')],
                    ],
                ],
            ]),
        ],
    ]);

    // Saves its terms as the post's categories, so its form writes a core field.
    acf_add_local_field_group([
        'key' => 'group_blockwork_terms',
        'title' => 'Blockwork fixture terms',
        'show_in_rest' => 1,
        'location' => [[['param' => 'post_type', 'operator' => '==', 'value' => 'post']]],
        'fields' => [
            $blockwork_field('terms', 'taxonomy', [
                'taxonomy' => 'category',
                'field_type' => 'checkbox',
                'save_terms' => 1,
                'load_terms' => 1,
                'add_term' => 0,
            ]),
        ],
    ]);

    if (get_option('bw_acf_required')) {
        acf_add_local_field_group([
            'key' => 'group_blockwork_required',
            'title' => 'Blockwork required field',
            'location' => [[['param' => 'post_type', 'operator' => '==', 'value' => 'page']]],
            'fields' => [$blockwork_field('required', 'text', ['required' => 1])],
        ]);
    }

    acf_add_local_field_group([
        'key' => 'group_blockwork_card',
        'title' => 'Blockwork card',
        'location' => [[['param' => 'block', 'operator' => '==', 'value' => 'acf/blockwork-card']]],
        'fields' => [
            $blockwork_field('card_heading', 'text'),
            $blockwork_field('card_featured', 'true_false'),
        ],
    ]);
});

// A block.json ACF block with InnerBlocks, written here because a must-use
// plugin is a single file.
add_action('init', function () {
    if (!function_exists('acf_get_block_types')) {
        return;
    }

    $directory = WP_CONTENT_DIR . '/blockwork-acf/card';

    if (!file_exists("$directory/block.json")) {
        wp_mkdir_p($directory);
        file_put_contents("$directory/block.json", wp_json_encode([
            'apiVersion' => 3,
            'name' => 'acf/blockwork-card',
            'title' => 'Blockwork card',
            'category' => 'text',
            'supports' => ['jsx' => true, 'mode' => true, 'align' => true],
            'acf' => ['mode' => 'preview', 'renderTemplate' => 'render.php', 'blockVersion' => 3],
        ]));
        file_put_contents(
            "$directory/render.php",
            '<div <?php echo get_block_wrapper_attributes(["class" => "blockwork-card"]); ?>><h3><?php echo esc_html(get_field("blockwork_card_heading") ?: "Untitled"); ?></h3><InnerBlocks /></div>',
        );
    }

    register_block_type($directory);
});
