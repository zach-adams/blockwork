import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';
import {
  installDateObserver,
  inspectDateRendering,
  removeDateObserver,
} from './post-date-observation.mjs';
import { paragraph } from './blocks.mjs';
import {
  assertSavedCleanly,
  assertRefused,
  seedDocument,
  serializeNatively,
  startEditingSite,
  withDocument,
} from './harness.mjs';

const { before, after, test, run } = editingTests(import.meta.url);
let site;
let posts;
before(async () => {
  site = await startEditingSite();
  posts = [];

  for (let index = 0; index < 2; index++) {
    const id = await seedDocument(site, {
      type: 'post',
      title: 'BlockworkDatePreviewFixture ' + index,
      content: paragraph('Blockwork date preview'),
    });
    posts.push(id);
    const values = {
      post_date: 2001 + index + '-01-02 03:04:05',
      post_date_gmt: 2001 + index + '-01-02 03:04:05',
      post_modified: 2011 + index + '-02-03 04:05:06',
      post_modified_gmt: 2011 + index + '-02-03 04:05:06',
    };
    await site.php(
      `$wpdb->update($wpdb->posts, json_decode('${JSON.stringify(values)}', true), ['ID' => ${id}]); clean_post_cache(${id}); echo wp_json_encode(true);`,
    );
  }
});
after(() => site?.[Symbol.asyncDispose]());
const query = (children = [{ name: 'core/post-title' }]) => ({
  name: 'core/query',
  attributes: {
    queryId: 77,
    query: {
      perPage: 2,
      pages: 0,
      offset: 0,
      postType: 'post',
      order: 'desc',
      orderBy: 'date',
      search: 'BlockworkDatePreviewFixture',
      excludeCurrent: null,
      inherit: false,
    },
  },
  inner_blocks: [{ name: 'core/post-template', inner_blocks: children }],
});
const dates = () => [{ name: 'core/post-date' }];
const selection = (tab) =>
  site.evaluate(
    tab,
    `(() => { const s=wp.data.select('core/block-editor'); return { start:s.getSelectionStart(), end:s.getSelectionEnd(), position:s.getSelectedBlocksInitialCaretPosition() }; })()`,
  );
const pending = (tab, id) =>
  site.evaluate(
    tab,
    `(() => {const core=wp.data.select('core');return ${JSON.stringify(posts)}.concat(${id}).map(id=>({id,edits:core.getEntityRecordNonTransientEdits('postType',id===${id}?'page':'post',id)}));})()`,
  );
const backing = (tab) =>
  site.evaluate(
    tab,
    `(async()=>{const core=wp.data.resolveSelect('core');return await Promise.all(${JSON.stringify(posts)}.map(id=>core.getEditedEntityRecord('postType','post',id)));})()`,
  );
const databaseDates = (id) =>
  site.php(
    `$ids=json_decode('${JSON.stringify([...posts, id])}',true); $out=[]; foreach($ids as $id){$p=get_post($id);$out[$id]=["date"=>$p->post_date,"date_gmt"=>$p->post_date_gmt,"modified"=>$p->post_modified,"modified_gmt"=>$p->post_modified_gmt];} echo wp_json_encode($out);`,
  );
const render = (tab, fields, root = false) =>
  site.evaluate(
    tab,
    '(' + inspectDateRendering.toString() + ')(' + JSON.stringify(fields) + ',' + root + ')',
  );
const requireOk = (result) => assert.equal(result.ok, true, JSON.stringify(result));

for (const scenario of ['new_query', 'existing_template', 'move'])
  test(`dynamic dates preserve backing entities in ${scenario}`, async () => {
    const content =
      scenario === 'existing_template'
        ? await serializeNatively(
            site,
            `[wp.blocks.createBlock('core/paragraph',{content:'Anchor'}),wp.blocks.createBlock('core/query',${JSON.stringify(query().attributes)},[wp.blocks.createBlock('core/post-template',{},[wp.blocks.createBlock('core/post-title')])])]`,
          )
        : paragraph('Anchor');
    await withDocument(
      site,
      {
        content,
        extra: { post_date: '2020-03-04 05:06:07', post_date_gmt: '2020-03-04 05:06:07' },
      },
      async ({ blockwork, tab, id, before }) => {
        const entities = await backing(tab);
        const originalPending = await pending(tab, id);
        const originalDatabase = await databaseDates(id);
        assert.equal(
          new Set(
            posts.flatMap((post) => [originalDatabase[post].date, originalDatabase[post].modified]),
          ).size,
          4,
          'Preview fixture dates must all differ',
        );

        for (const post of posts)
          for (const field of ['date', 'modified'])
            for (const targetField of ['date', 'modified'])
              assert.notEqual(
                originalDatabase[post][field],
                originalDatabase[id][targetField],
                'Preview dates must differ from the current target',
              );
        await site.evaluate(
          tab,
          '(' + installDateObserver.toString() + ')(' + JSON.stringify(posts) + ',' + id + ')',
        );

        try {
          if (scenario === 'new_query')
            requireOk(await blockwork.edit({ edits: [{ op: 'insert', block: query(dates()) }] }));

          if (scenario === 'existing_template') {
            const originalSelection = await selection(tab);
            requireOk(
              await blockwork.edit({
                edits: [{ op: 'insert', parent: [1, 0], block: dates()[0] }],
              }),
            );
            assert.deepEqual(
              await selection(tab),
              originalSelection,
              'Existing-template selection was not restored',
            );
            assert.equal(
              await site.evaluate(
                tab,
                "wp.data.select('core/block-editor').canInsertBlockType('core/post-date', wp.data.select('core/block-editor').getBlocks()[1].innerBlocks[0].clientId)",
              ),
              true,
              'Native insertion policy was lost after selection restoration',
            );
          }

          if (scenario === 'move') {
            requireOk(
              await blockwork.edit({
                edits: [
                  { op: 'insert', block: dates()[0] },
                  { op: 'insert', block: query() },
                ],
              }),
            );
            requireOk(
              await blockwork.edit({
                edits: [{ op: 'move', path: [1], name: 'core/post-date', parent: [2, 0] }],
              }),
            );
            requireOk(
              await blockwork.edit({
                edits: [{ op: 'move', path: [1, 0, 1], name: 'core/post-date', parent: [] }],
              }),
            );
            requireOk(
              await blockwork.edit({
                edits: [{ op: 'move', path: [2], name: 'core/post-date', parent: [1, 0] }],
              }),
            );
          }

          await render(tab, ['date'], scenario === 'move');
          requireOk(
            await blockwork.edit({
              edits: [
                {
                  op: 'insert_variation',
                  parent: [1, 0],
                  name: 'core/post-date',
                  variation: 'post-date-modified',
                  attributes: {},
                },
              ],
            }),
          );
          await render(tab, ['date', 'modified']);
          assert.deepEqual(await backing(tab), entities, 'Preview backing entities changed');
          assert.deepEqual(
            await databaseDates(id),
            originalDatabase,
            'A Date edit wrote backing database dates',
          );
          const currentPending = await pending(tab, id);

          for (const record of currentPending) {
            const original = originalPending.find((item) => item.id === record.id).edits;

            for (const field of ['date', 'date_gmt', 'modified', 'modified_gmt'])
              assert.deepEqual(record.edits?.[field], original?.[field]);

            if (posts.includes(record.id))
              assert.deepEqual(record.edits, original, 'A preview entity acquired pending edits');
          }

          await assertSavedCleanly(site, id, before, await blockwork.save());
          const savedDatabase = await databaseDates(id);

          for (const post of posts)
            assert.deepEqual(
              savedDatabase[post],
              originalDatabase[post],
              'Saving the page changed a preview entity',
            );
          assert.equal(savedDatabase[id].date, originalDatabase[id].date);
          assert.equal(savedDatabase[id].date_gmt, originalDatabase[id].date_gmt);
        } finally {
          await site.evaluate(tab, '(' + removeDateObserver.toString() + ')()');
        }
      },
    );
  });

test('a missing backing date in the second preview refuses before mounting', async () => {
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, tab, id }) => {
    await backing(tab);
    const originalDatabase = await databaseDates(id);
    await site.evaluate(
      tab,
      `wp.data.dispatch('core').editEntityRecord('postType','post',${posts[0]},{date:null});true`,
    );
    const originalPending = await pending(tab, id);
    const result = await blockwork.edit({ edits: [{ op: 'insert', block: query(dates()) }] });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error, 'post_date_context_unavailable');
    assert.equal(result.editor_result, 'not_applied');
    assert.deepEqual(await pending(tab, id), originalPending);
    assert.deepEqual(await databaseDates(id), originalDatabase);
  });
});

test('an existing bound Date supports unbound styling, moves and removal', async () => {
  const content = await serializeNatively(site, "[wp.blocks.createBlock('core/paragraph',{content:'Anchor'}),wp.blocks.parse(wp.blocks.serialize([wp.blocks.createBlock('core/post-date')]))[0],wp.blocks.createBlock('core/group',{},[wp.blocks.createBlock('core/paragraph',{content:'Keep'})])]");
  await withDocument(site, { content }, async ({ blockwork, tab, id, before }) => {
    const read = await blockwork.read({ blocks: 'all' });
    requireOk(read);
    const date = read.blocks.find(block => block.name === 'core/post-date');
    const group = read.blocks.find(block => block.name === 'core/group');
    const originalDatabase = await databaseDates(id);
    const originalPending = await pending(tab, id);
    requireOk(await blockwork.edit({ edits: [{ op: 'update', client_id: date.client_id, attributes: { className: 'date-emphasis', style: { color: { text: '#123456' } } } }] }));
    requireOk(await blockwork.edit({ edits: [{ op: 'move', client_id: date.client_id, parent_client_id: group.client_id, index: 1 }] }));
    requireOk(await blockwork.edit({ edits: [{ op: 'move', client_id: date.client_id, parent: [], index: 1 }] }));
    const attributes = await site.evaluate(tab, "wp.data.select('core/block-editor').getBlocks()[1].attributes");
    assert.equal(attributes.className, 'date-emphasis');
    assert.equal(attributes.style.color.text, '#123456');
    assert.deepEqual(attributes.metadata.bindings.datetime, { source: 'core/post-data', args: { field: 'date' } });
    assert.deepEqual(await databaseDates(id), originalDatabase);
    const currentPending = await pending(tab, id);

    for (const item of currentPending) for (const field of ['date', 'date_gmt', 'modified', 'modified_gmt']) assert.deepEqual(item.edits?.[field], originalPending.find(previous => previous.id === item.id).edits?.[field]);
    const saved = await assertSavedCleanly(site, id, before, await blockwork.save());
    const blocked = await blockwork.edit({ edits: [{ op: 'update', client_id: date.client_id, attributes: { datetime: '2020-01-01T00:00:00' } }] });
    await assertRefused(site, id, saved.after, blocked, { error: 'unsupported_attribute' });
    requireOk(await blockwork.edit({ edits: [{ op: 'remove', client_id: date.client_id }] }));
    await assertSavedCleanly(site, id, saved.after, await blockwork.save());
  });
});

test('dynamic Date creation through automatic Post Template population', { todo: 'finding: post-date-roundtrip' }, async () => {
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before }) => {
    const result = await blockwork.edit({ edits: [{ op: 'insert', block: query([]) }] });

    if (!result.ok) {
      await assertRefused(site, id, before, result, { error: 'post_date_context_unavailable' });
      assert.equal(result.editor_result, 'not_applied');
    }

    requireOk(result);
    await assertSavedCleanly(site, id, before, await blockwork.save());
  });
});

await run();
