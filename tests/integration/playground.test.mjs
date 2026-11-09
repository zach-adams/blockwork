import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { startFixture } from '../../tools/playground.mjs';

test('fresh Playground sites serve WordPress and discard previous mutations', async (t) => {
  for (let run = 1; run <= 3; run++) {
    const fixture = await startFixture();
    const { cli, target, state, timings } = fixture;

    try {
      assert.equal(cli.server.address().address, '127.0.0.1');
      assert.equal(state.wordpress, '7.1.4');
      assert.match(state.php, /^8\.4\./);
      assert.equal(state.status, 'draft');
      assert.match(state.content, /Blockwork fixture\./);
      assert.match(state.content, /Keep this paragraph\./);
      assert.doesNotMatch(state.content, /Changed in previous run/);

      const requested = performance.now();
      const response = await fetch(`${target.site_url}/wp-json/wp/v2/types/page`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).slug, 'page');
      timings.http_ms = performance.now() - requested;

      const written = performance.now();
      const mutation = await cli.playground.run({
        code: `<?php require '/wordpress/wp-load.php';
$previous_run = get_option('blockwork_fixture_dirty', false);
$id = wp_update_post(['ID' => ${target.post_id}, 'post_content' => 'Changed in previous run'], true);
if (is_wp_error($id)) { throw new Exception($id->get_error_message()); }
update_option('blockwork_fixture_dirty', true, false);
echo json_encode(['previous_run' => $previous_run, 'content' => get_post($id)->post_content]);`,
      });
      assert.equal(mutation.exitCode, 0, mutation.errors);
      assert.equal(
        mutation.json.previous_run,
        false,
        'A previous fixture database leaked into this run',
      );
      assert.equal(mutation.json.content, 'Changed in previous run');
      timings.write_read_ms = performance.now() - written;
    } finally {
      const stopped = performance.now();
      await cli[Symbol.asyncDispose]();
      timings.dispose_ms = performance.now() - stopped;
      t.diagnostic(JSON.stringify({ run, ...timings }));
    }

    assert.equal(cli.server.listening, false);
    await assert.rejects(fetch(target.site_url));
  }
});
