<?php
/**
 * Lists the uploads a scenario snapshot needs.
 *
 * Runs read-only on the source site through `wp eval-file`. The
 * BLOCKWORK_SCENARIO_MEDIA environment variable holds JSON with `pages` (post
 * IDs) and `post_types` (site-wide content types). Prints one JSON line with
 * upload-relative `files` and an `attachments` count.
 *
 * Attachments contribute their attached file and registered sizes. Pre-scaled
 * originals and converted AVIF or WebP copies are left out; the snapshot's
 * mu-plugin redirects requests for them to the source site.
 *
 * @package Blockwork
 */

$blockwork_input      = json_decode( (string) getenv( 'BLOCKWORK_SCENARIO_MEDIA' ), true );
$blockwork_pages      = array_map( 'intval', $blockwork_input['pages'] ?? array() );
$blockwork_post_types = array_map( 'strval', $blockwork_input['post_types'] ?? array() );

global $wpdb;

$blockwork_texts = array();

if ( $blockwork_pages ) {
	$blockwork_ids   = implode( ',', $blockwork_pages );
	$blockwork_texts = array_merge(
		$blockwork_texts,
		$wpdb->get_col( "SELECT post_content FROM {$wpdb->posts} WHERE ID IN ($blockwork_ids)" ),
		$wpdb->get_col( "SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id IN ($blockwork_ids)" )
	);
}

if ( $blockwork_post_types ) {
	$blockwork_types = implode( ',', array_fill( 0, count( $blockwork_post_types ), '%s' ) );
	$blockwork_texts = array_merge(
		$blockwork_texts,
		$wpdb->get_col(
			$wpdb->prepare(
				"SELECT post_content FROM {$wpdb->posts} WHERE post_type IN ($blockwork_types) AND post_status NOT IN ('trash', 'auto-draft')",
				$blockwork_post_types
			)
		)
	);
}

$blockwork_texts = array_merge(
	$blockwork_texts,
	$wpdb->get_col( "SELECT option_value FROM {$wpdb->options} WHERE option_value LIKE '%wp-content%uploads%' OR option_name LIKE 'theme\\_mods\\_%'" )
);

$blockwork_attachments = array();
$blockwork_paths       = array();

foreach ( $blockwork_texts as $blockwork_text ) {
	// Block attributes and classes that store attachment IDs.
	if ( preg_match_all( '/"(?:id|mediaId|imageId|backgroundImageId)":(\d+)|wp-image-(\d+)/', (string) $blockwork_text, $blockwork_matches ) ) {
		foreach ( array_merge( $blockwork_matches[1], $blockwork_matches[2] ) as $blockwork_id ) {
			if ( $blockwork_id ) {
				$blockwork_attachments[ (int) $blockwork_id ] = true;
			}
		}
	}

	// Upload URLs, including JSON-escaped slashes.
	if ( preg_match_all( '#wp-content\\\\?/uploads\\\\?/([^"\'\s)?<>]+)#', (string) $blockwork_text, $blockwork_matches ) ) {
		foreach ( $blockwork_matches[1] as $blockwork_path ) {
			$blockwork_paths[ rtrim( str_replace( '\\/', '/', $blockwork_path ), '\\' ) ] = true;
		}
	}
}

foreach ( $blockwork_pages as $blockwork_page ) {
	$blockwork_attachments[ (int) get_post_thumbnail_id( $blockwork_page ) ] = true;
}

foreach ( array( 'site_logo', 'site_icon' ) as $blockwork_option ) {
	$blockwork_attachments[ (int) get_option( $blockwork_option ) ] = true;
}

$blockwork_attachments[ (int) get_theme_mod( 'custom_logo' ) ] = true;

unset( $blockwork_attachments[0] );

$blockwork_count = 0;

foreach ( array_keys( $blockwork_attachments ) as $blockwork_id ) {
	$blockwork_file = get_post_meta( $blockwork_id, '_wp_attached_file', true );

	if ( ! $blockwork_file || 'attachment' !== get_post_type( $blockwork_id ) ) {
		continue;
	}

	++$blockwork_count;
	$blockwork_paths[ $blockwork_file ] = true;
	$blockwork_directory                = dirname( $blockwork_file ) === '.' ? '' : dirname( $blockwork_file ) . '/';
	$blockwork_metadata                 = wp_get_attachment_metadata( $blockwork_id );

	foreach ( $blockwork_metadata['sizes'] ?? array() as $blockwork_size ) {
		$blockwork_paths[ $blockwork_directory . $blockwork_size['file'] ] = true;
	}
}

$blockwork_base  = wp_get_upload_dir()['basedir'];
$blockwork_files = array_values(
	array_filter(
		array_keys( $blockwork_paths ),
		static fn ( $path ) => ! str_contains( $path, '..' ) && is_file( "$blockwork_base/$path" )
	)
);

echo wp_json_encode(
	array(
		'attachments' => $blockwork_count,
		'files'       => $blockwork_files,
	)
), "\n";
