import assert from 'node:assert/strict';
import test from 'node:test';
import { integrationVersions } from '../../tools/integration-fixture.mjs';
import { startFixture } from '../../tools/playground.mjs';
import { adminPage, executions, marker, wordpress } from '../helpers/abilities-page.mjs';

test('older supported WordPress versions list and run abilities', async () => {
  for (const version of integrationVersions.filter((item) => item !== '7.1.4')) {
    const fixture = await startFixture(false, version, true);

    try {
      const admin = await adminPage(fixture, 'admin');
      const configured = await admin.run('blockwork-fixture/configure', 'write', { seo_exposed: true, fields_enabled: true });
      assert.equal(configured.ok, true, `${version} ${JSON.stringify(configured)}`);
      const list = await admin.inspect();
      assert.equal(list.ok, true, `${version} ${JSON.stringify(list)}`);
      assert.equal(admin.raw.at(-1).body.includes('input_schema'), false);
      // 7.0 ignores the namespace filter, so Blockwork filters the page itself.
      const filtered = await admin.inspect({ namespace: 'blockwork-fixture' });
      assert.ok(filtered.abilities.length > 0 && filtered.abilities.every((ability) => ability.name.startsWith('blockwork-fixture/')), `${version} ${JSON.stringify(filtered)}`);
      const read = await admin.run('blockwork-fixture/echo', 'read', { text: 'floor', list: [1, 2] });
      assert.deepEqual([read.ok, read.output?.input.text], [true, 'floor'], `${version} ${JSON.stringify(read)}`);
      const written = await admin.run('blockwork-fixture/set-marker', 'write', { value: version });
      assert.equal(written.ok, true, `${version} ${JSON.stringify(written)}`);
      assert.equal(await marker(fixture), version);
      const stale = await admin.run('blockwork-fixture/nonce-error', 'write');
      assert.equal(stale.persistence, 'uncertain', `${version} ${JSON.stringify(stale)}`);
      assert.equal(await executions(fixture, 'blockwork-fixture/nonce-error'), 1);
      const post_id = fixture.state.documents.roundtrip.post_id;
      const seo = await admin.run('blockwork-seo/update-post-title-description', 'destructive', { post_id, title: 'Floor' });
      assert.equal(seo.ok, true, `${version} ${JSON.stringify(seo)}`);

      // Before 7.1 core hands query input to the ability as strings, so an
      // explicit false is where a plugin's loose test would go wrong.
      const robots = await admin.run('blockwork-seo/update-post-robots-settings', 'destructive', { post_id, noindex: false });
      assert.equal(robots.output?.noindex, false, `${version} ${JSON.stringify(robots)}`);
      const book = await admin.run('blockwork-fields/create-book', 'write', { title: 'Floor book' });
      const trashed = await admin.run('blockwork-fields/delete-book', 'destructive', { id: book.output?.id, force: false });
      assert.equal(trashed.output?.trashed, true, `${version} ${JSON.stringify([book, trashed])}`);
      assert.equal(await wordpress(fixture, `get_post_status(${book.output.id})`), 'trash');
    } finally {
      await fixture.cli[Symbol.asyncDispose]();
    }
  }
});
