import assert from 'node:assert/strict';
import test from 'node:test';
import { startFixture } from '../../tools/playground.mjs';
import { adminPage, wordpress } from '../helpers/abilities-page.mjs';

// The current WordPress.org release of a plugin that registers its own
// abilities, so a change in how it declares them fails here.
const plugin = (slug) => ({ step: 'installPlugin', pluginData: { resource: 'wordpress.org/plugins', slug } });

test("Yoast SEO's abilities list, read, and write a post's SEO title", async () => {
  const fixture = await startFixture(false, '7.1.4', true, {}, [], [plugin('wordpress-seo')]);

  try {
    const admin = await adminPage(fixture, 'admin');
    // Yoast answered yoast_seo_invalid_post_id for the fixture's draft page, so this is a published post.
    const post_id = await wordpress(fixture, "wp_insert_post(['post_type' => 'post', 'post_status' => 'publish', 'post_title' => 'Blockwork SEO fixture', 'post_author' => 1])");
    const list = await admin.inspect({ namespace: 'yoast-seo' });
    assert.equal(list.ok, true, JSON.stringify(list));
    assert.ok(list.abilities.length > 0 && list.abilities.every((ability) => ability.name.startsWith('yoast-seo/')));
    const effects = Object.fromEntries(list.abilities.map((ability) => [ability.name, ability.effect]));
    assert.deepEqual([effects['yoast-seo/get-post-seo-data'], effects['yoast-seo/update-post-seo-data']], ['read', 'destructive']);
    const byCategory = await admin.inspect({ category: 'yoast-seo' });
    assert.ok(byCategory.abilities.some((ability) => ability.name === 'yoast-seo/update-post-seo-data'), JSON.stringify(byCategory));

    const update = await admin.inspect({ name: 'yoast-seo/update-post-seo-data' });
    assert.equal(update.ability.category, 'yoast-seo');
    assert.ok(update.ability.input_schema.properties.seo_title, JSON.stringify(update));
    assert.equal(update.ability.output_schema?.type, 'object', JSON.stringify(update.ability.output_schema));

    const title = 'Blockwork fixture SEO title';
    const written = await admin.run('yoast-seo/update-post-seo-data', 'destructive', { post_id, seo_title: title });
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.equal(await wordpress(fixture, `get_post_meta(${post_id}, '_yoast_wpseo_title', true)`), title);

    const read = await admin.run('yoast-seo/get-post-seo-data', 'read', { post_id });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.ok(JSON.stringify(read.output).includes(title), JSON.stringify(read.output));
  } finally {
    await fixture.cli[Symbol.asyncDispose]();
  }
});
