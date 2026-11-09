<?php
/**
 * Creates a scrubbed scenario snapshot's configured pages.
 *
 * Runs inside Playground after scrub.php, so the captured plugins and theme
 * boot here for the first time, without live credentials. Reads
 * /tmp/scenario/config.json and writes /tmp/scenario/finish.json.
 *
 * @package Blockwork
 */

require '/wordpress/wp-load.php';

$blockwork_config = json_decode( (string) file_get_contents( '/tmp/scenario/config.json' ), true );
$blockwork_user   = get_user_by( 'login', $blockwork_config['user'] );
$blockwork_pages  = array();

foreach ( $blockwork_config['create_pages'] as $blockwork_key => $blockwork_title ) {
	$blockwork_page = wp_insert_post(
		array(
			'post_type'    => 'page',
			'post_status'  => 'draft',
			'post_title'   => $blockwork_title,
			'post_content' => '',
			'post_author'  => $blockwork_user->ID,
		),
		true
	);

	if ( is_wp_error( $blockwork_page ) ) {
		throw new RuntimeException( "Could not create page $blockwork_key: {$blockwork_page->get_error_message()}" );
	}

	$blockwork_pages[ $blockwork_key ] = $blockwork_page;
}

file_put_contents( '/tmp/scenario/finish.json', wp_json_encode( array( 'created_pages' => $blockwork_pages ) ) );
