import assert from 'node:assert/strict';
import test from 'node:test';
import {
  integrationVersions,
  startIntegrationFixture,
} from '../../tools/integration-fixture.mjs';
import { fixtureControl } from '../../tools/fixture-control.mjs';

test('editor fixtures provide real identities, capabilities, locks, and shared entities', async (t) => {
  for (const version of integrationVersions) {
    const running = await startIntegrationFixture(version);
    const { descriptor } = running;

    try {
      assert.equal(descriptor.state.wordpress, version === '7.0.0' ? '7.0' : version);
      assert.equal(descriptor.state.block_theme, true);
      assert.equal(descriptor.state.theme, 'twentytwentyfive');
      assert.deepEqual(Object.keys(descriptor.state.accounts), [
        'admin',
        'editor',
        'author',
        'subscriber',
      ]);

      for (const account of Object.keys(descriptor.state.accounts)) {
        const credentials = await fixtureControl(descriptor, 'credentials', 'roundtrip', account);
        assert.ok(credentials.username.length > 0 && credentials.password.length >= 32);
      }

      assert.match(descriptor.state.documents.wp_template.post_id, /^twentytwentyfive\/\//);
      assert.match(descriptor.state.documents.wp_template_part.post_id, /^twentytwentyfive\/\//);
      assert.ok(Number.isInteger(descriptor.state.documents.wp_navigation.post_id));
      const before = await fixtureControl(descriptor, 'snapshot', 'permission');
      assert.equal(before.author_can_edit, true);
      const restricted = await fixtureControl(descriptor, 'restrict', 'permission');
      assert.equal(restricted.author_can_edit, false);
      const locked = await fixtureControl(descriptor, 'lock', 'lock');
      assert.equal(locked.other_lock_user_id, descriptor.state.accounts.editor);
      const stale = await fixtureControl(descriptor, 'external_edit', 'stale');
      assert.match(stale.content, /External writer wins\./);
      const revoked = await fixtureControl(descriptor, 'revoke');
      assert.equal(revoked.session_count, 0);
      const rejected = await fetch(descriptor.control_url, {
        method: 'POST',
        headers: { origin: descriptor.target.site_url, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'snapshot' }),
      });
      assert.equal(rejected.status, 403);
      t.diagnostic(JSON.stringify({ version, ready_ms: descriptor.timings.ready_ms }));
    } finally {
      await running[Symbol.asyncDispose]();
    }
  }
});
