<?php
/**
 * Plugin Name: Blockwork scenario
 * Description: Playground adjustments for a trimmed Blockwork scenario snapshot.
 *
 * Copied into each snapshot by `tools/scenario.mjs capture`.
 *
 * @package Blockwork
 */

/*
 * Playground's PHP reports the `cli` SAPI for web requests, so Laravel's
 * runningInConsole() is true and Acorn-based themes skip their HTTP boot.
 * The theme then fatals on its first facade call. Other sites ignore this.
 */
if ( ! defined( 'WP_CLI' ) && isset( $_SERVER['REQUEST_METHOD'] ) ) {
	putenv( 'APP_RUNNING_IN_CONSOLE=false' );
	$_ENV['APP_RUNNING_IN_CONSOLE']    = 'false';
	$_SERVER['APP_RUNNING_IN_CONSOLE'] = 'false';
}

/*
 * Snapshots keep only the uploads their scenarios use. Playground serves files
 * that exist and routes missing ones through index.php, so this redirects the
 * rest to the source site, which must be running to serve them.
 */
$blockwork_scenario_uri    = (string) ( $_SERVER['REQUEST_URI'] ?? '' );
$blockwork_scenario_path   = rawurldecode( (string) parse_url( $blockwork_scenario_uri, PHP_URL_PATH ) );
$blockwork_scenario_query  = (string) parse_url( $blockwork_scenario_uri, PHP_URL_QUERY );
$blockwork_scenario_prefix = '/wp-content/uploads/';
$blockwork_scenario_file   = substr( $blockwork_scenario_path, strlen( $blockwork_scenario_prefix ) );

if (
	str_starts_with( $blockwork_scenario_path, $blockwork_scenario_prefix )
	&& ! str_contains( $blockwork_scenario_file, '..' )
	&& ! is_file( WP_CONTENT_DIR . '/uploads/' . $blockwork_scenario_file )
	&& get_option( 'blockwork_scenario_uploads_url' )
) {
	$blockwork_scenario_location = untrailingslashit( get_option( 'blockwork_scenario_uploads_url' ) ) . '/'
		. implode( '/', array_map( 'rawurlencode', explode( '/', $blockwork_scenario_file ) ) )
		. ( '' === $blockwork_scenario_query ? '' : "?$blockwork_scenario_query" );

	header( "Location: $blockwork_scenario_location", true, 302 );
	exit;
}
