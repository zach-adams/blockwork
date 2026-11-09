<?php
/**
 * Registers disposable Abilities API scenarios that copy how plugins expose abilities.
 */

if (!function_exists('wp_register_ability')) {
    return;
}

/*
 * Annotations as readonly, destructive, idempotent. Core routes the first
 * through GET, the last through DELETE, and the others through POST.
 */
const BLOCKWORK_FIXTURE_READ = [true, false, true];
const BLOCKWORK_FIXTURE_WRITE = [false, false, false];
const BLOCKWORK_FIXTURE_UPDATE = [false, false, true];
const BLOCKWORK_FIXTURE_DESTRUCTIVE = [false, true, true];

/**
 * Registers one fixture ability in the category named after its namespace.
 *
 * Every execution of an ability that is not read-only is appended to the
 * `blockwork_fixture_calls` option first, so a test can prove it ran once or never.
 *
 * @param string $name Ability name.
 * @param array  $args {
 *     Ability arguments.
 *
 *     @type string     $label       Label.
 *     @type string     $description Optional. Description. Default is the label.
 *     @type array      $input       Optional. Input schema. Default none.
 *     @type array      $output      Optional. Output schema. Default any object.
 *     @type callable   $execute     Execute callback.
 *     @type callable   $permission  Permission callback.
 *     @type array|null $annotations Optional. An annotation constant. Default null, which declares none.
 *     @type bool       $exposed     Optional. Whether REST and MCP clients may see it. Default true.
 * }
 */
function blockwork_fixture_ability($name, $args) {
    $annotations = $args['annotations'] ?? null;
    $exposed = $args['exposed'] ?? true;
    $execute = $args['execute'];
    $meta = ['show_in_rest' => $exposed, 'public' => $exposed, 'mcp' => ['public' => $exposed]];
    if ($annotations !== null) {
        $meta['annotations'] = array_combine(['readonly', 'destructive', 'idempotent'], $annotations);
    }

    $recorded = static function ($input = null) use ($name, $execute) {
        $calls = get_option('blockwork_fixture_calls', []);
        $calls[] = $name;
        update_option('blockwork_fixture_calls', $calls, false);

        return $execute($input);
    };

    wp_register_ability($name, [
        'label' => $args['label'],
        'description' => $args['description'] ?? $args['label'] . '.',
        'category' => strtok($name, '/'),
        'input_schema' => $args['input'] ?? [],
        'output_schema' => $args['output'] ?? ['type' => 'object'],
        'execute_callback' => empty($annotations[0]) ? $recorded : $execute,
        'permission_callback' => $args['permission'],
        'meta' => $meta,
    ]);
}

/**
 * Returns the book meta schemas, shared by meta registration and ability input.
 *
 * @return array Schemas by meta key.
 */
function blockwork_fixture_book_fields() {
    return [
        'isbn' => ['type' => 'string'],
        'rating' => ['type' => 'integer', 'minimum' => 0, 'maximum' => 5],
        'featured' => ['type' => 'boolean'],
        'tags' => ['type' => 'array', 'items' => ['type' => 'string']],
        'dimensions' => [
            'type' => 'object',
            'properties' => ['width' => ['type' => 'number'], 'height' => ['type' => 'number']],
        ],
    ];
}

/**
 * Runs an inner REST request on the book routes, as ACF's abilities do.
 *
 * @param string $method HTTP method.
 * @param string $path   Path after the collection, such as `/5`.
 * @param array  $params Request parameters.
 * @return WP_REST_Response|WP_Error The response, or the REST error with its code and status.
 */
function blockwork_fixture_book_request($method, $path, $params = []) {
    $request = new WP_REST_Request($method, '/wp/v2/blockwork-books' . $path);
    foreach ($params as $key => $value) {
        $request->set_param($key, $value);
    }
    $response = rest_do_request($request);

    return $response->is_error() ? $response->as_error() : $response;
}

/**
 * Maps a book's REST record to the item the book abilities return.
 *
 * @param array $book REST record in the edit context.
 * @return array Item with id, title, status, and fields.
 */
function blockwork_fixture_book_item($book) {
    return [
        'id' => $book['id'],
        'title' => $book['title']['raw'],
        'status' => $book['status'],
        'fields' => array_intersect_key($book['meta'], blockwork_fixture_book_fields()),
    ];
}

/**
 * Checks the post an SEO ability names. A missing post reaches execution, which reports it.
 *
 * @param array $input Ability input.
 * @return bool Whether the current user may edit the post.
 */
function blockwork_fixture_can_edit_post($input) {
    $post_id = (int) ($input['post_id'] ?? 0);

    return get_post($post_id) ? current_user_can('edit_post', $post_id) : current_user_can('edit_posts');
}

add_action('init', static function () {
    // No editor support, so Blockwork's document discovery stays unchanged.
    register_post_type('blockwork_book', [
        'labels' => ['name' => 'Books', 'singular_name' => 'Book'],
        'public' => false,
        'show_ui' => true,
        'show_in_rest' => true,
        'rest_base' => 'blockwork-books',
        'supports' => ['title', 'custom-fields'],
    ]);
    foreach (blockwork_fixture_book_fields() as $key => $schema) {
        register_post_meta('blockwork_book', $key, [
            'single' => true,
            'type' => $schema['type'],
            'show_in_rest' => ['schema' => $schema],
        ]);
    }
});

add_action('wp_abilities_api_categories_init', static function () {
    foreach (['blockwork-fixture', 'blockwork-seo', 'blockwork-fields'] as $slug) {
        wp_register_ability_category($slug, [
            'label' => $slug,
            'description' => 'Disposable Blockwork fixture abilities.',
        ]);
    }
});

// Always registered and exposed: one ability per transport or failure case.
add_action('wp_abilities_api_init', static function () {
    $can_read = static fn() => current_user_can('read');
    $can_manage = static fn() => current_user_can('manage_options');

    blockwork_fixture_ability('blockwork-fixture/echo', [
        'label' => 'Echo input',
        // Long, and addressed to an agent, as real plugin descriptions are.
        'description' => 'Echoes the supplied JSON values without changing them so integration tests can verify'
            . ' WordPress REST schema handling, including nested objects, arrays, integers, and booleans. The'
            . ' ability is read-only and does not persist input. An AI agent should inspect the requested'
            . ' values and ask the user for confirmation before calling this ability. This description is'
            . ' long enough to exercise clients that shorten ability descriptions. FIXTURE-DESCRIPTION-END',
        'input' => [
            'type' => 'object',
            'properties' => [
                'text' => ['type' => 'string'],
                'count' => ['type' => 'integer'],
                'flag' => ['type' => 'boolean'],
                'list' => ['type' => 'array', 'items' => ['type' => 'integer']],
                'nested' => [
                    'type' => 'object',
                    'properties' => [
                        'label' => ['type' => 'string'],
                        'items' => ['type' => 'array', 'items' => ['type' => 'string']],
                    ],
                ],
            ],
        ],
        'execute' => static fn($input) => ['input' => $input, 'types' => array_map('gettype', (array) $input)],
        'permission' => $can_read,
        'annotations' => BLOCKWORK_FIXTURE_READ,
    ]);

    blockwork_fixture_ability('blockwork-fixture/large-output', [
        'label' => 'Large output',
        'input' => [
            'type' => 'object',
            'properties' => ['bytes' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 2000000]],
            'required' => ['bytes'],
        ],
        'execute' => static fn($input) => ['text' => str_repeat('a', $input['bytes'])],
        'permission' => $can_read,
        'annotations' => BLOCKWORK_FIXTURE_READ,
    ]);

    blockwork_fixture_ability('blockwork-fixture/set-marker', [
        'label' => 'Set marker',
        'description' => 'Sets a fixture option after an optional delay.',
        'input' => [
            'type' => 'object',
            'properties' => [
                'value' => ['type' => 'string', 'maxLength' => 100],
                'delay_ms' => ['type' => 'integer', 'minimum' => 0, 'maximum' => 40000, 'default' => 0],
                // A rule only WordPress can apply: clients have no PHP regex engine.
                'code' => ['type' => 'string', 'pattern' => '^[a-z]+$'],
            ],
            'required' => ['value'],
        ],
        'execute' => static function ($input) {
            usleep(($input['delay_ms'] ?? 0) * 1000);
            // A plugin's own failure inside a successful response, as WP Rocket reports them.
            if ($input['value'] === 'reject') {
                return ['success' => false, 'error' => 'Marker rejected.'];
            }
            update_option('blockwork_fixture_marker', $input['value'], false);

            return ['success' => true, 'value' => $input['value']];
        },
        'permission' => $can_manage,
        'annotations' => BLOCKWORK_FIXTURE_WRITE,
    ]);

    blockwork_fixture_ability('blockwork-fixture/configure', [
        'label' => 'Configure fixture',
        'description' => 'Turns the SEO and book-field ability groups on or off for later requests.',
        'input' => [
            'type' => 'object',
            'properties' => ['seo_exposed' => ['type' => 'boolean'], 'fields_enabled' => ['type' => 'boolean']],
            'additionalProperties' => false,
        ],
        'execute' => static function ($input) {
            foreach ($input as $name => $enabled) {
                update_option('blockwork_fixture_' . $name, (int) $enabled, false);
            }

            return [
                'seo_exposed' => (bool) get_option('blockwork_fixture_seo_exposed'),
                'fields_enabled' => (bool) get_option('blockwork_fixture_fields_enabled'),
            ];
        },
        'permission' => $can_manage,
        'annotations' => BLOCKWORK_FIXTURE_WRITE,
    ]);

    blockwork_fixture_ability('blockwork-fixture/state', [
        'label' => 'Fixture state',
        'description' => 'Reports what the fixture abilities wrote and how often each one that is not read-only ran.',
        'execute' => static fn() => [
            'marker' => get_option('blockwork_fixture_marker', null),
            'counter' => (int) get_option('blockwork_fixture_counter', 0),
            'calls' => (object) array_count_values(get_option('blockwork_fixture_calls', [])),
        ],
        'permission' => $can_manage,
        'annotations' => BLOCKWORK_FIXTURE_READ,
    ]);

    blockwork_fixture_ability('blockwork-fixture/unannotated', [
        'label' => 'Unannotated counter',
        'execute' => static function () {
            $counter = (int) get_option('blockwork_fixture_counter', 0) + 1;
            update_option('blockwork_fixture_counter', $counter, false);

            return ['counter' => $counter];
        },
        'permission' => $can_manage,
        'annotations' => null,
    ]);

    blockwork_fixture_ability('blockwork-fixture/broken-output', [
        'label' => 'Broken output',
        'description' => 'Writes an option, then returns output that fails its own schema.',
        'output' => [
            'type' => 'object',
            'properties' => ['success' => ['type' => 'boolean']],
            'required' => ['success'],
        ],
        'execute' => static function () {
            update_option('blockwork_fixture_broken', 'written', false);

            return 'invalid';
        },
        'permission' => $can_manage,
        'annotations' => BLOCKWORK_FIXTURE_WRITE,
    ]);

    blockwork_fixture_ability('blockwork-fixture/fail', [
        'label' => 'Fail',
        'input' => [
            'type' => 'object',
            'default' => [],
            'properties' => ['status' => ['type' => 'integer', 'default' => 500]],
        ],
        'execute' => static fn($input) => new WP_Error(
            'blockwork_fixture_failed',
            'Fixture failure with private detail.',
            ['status' => $input['status'] ?? 500]
        ),
        'permission' => $can_manage,
        'annotations' => BLOCKWORK_FIXTURE_WRITE,
    ]);

    blockwork_fixture_ability('blockwork-fixture/nonce-error', [
        'label' => 'Nonce error',
        // wp.apiFetch answers this code by refreshing its nonce and sending the request again.
        'description' => 'Returns the invalid-nonce error from its own code, after it ran.',
        'execute' => static fn() => new WP_Error(
            'rest_cookie_invalid_nonce',
            'Private nonce detail.',
            ['status' => 403]
        ),
        'permission' => $can_manage,
        'annotations' => BLOCKWORK_FIXTURE_WRITE,
    ]);

    blockwork_fixture_ability('blockwork-fixture/denied', [
        'label' => 'Denied',
        'execute' => static fn() => [],
        'permission' => static fn() => new WP_Error('blockwork_fixture_denied', 'Private denial detail.'),
        'annotations' => BLOCKWORK_FIXTURE_READ,
    ]);
});

/*
 * SEOPress registers its abilities on every site and hides them from REST and
 * MCP until a setting is on. It marks updates destructive and idempotent.
 */
add_action('wp_abilities_api_init', static function () {
    $exposed = (bool) get_option('blockwork_fixture_seo_exposed');
    $post_id = ['type' => 'integer'];
    $read_meta = static fn($id) => [
        'post_id' => $id,
        'title' => (string) get_post_meta($id, '_blockwork_seo_title', true),
        'description' => (string) get_post_meta($id, '_blockwork_seo_description', true),
    ];

    blockwork_fixture_ability('blockwork-seo/get-post-title-description', [
        'label' => 'Get post title and description',
        'input' => ['type' => 'object', 'properties' => ['post_id' => $post_id], 'required' => ['post_id']],
        'execute' => static fn($input) => get_post($input['post_id'])
            ? $read_meta($input['post_id'])
            : new WP_Error('blockwork_seo_post_not_found', 'Post not found.', ['status' => 404]),
        'permission' => 'blockwork_fixture_can_edit_post',
        'annotations' => BLOCKWORK_FIXTURE_READ,
        'exposed' => $exposed,
    ]);

    blockwork_fixture_ability('blockwork-seo/update-post-title-description', [
        'label' => 'Update post title and description',
        'input' => [
            'type' => 'object',
            'properties' => [
                'post_id' => $post_id,
                'title' => ['type' => 'string', 'maxLength' => 70],
                'description' => ['type' => 'string', 'maxLength' => 160],
            ],
            'required' => ['post_id'],
        ],
        'execute' => static function ($input) use ($read_meta) {
            $updated = array_keys(array_intersect_key($input, ['title' => true, 'description' => true]));
            if (!$updated) {
                return new WP_Error('blockwork_seo_nothing_to_update', 'Nothing to update.', ['status' => 400]);
            }
            foreach ($updated as $key) {
                update_post_meta($input['post_id'], '_blockwork_seo_' . $key, $input[$key]);
            }

            return $read_meta($input['post_id']) + ['updated' => $updated];
        },
        'permission' => 'blockwork_fixture_can_edit_post',
        'annotations' => BLOCKWORK_FIXTURE_DESTRUCTIVE,
        'exposed' => $exposed,
    ]);

    blockwork_fixture_ability('blockwork-seo/list-posts-missing-metadata', [
        'label' => 'List posts missing SEO metadata',
        'input' => [
            'type' => 'object',
            'default' => [],
            'properties' => [
                'post_types' => ['type' => 'array', 'items' => ['type' => 'string'], 'default' => ['post', 'page']],
                'missing' => [
                    'type' => 'array',
                    'items' => ['type' => 'string', 'enum' => ['title', 'description']],
                    'default' => ['title', 'description'],
                ],
                'per_page' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 50, 'default' => 10],
                'page' => ['type' => 'integer', 'minimum' => 1, 'default' => 1],
            ],
        ],
        'execute' => static function ($input) {
            // An unknown type must match nothing instead of widening the query to every type.
            $types = array_filter($input['post_types'] ?? ['post', 'page'], 'post_type_exists');
            $ids = get_posts([
                'post_type' => $types ?: ['blockwork_no_such_type'],
                'post_status' => ['publish', 'draft', 'pending', 'private', 'future'],
                'posts_per_page' => -1,
                'fields' => 'ids',
            ]);
            $items = [];
            foreach ($ids as $id) {
                $missing = array_values(array_filter(
                    $input['missing'] ?? ['title', 'description'],
                    static fn($key) => '' === (string) get_post_meta($id, '_blockwork_seo_' . $key, true)
                ));
                if ($missing && current_user_can('edit_post', $id)) {
                    $items[] = [
                        'post_id' => $id,
                        'post_type' => get_post_type($id),
                        'title' => get_the_title($id),
                        'missing' => $missing,
                    ];
                }
            }
            $per_page = $input['per_page'] ?? 10;
            $page = $input['page'] ?? 1;

            return [
                'items' => array_slice($items, ($page - 1) * $per_page, $per_page),
                'total' => count($items),
                'page' => $page,
            ];
        },
        'permission' => static fn() => current_user_can('edit_posts'),
        'annotations' => BLOCKWORK_FIXTURE_READ,
        'exposed' => $exposed,
    ]);

    blockwork_fixture_ability('blockwork-seo/update-post-robots-settings', [
        'label' => 'Update post robots settings',
        'input' => [
            'type' => 'object',
            'properties' => ['post_id' => $post_id, 'noindex' => ['type' => 'boolean']],
            'required' => ['post_id', 'noindex'],
        ],
        'execute' => static function ($input) {
            // Before WordPress 7.1, core passes query input on as strings, so false arrives as "false".
            $noindex = rest_sanitize_boolean($input['noindex']);
            update_post_meta($input['post_id'], '_blockwork_seo_noindex', (int) $noindex);

            return [
                'post_id' => $input['post_id'],
                'noindex' => (bool) get_post_meta($input['post_id'], '_blockwork_seo_noindex', true),
            ];
        },
        'permission' => 'blockwork_fixture_can_edit_post',
        'annotations' => BLOCKWORK_FIXTURE_DESTRUCTIVE,
        'exposed' => $exposed,
    ]);
});

/*
 * ACF registers nothing until its AI flag is on, then generates abilities per
 * post type that run an inner REST request. Permission is the type's general
 * capability, so a per-post refusal comes back from the ability's own code.
 */
add_action('wp_abilities_api_init', static function () {
    if (!get_option('blockwork_fixture_fields_enabled')) {
        return;
    }

    $fields = ['type' => 'object', 'properties' => blockwork_fixture_book_fields()];
    $id = ['type' => 'integer'];
    $status = ['type' => 'string', 'enum' => ['draft', 'publish']];
    $paging = [
        'per_page' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 50, 'default' => 10],
        'page' => ['type' => 'integer', 'minimum' => 1, 'default' => 1],
    ];
    $can_edit = static fn() => current_user_can(get_post_type_object('blockwork_book')->cap->edit_posts);
    $item = static fn($response) => is_wp_error($response)
        ? $response
        : blockwork_fixture_book_item($response->get_data());

    blockwork_fixture_ability('blockwork-fields/field-groups', [
        'label' => 'Book field groups',
        'execute' => static fn() => ['groups' => [[
            'post_type' => 'blockwork_book',
            'fields' => array_map(
                static fn($name, $schema) => ['name' => $name, 'type' => $schema['type']],
                array_keys(blockwork_fixture_book_fields()),
                blockwork_fixture_book_fields()
            ),
        ]]],
        'permission' => $can_edit,
        'annotations' => BLOCKWORK_FIXTURE_READ,
    ]);

    blockwork_fixture_ability('blockwork-fields/books', [
        'label' => 'Query books',
        'input' => ['type' => 'object', 'default' => [], 'properties' => ['search' => ['type' => 'string']] + $paging],
        'execute' => static function ($input) {
            $response = blockwork_fixture_book_request('GET', '', (array) $input + [
                'context' => 'edit',
                'status' => ['draft', 'publish', 'pending', 'private'],
            ]);
            if (is_wp_error($response)) {
                return $response;
            }

            return [
                'items' => array_map('blockwork_fixture_book_item', $response->get_data()),
                'total' => (int) $response->get_headers()['X-WP-Total'],
            ];
        },
        'permission' => $can_edit,
        'annotations' => BLOCKWORK_FIXTURE_READ,
    ]);

    blockwork_fixture_ability('blockwork-fields/create-book', [
        'label' => 'Create a book',
        'input' => [
            'type' => 'object',
            'properties' => [
                'title' => ['type' => 'string'],
                'status' => $status + ['default' => 'draft'],
                'fields' => $fields,
            ],
            'required' => ['title'],
        ],
        'execute' => static fn($input) => $item(blockwork_fixture_book_request('POST', '', [
            'title' => $input['title'],
            'status' => $input['status'] ?? 'draft',
            'meta' => $input['fields'] ?? [],
        ])),
        'permission' => $can_edit,
        'annotations' => BLOCKWORK_FIXTURE_WRITE,
    ]);

    blockwork_fixture_ability('blockwork-fields/view-book', [
        'label' => 'View a book',
        'input' => ['type' => 'object', 'properties' => ['id' => $id], 'required' => ['id']],
        'execute' => static fn($input) => $item(
            blockwork_fixture_book_request('GET', '/' . $input['id'], ['context' => 'edit'])
        ),
        'permission' => $can_edit,
        'annotations' => BLOCKWORK_FIXTURE_READ,
    ]);

    blockwork_fixture_ability('blockwork-fields/update-book', [
        'label' => 'Update a book',
        'input' => [
            'type' => 'object',
            'properties' => ['id' => $id, 'title' => ['type' => 'string'], 'status' => $status, 'fields' => $fields],
            'required' => ['id'],
        ],
        'execute' => static function ($input) use ($item) {
            $changes = array_intersect_key($input, ['title' => true, 'status' => true]);
            if (isset($input['fields'])) {
                $changes['meta'] = $input['fields'];
            }

            return $item(blockwork_fixture_book_request('POST', '/' . $input['id'], $changes));
        },
        'permission' => $can_edit,
        'annotations' => BLOCKWORK_FIXTURE_UPDATE,
    ]);

    blockwork_fixture_ability('blockwork-fields/delete-book', [
        'label' => 'Delete a book',
        'input' => [
            'type' => 'object',
            'properties' => ['id' => $id, 'force' => ['type' => 'boolean', 'default' => false]],
            'required' => ['id'],
        ],
        'execute' => static function ($input) {
            $force = rest_sanitize_boolean($input['force'] ?? false);
            $response = blockwork_fixture_book_request('DELETE', '/' . $input['id'], ['force' => $force]);

            return is_wp_error($response)
                ? $response
                : ['id' => $input['id'], 'deleted' => $force, 'trashed' => !$force];
        },
        'permission' => $can_edit,
        'annotations' => BLOCKWORK_FIXTURE_DESTRUCTIVE,
    ]);
});
