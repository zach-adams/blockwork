# Dependency patches

`@wp-playground__cli@3.1.56.patch` changes one line of
[`@wp-playground/cli`](https://github.com/WordPress/wordpress-playground), which is
licensed GPL-2.0-or-later. The patch is a modification of that package and is
under the same license. It binds the test fixture's server to `127.0.0.1`; see
[the integration fixture](../../docs/integration-fixture.md). The patched package
is a development dependency and is not part of the plugin package, which stays
under Blockwork's MIT license.
