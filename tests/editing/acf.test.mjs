import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { acfPlugin } from '../../tools/playground.mjs';
import { doc, paragraph } from './blocks.mjs';
import { editingTests } from './cases.mjs';
import {
  assertSavedCleanly,
  frontEnd,
  serializeNatively,
  startEditingSite,
  storedDocument,
  waitFor,
  withDocument,
} from './harness.mjs';

const { after, before, test, run } = editingTests(import.meta.url);
// ACF Pro is licensed, so it stays out of the repository and the test host copy.
const skip = existsSync(acfPlugin) ? false : `ACF Pro is not at ${acfPlugin}`;
let site;
before(async () => {
  if (!skip) {
    site = await startEditingSite({ acf: true });
  }
});
after(() => site?.[Symbol.asyncDispose]());

const paragraphEdit = (content) => [
  { op: 'update', path: [0], name: 'core/paragraph', attributes: { content } },
];
const categories = (id) => site.php(`echo wp_json_encode(wp_get_post_categories(${id}));`);
const card = 'acf/blockwork-card';
const cardData = (heading) => ({
  blockwork_card_heading: heading,
  _blockwork_card_heading: 'field_blockwork_card_heading',
});

test('saves verify after the ACF meta box fills unset fields', { skip }, async () => {
  await withDocument(
    site,
    { content: doc(paragraph('Before')) },
    async ({ blockwork, id, before }) => {
      assert.equal((await blockwork.edit({ edits: paragraphEdit('After') })).ok, true);
      await assertSavedCleanly(site, id, before, await blockwork.save(), { allow: ['meta'] });
      // The meta box form stored every field, defaults included, which REST now
      // reads differently from the editor's record.
      const { meta } = await storedDocument(site, id);
      assert.equal(meta.blockwork_text?.[0], 'Default text');
      assert.equal(meta.blockwork_file?.[0], '');

      // The editor's record still holds the old values, so a second save checks against storage.
      assert.equal((await blockwork.edit({ edits: paragraphEdit('Again') })).ok, true);
      const { after } = await assertSavedCleanly(site, id, before, await blockwork.save(), {
        allow: ['meta'],
      });
      assert.equal(after.content, doc(paragraph('Again')));
    },
  );
});

test('an attached save verifies after the user saved through the ACF meta box', { skip }, async () => {
  await withDocument(
    site,
    { content: doc(paragraph('Before')) },
    async ({ blockwork, id, before, tab }) => {
      // The user's own save posts the meta box form, which fills the unset fields.
      await site.evaluate(
        tab,
        `(() => { const editor = wp.data.dispatch('core/editor'); editor.editPost({ excerpt: 'User excerpt' }); return editor.savePost().then(() => true); })()`,
      );
      await waitFor(
        site,
        tab,
        `!wp.data.select('core/editor').isSavingPost() && !wp.data.select('core/edit-post').isSavingMetaBoxes()`,
      );
      assert.equal((await storedDocument(site, id)).meta.blockwork_text?.[0], 'Default text');

      assert.equal((await blockwork.edit({ edits: paragraphEdit('After') })).ok, true);
      await assertSavedCleanly(
        site,
        id,
        before,
        await blockwork.save({ save_all_pending: true }),
        { allow: ['meta', 'excerpt'] },
      );
    },
    { workflow: 'attached' },
  );
});

test('a post save keeps the categories an ACF taxonomy field loaded', { skip }, async () => {
  await withDocument(
    site,
    { type: 'post', content: doc(paragraph('Before')) },
    async ({ blockwork, id, before }) => {
      const loaded = await categories(id);
      assert.equal((await blockwork.edit({ edits: paragraphEdit('After') })).ok, true);
      await assertSavedCleanly(site, id, before, await blockwork.save(), { allow: ['meta'] });
      assert.deepEqual(await categories(id), loaded);
    },
  );
});

test('an ACF taxonomy field that resets a requested category is reported', { skip }, async () => {
  const term = await site.php(
    `$term = term_exists('ACF fixture', 'category') ?: wp_insert_term('ACF fixture', 'category'); echo wp_json_encode((int) $term['term_id']);`,
  );

  await withDocument(
    site,
    { type: 'post', content: doc(paragraph('Before')) },
    async ({ blockwork, id }) => {
      const loaded = await categories(id);
      const edited = await blockwork.edit({ settings: { taxonomies: { category: [term] } } });
      assert.equal(edited.ok, true, JSON.stringify(edited));
      // The form still holds the loaded terms and saves them over the request.
      const saved = await blockwork.save();
      assert.equal(saved.ok, false, JSON.stringify(saved));
      assert.equal(saved.error, 'verification_mismatch', JSON.stringify(saved));
      assert.ok(saved.diagnostics.fields.includes('categories'), JSON.stringify(saved));
      assert.ok(saved.hint && saved.next);
      assert.deepEqual(await categories(id), loaded);
    },
  );
});

test('an empty required ACF field refuses the save with guidance', { skip }, async () => {
  await site.php(`update_option('bw_acf_required', 1);`);

  try {
    await withDocument(
      site,
      { content: doc(paragraph('Before')) },
      async ({ blockwork, id, before }) => {
        assert.equal((await blockwork.edit({ edits: paragraphEdit('After') })).ok, true);
        const saved = await blockwork.save();
        assert.equal(saved.ok, false, JSON.stringify(saved));
        assert.equal(saved.error, 'save_not_sent', JSON.stringify(saved));
        assert.equal(saved.next, 'ask_user');
        assert.notEqual(saved.persistence, 'uncertain');
        assert.equal(saved.receipt, undefined);
        assert.ok(saved.hint && saved.next, JSON.stringify(saved));
        assert.deepEqual((await storedDocument(site, id)).content, before.content);
      },
    );
  } finally {
    await site.php(`delete_option('bw_acf_required');`);
  }
});

test('an ACF block saves the field data it was inserted and updated with', { skip }, async () => {
  await withDocument(
    site,
    { content: doc(paragraph('Before')) },
    async ({ blockwork, id, before }) => {
      const inserted = await blockwork.edit({
        edits: [
          {
            op: 'insert',
            index: 1,
            block: { name: card, attributes: { name: card, mode: 'preview', data: cardData('Inserted card') } },
          },
        ],
      });
      assert.equal(inserted.ok, true, JSON.stringify(inserted));
      await assertSavedCleanly(site, id, before, await blockwork.save(), { allow: ['meta'] });
      assert.match((await frontEnd(site, id)).html, /<h3>Inserted card<\/h3>/);

      const clientId = inserted.changed.find((block) => block.name === card).client_id;
      const updated = await blockwork.edit({
        edits: [
          {
            op: 'update',
            client_id: clientId,
            attributes: { data: { blockwork_card_heading: 'Updated card' } },
          },
        ],
      });
      assert.equal(updated.ok, true, JSON.stringify(updated));
      await assertSavedCleanly(site, id, before, await blockwork.save(), { allow: ['meta'] });
      assert.match((await frontEnd(site, id)).html, /<h3>Updated card<\/h3>/);
    },
  );
});

test('blocks inserted inside an ACF block save as its inner blocks', { skip }, async () => {
  const content = await serializeNatively(
    site,
    `[wp.blocks.createBlock(${JSON.stringify(card)}, ${JSON.stringify({ name: card, mode: 'preview', data: cardData('Seeded card') })}, [wp.blocks.createBlock('core/paragraph', { content: 'Inside' })])]`,
  );

  await withDocument(site, { content }, async ({ blockwork, doc: connected, id, before }) => {
    const inserted = await blockwork.edit({
      edits: [
        {
          op: 'insert',
          parent_client_id: connected.blocks[0].client_id,
          index: 1,
          block: { name: 'core/paragraph', attributes: { content: 'Added inside' } },
        },
      ],
    });
    assert.equal(inserted.ok, true, JSON.stringify(inserted));
    const { after } = await assertSavedCleanly(site, id, before, await blockwork.save(), {
      allow: ['meta'],
    });
    assert.match(
      after.content,
      /<p>Inside<\/p>[\s\S]*<p>Added inside<\/p>[\s\S]*<!-- \/wp:acf\/blockwork-card -->/,
    );
  });
});

run();
