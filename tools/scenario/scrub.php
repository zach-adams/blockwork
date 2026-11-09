<?php
/**
 * Verifies, trims, and scrubs a freshly imported scenario snapshot database.
 *
 * Runs inside Playground during `scenario.mjs capture`, right after the source
 * dump is loaded. SHORTINIT keeps the captured plugins and theme from booting
 * while live credentials are still present. Reads /tmp/scenario/config.json and
 * writes /tmp/scenario/scrub.json; scenario.mjs mounts that directory. Never run
 * this against a real site: it deletes content and rewrites users.
 *
 * @package Blockwork
 */

define( 'SHORTINIT', true );

require '/wordpress/wp-load.php';

global $wpdb;

$blockwork_config = json_decode( (string) file_get_contents( '/tmp/scenario/config.json' ), true );

// The SQLite driver returns false instead of throwing, so check every write.
$blockwork_write = static function ( $result ) use ( $wpdb ) {
	if ( false === $result ) {
		throw new RuntimeException( "Scenario database write failed: {$wpdb->last_error}" );
	}

	return $result;
};

// runSql skips failed statements; a partial import must not become a snapshot.
foreach ( $blockwork_config['tables'] as $blockwork_table ) {
	if ( null === $wpdb->get_var( "SELECT COUNT(*) FROM `$blockwork_table`" ) ) {
		throw new RuntimeException( "Imported table $blockwork_table is missing." );
	}
}

foreach ( $blockwork_config['rows'] as $blockwork_table => $blockwork_rows ) {
	$blockwork_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM `$blockwork_table`" );

	if ( $blockwork_count !== (int) $blockwork_rows ) {
		throw new RuntimeException( "Imported table $blockwork_table has $blockwork_count rows; the source has $blockwork_rows." );
	}
}

foreach ( array( 'template', 'stylesheet' ) as $blockwork_name ) {
	$blockwork_value = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $blockwork_name ) );

	if ( $blockwork_value !== $blockwork_config[ $blockwork_name ] ) {
		throw new RuntimeException( "Imported $blockwork_name is " . var_export( $blockwork_value, true ) . "; expected {$blockwork_config[ $blockwork_name ]}." );
	}
}

$blockwork_user_id = (int) $wpdb->get_var( $wpdb->prepare( "SELECT ID FROM {$wpdb->users} WHERE user_login = %s", $blockwork_config['user'] ) );

if ( ! $blockwork_user_id ) {
	throw new RuntimeException( "Scenario user {$blockwork_config['user']} does not exist on the source site." );
}

// Content that editing scenarios never read.
$blockwork_types   = implode( ',', array_fill( 0, count( $blockwork_config['drop_post_types'] ), '%s' ) );
$blockwork_dropped = array_map(
	'intval',
	$wpdb->get_col(
		$wpdb->prepare(
			"SELECT ID FROM {$wpdb->posts} WHERE post_type IN ($blockwork_types) OR post_status IN ('auto-draft', 'trash')",
			$blockwork_config['drop_post_types']
		)
	)
);

foreach ( array_chunk( $blockwork_dropped, 200 ) as $blockwork_chunk ) {
	$blockwork_list = implode( ',', $blockwork_chunk );
	$blockwork_write( $wpdb->query( "DELETE FROM {$wpdb->postmeta} WHERE post_id IN ($blockwork_list)" ) );
	$blockwork_write( $wpdb->query( "DELETE FROM {$wpdb->posts} WHERE ID IN ($blockwork_list)" ) );
}

foreach ( $blockwork_config['empty_tables'] as $blockwork_table ) {
	if ( ! preg_match( '/^\w+$/', $blockwork_table ) ) {
		throw new RuntimeException( "Invalid empty_tables entry: $blockwork_table" );
	}

	$blockwork_write( $wpdb->query( "DELETE FROM `{$wpdb->prefix}$blockwork_table`" ) );
}

foreach ( $wpdb->get_col( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE '%transient%'" ) as $blockwork_name ) {
	if ( str_starts_with( $blockwork_name, '_transient_' ) || str_starts_with( $blockwork_name, '_site_transient_' ) ) {
		$blockwork_write( $wpdb->delete( $wpdb->options, array( 'option_name' => $blockwork_name ) ) );
	}
}

/*
 * Credentials stay on the source site. Options whose names look like
 * credentials are blanked whole. Settings stored as serialized or JSON arrays
 * lose credential-like string values of eight or more characters, which leaves
 * short flags such as `on` or `1` intact.
 */
$blockwork_secret_name = '/secret|license_key|_license$|api_key|private_key|hmac_key|access_token|refresh_token|^recovery_keys$/i';
$blockwork_secret_key  = '/(^|_)(pass|password|secret|secret_key|api_?key|api_?token|token|license_key|private_key|hmac_key)$/i';
$blockwork_scrubbed    = array();

$blockwork_scrub = static function ( $value, $path ) use ( &$blockwork_scrub, &$blockwork_scrubbed, $blockwork_secret_key ) {
	if ( ! is_array( $value ) ) {
		return $value;
	}

	foreach ( $value as $key => $item ) {
		if ( is_string( $item ) && strlen( $item ) >= 8 && preg_match( $blockwork_secret_key, (string) $key ) ) {
			$value[ $key ]        = '';
			$blockwork_scrubbed[] = "$path.$key";
		} else {
			$value[ $key ] = $blockwork_scrub( $item, "$path.$key" );
		}
	}

	return $value;
};

foreach ( $wpdb->get_results( "SELECT option_name, option_value FROM {$wpdb->options}" ) as $blockwork_option ) {
	$blockwork_name  = $blockwork_option->option_name;
	$blockwork_value = $blockwork_option->option_value;
	$blockwork_clean = $blockwork_value;

	if ( preg_match( $blockwork_secret_name, $blockwork_name ) || in_array( $blockwork_name, $blockwork_config['scrub_options'], true ) ) {
		$blockwork_clean = '';

		if ( '' !== $blockwork_value ) {
			$blockwork_scrubbed[] = $blockwork_name;
		}
	} else {
		$blockwork_serialized = str_starts_with( $blockwork_value, 'a:' );
		$blockwork_array      = $blockwork_serialized
			? @unserialize( $blockwork_value, array( 'allowed_classes' => false ) )
			: json_decode( $blockwork_value, true );
		$blockwork_before     = count( $blockwork_scrubbed );

		if ( is_array( $blockwork_array ) ) {
			$blockwork_array = $blockwork_scrub( $blockwork_array, $blockwork_name );
		}

		// Rewrite only changed settings so untouched values keep their exact encoding.
		if ( count( $blockwork_scrubbed ) > $blockwork_before ) {
			$blockwork_clean = $blockwork_serialized
				? serialize( $blockwork_array )
				: json_encode( $blockwork_array, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		}
	}

	if ( $blockwork_clean !== $blockwork_value ) {
		$blockwork_write( $wpdb->update( $wpdb->options, array( 'option_value' => $blockwork_clean ), array( 'option_name' => $blockwork_name ) ) );
	}
}

// Playground signs the scenario user in without a password, so no hash is needed.
$blockwork_write(
	$wpdb->query(
		$wpdb->prepare(
			"UPDATE {$wpdb->users} SET user_email = CONCAT('user-', ID, '@example.invalid') WHERE ID <> %d",
			$blockwork_user_id
		)
	)
);
$blockwork_write( $wpdb->query( "UPDATE {$wpdb->users} SET user_pass = '', user_activation_key = ''" ) );
$blockwork_write( $wpdb->query( "DELETE FROM {$wpdb->usermeta} WHERE meta_key IN ('session_tokens', '_application_passwords')" ) );

// Read by the snapshot mu-plugin to redirect omitted uploads.
$blockwork_write( $wpdb->delete( $wpdb->options, array( 'option_name' => 'blockwork_scenario_uploads_url' ) ) );
$blockwork_write(
	$wpdb->insert(
		$wpdb->options,
		array(
			'option_name'  => 'blockwork_scenario_uploads_url',
			'option_value' => $blockwork_config['uploads_url'],
			'autoload'     => 'off',
		)
	)
);

$blockwork_left = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->usermeta} WHERE meta_key IN ('session_tokens', '_application_passwords')" );

foreach ( $wpdb->get_results( "SELECT option_name, option_value FROM {$wpdb->options}" ) as $blockwork_option ) {
	if ( '' !== $blockwork_option->option_value && preg_match( $blockwork_secret_name, $blockwork_option->option_name ) ) {
		++$blockwork_left;
	}
}

if ( $blockwork_left ) {
	throw new RuntimeException( "$blockwork_left credential records survived scrubbing." );
}

file_put_contents(
	'/tmp/scenario/scrub.json',
	json_encode(
		array(
			'dropped_posts' => count( $blockwork_dropped ),
			'scrubbed'      => $blockwork_scrubbed,
		)
	)
);
