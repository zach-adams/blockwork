import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';

const { after, before, test, generated, run } = editingTests(import.meta.url);

import { block, doc, olderAccordion, paragraph } from './blocks.mjs';
import {
  assertRefused,
  assertSavedCleanly,
  frontEnd,
  seedDocument,
  serializeNatively,
  startEditingSite,
  storedDocument,
  storedTree,
  withDocument,
} from './harness.mjs';

let site;
before(async () => {
  site = await startEditingSite();
});
after(() => site?.[Symbol.asyncDispose]());

const siteTarget = () => ({ site_url: site.site, user_id: 1 });
const entityTarget = (id, type = 'wp_block') => ({ ...siteTarget(), post_id: id, post_type: type });
const reference = (id, token) => ({
  entity_type: 'wp_block',
  entity_id: id,
  reference_token: token,
});
const referenceBlock = (id) => block('block', { ref: id });
const inspect = (caller, id, type = 'wp_block') =>
  caller.call({ operation: 'inspect_entity', target: entityTarget(id, type) });
const query = (attributes = {}) => ({
  name: 'core/query',
  attributes: {
    query: {
      inherit: false,
      postType: 'post',
      perPage: 2,
      order: 'desc',
      orderBy: 'date',
      ...attributes,
    },
  },
  inner_blocks: [{ name: 'core/post-template', inner_blocks: [{ name: 'core/post-title' }] }],
});

test('create a synced pattern from a section and replace the original blocks', async () => {
  const section = await serializeNatively(site, "[wp.blocks.createBlock('core/group', {}, [wp.blocks.createBlock('core/paragraph', {content:'Reusable CTA'})])]");
  await withDocument(site, { content: doc(section, paragraph('Neighbor')) }, async ({ blockwork, doc: connected, id, before }) => {
    const client_id = connected.blocks[0].client_id;
    const read = await blockwork.read({ blocks: { client_id, markup: true } });
    assert.equal(read.ok, true, JSON.stringify(read));
    const tab = await site.openTab(site.site + '/wp-admin/upload.php');
    const caller = await site.createCaller(tab);
    let pattern;

    try {
      const created = await caller.create({ target: siteTarget(), post_type: 'wp_block' });
      assert.equal(created.ok, true, JSON.stringify(created));
      pattern = created.document.post_id;
      const baseline = await storedDocument(site, pattern);
      const edited = await caller.edit({ scope: 'all_references', post: { title: 'Blockwork reusable CTA', status: 'publish' }, edits: [{ op: 'insert', markup: read.markup }] });
      assert.equal(edited.ok, true, JSON.stringify(edited));
      const saved = await caller.save();
      await assertSavedCleanly(site, pattern, baseline, saved, { allow: ['title', 'slug', 'status', 'date'] });
      assert.equal((await storedDocument(site, pattern)).content, section);
    } finally {
      await caller.release().catch(() => undefined);
      await tab.close();
    }

    const inspected = await inspect(blockwork, pattern);
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const swapped = await blockwork.edit({ edits: [
      { op: 'remove', client_id },
      { op: 'insert_reference', index: 0, reference: reference(pattern, inspected.reference_token) },
    ] });
    assert.equal(swapped.ok, true, JSON.stringify(swapped));
    const { after: stored } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(stored.content, doc(referenceBlock(pattern), paragraph('Neighbor')));
  });
});

test('creating a synced pattern refuses a non-reusable block before changing the auto-draft', async () => {
  const tab = await site.openTab(site.site + '/wp-admin/upload.php');
  const caller = await site.createCaller(tab);

  try {
    const created = await caller.create({ target: siteTarget(), post_type: 'wp_block' });
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = created.document.post_id;
    const before = await storedDocument(site, id);
    await site.evaluate(tab, "wp.blocks.registerBlockType('blockwork/non-reusable', {apiVersion:3,title:'Non-reusable fixture',category:'text',supports:{reusable:false},edit:()=>null,save:()=>wp.element.createElement('p',null,'Fixture')}); true");
    assert.equal(await site.evaluate(tab, "wp.blocks.hasBlockSupport('blockwork/non-reusable', 'reusable', true)"), false);
    const result = await caller.edit({ scope: 'all_references', post: { title: 'Refused pattern', status: 'publish' }, edits: [{ op: 'insert', block: { name: 'blockwork/non-reusable' } }] });
    await assertRefused(site, id, before, result, { error: 'pattern_block_not_reusable' });
    assert.equal((await caller.status()).dirty, false);
  } finally {
    await caller.release().catch(() => undefined);
    await tab.close();
  }
});

for (const overrides of [false, true]) {
  test('detach a synced pattern into static blocks with overrides ' + overrides, async () => {
    const bound = paragraph('Default question', { metadata: { name: 'Question', id: 'binding-id', bindings: { content: { source: 'core/pattern-overrides' } } } });
    const pattern = await seedDocument(site, { type: 'wp_block', content: bound });
    const attributes = { ref: pattern };

    if (overrides) attributes.content = { Question: { content: 'Visible question', unknown: 'Ignored' } };
    const instance = block('block', attributes);
    const original = await storedDocument(site, pattern);
    await withDocument(site, { content: doc(instance, paragraph('Neighbor')) }, async ({ blockwork, doc: connected, id, before }) => {
      const result = await blockwork.edit({ edits: [{ op: 'detach_reference', client_id: connected.blocks[0].client_id }] });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(result.changed.some((item) => item.name === 'core/paragraph'), JSON.stringify(result));
      const { after: stored } = await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal(stored.content, doc(paragraph(overrides ? 'Visible question' : 'Default question', { metadata: { name: 'Question' } }), paragraph('Neighbor')));
      assert.deepEqual(await storedDocument(site, pattern), original);
    });
  });
}

test('shared patterns require scope and update both pages', async () => {
  const pattern = await seedDocument(site, {
    type: 'wp_block',
    content: paragraph('Shared original'),
  });
  const first = await seedDocument(site, { content: referenceBlock(pattern) });
  const second = await seedDocument(site, { content: referenceBlock(pattern) });
  await withDocument(
    site,
    { type: 'wp_block', content: paragraph('Other pattern') },
    async ({ blockwork }) => {
      const found = await inspect(blockwork, pattern);
      assert.equal(found.ok, true, JSON.stringify(found));
      const listed = await blockwork.call({
        operation: 'list_entities',
        target: siteTarget(),
        entity_type: 'wp_block',
      });
      assert.equal(listed.ok, true, JSON.stringify(listed));
      assert.ok(
        JSON.stringify(listed).includes('Shared original') ||
          JSON.stringify(listed).includes(String(pattern)),
      );
    },
  );
  const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${pattern}&action=edit`);
  const caller = await site.createCaller(tab);
  const beforePattern = await storedDocument(site, pattern);

  try {
    const connected = await caller.connect({
      target: { site_url: site.site, post_id: pattern, post_type: 'wp_block' },
      workflow: 'background',
    });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    const change = {
      op: 'update',
      path: [0],
      name: 'core/paragraph',
      attributes: { content: 'Shared revised' },
    };
    await assertRefused(site, pattern, beforePattern, await caller.edit({ edits: [change] }));
    const result = await caller.edit({ scope: 'all_references', edits: [change] });
    assert.equal(result.ok, true, JSON.stringify(result));
    const saved = await caller.save();
    const { after: stored } = await assertSavedCleanly(site, pattern, beforePattern, saved);
    assert.equal(stored.content, paragraph('Shared revised'));

    for (const id of [first, second])
      assert.match((await frontEnd(site, id)).html, /Shared revised/);
  } finally {
    await caller.release().catch(() => undefined);
    await tab.close();
  }
});

test('reference insertion, replacement, removal and stale tokens preserve patterns', async () => {
  const first = await seedDocument(site, { type: 'wp_block', content: paragraph('Pattern one') });
  const second = await seedDocument(site, { type: 'wp_block', content: paragraph('Pattern two') });
  const original = await storedDocument(site, first);
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before }) => {
    const a = await inspect(blockwork, first);
    const b = await inspect(blockwork, second);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    const inserted = await blockwork.edit({
      edits: [{ op: 'insert_reference', reference: reference(first, a.reference_token) }],
    });
    assert.equal(inserted.ok, true, JSON.stringify(inserted));
    const replaced = await blockwork.edit({
      edits: [
        {
          op: 'update_reference',
          path: [1],
          name: 'core/block',
          reference: reference(second, b.reference_token),
        },
      ],
    });
    assert.equal(replaced.ok, true, JSON.stringify(replaced));
    const removed = await blockwork.edit({
      edits: [{ op: 'remove', path: [1], name: 'core/block' }],
    });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    const updated = await blockwork.edit({
      edits: [
        {
          op: 'update',
          path: [0],
          name: 'core/paragraph',
          attributes: { content: 'Changed anchor' },
        },
      ],
    });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    const saved = await blockwork.save();
    const { after: stored } = await assertSavedCleanly(site, id, before, saved);
    assert.equal(stored.content, paragraph('Changed anchor'));
    assert.equal((await storedDocument(site, first)).content, original.content);
    assert.equal((await storedDocument(site, second)).content, paragraph('Pattern two'));
  });
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before }) => {
    const inspected = await inspect(blockwork, first);
    await site.php(`wp_update_post(['ID' => ${first}, 'post_title' => 'Changed pattern']);`);
    const result = await blockwork.edit({
      edits: [{ op: 'insert_reference', reference: reference(first, inspected.reference_token) }],
    });
    await assertRefused(site, id, before, result, { error: 'stale_entity_reference' });
  });
  // The page stores only the reference, so a later pattern change doesn't block its save.
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before }) => {
    const inspected = await inspect(blockwork, second);
    const inserted = await blockwork.edit({
      edits: [{ op: 'insert_reference', reference: reference(second, inspected.reference_token) }],
    });
    assert.equal(inserted.ok, true, JSON.stringify(inserted));
    await site.php(
      `wp_update_post(['ID' => ${second}, 'post_content' => '${paragraph('Changed pattern')}']);`,
    );
    const saved = await blockwork.save();
    const { after: stored } = await assertSavedCleanly(site, id, before, saved);
    assert.ok(stored.content.includes(referenceBlock(second)), stored.content);
    assert.equal((await storedDocument(site, second)).content, paragraph('Changed pattern'));
  });
});

test('unsynced patterns are excluded from discovery and recursive references refuse', async () => {
  const owner = await seedDocument(site, { type: 'wp_block', content: paragraph('Owner') });
  const child = await seedDocument(site, { type: 'wp_block', content: referenceBlock(owner) });
  const unsynced = await seedDocument(site, {
    type: 'wp_block',
    content: paragraph('Unsynced'),
    meta: { wp_pattern_sync_status: 'unsynced' },
  });
  const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${owner}&action=edit`);
  const caller = await site.createCaller(tab);
  const beforeOwner = await storedDocument(site, owner);

  try {
    const connected = await caller.connect({
      target: { site_url: site.site, post_id: owner, post_type: 'wp_block' },
      workflow: 'background',
    });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    const listed = await caller.call({
      operation: 'list_entities',
      target: siteTarget(),
      entity_type: 'wp_block',
    });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.ok(
      !listed.items.some((item) => item.target.post_id === unsynced),
      JSON.stringify(listed),
    );
    const inspected = await inspect(caller, child);
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const result = await caller.edit({
      scope: 'all_references',
      edits: [{ op: 'insert_reference', reference: reference(child, inspected.reference_token) }],
    });
    await assertRefused(site, owner, beforeOwner, result, { error: 'recursive_entity_reference' });
  } finally {
    await caller.release().catch(() => undefined);
    await tab.close();
  }
});

for (const type of ['wp_template', 'wp_template_part']) {
  test(`${type} uses Site Editor identity and requires site-wide scope`, async () => {
    await withDocument(site, { content: paragraph('Discovery') }, async ({ blockwork }) => {
      const listed = await blockwork.call({
        operation: 'list_entities',
        target: siteTarget(),
        entity_type: type,
      });
      assert.equal(listed.ok, true, JSON.stringify(listed));
      const target = listed.items[0].target;
      assert.match(target.post_id, /^twentytwentyfive\/\//);
      const invalid = await inspect(blockwork, 1, type);
      assert.equal(invalid.ok, false, JSON.stringify(invalid));
      assert.ok(invalid.hint && invalid.next, JSON.stringify(invalid));
      const entity = await blockwork.call({ operation: 'inspect_entity', target });
      assert.equal(entity.ok, true, JSON.stringify(entity));
      const tab = await site.openTab(entity.editor_url);
      const caller = await site.createCaller(tab);

      try {
        const { user_id: _userId, ...connectTarget } = target;
        const connected = await caller.connect({ target: connectTarget, workflow: 'background' });
        assert.equal(connected.ok, true, JSON.stringify(connected));
        const result = await caller.edit({
          edits: [
            {
              op: 'insert',
              block: { name: 'core/paragraph', attributes: { content: 'Site wide' } },
            },
          ],
        });
        assert.equal(result.ok, false, JSON.stringify(result));
        assert.ok(result.hint && result.next, JSON.stringify(result));
        const release = await caller.release();
        assert.equal(release.cleanup, 'no_post_lock', JSON.stringify(release));
      } finally {
        await caller.release().catch(() => undefined);
        await tab.close();
      }
    });
  });
}

test('empty Query preview refuses the whole edit before mutation', async () => {
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before }) => {
    const result = await blockwork.edit({
      edits: [{ op: 'insert', block: query({ search: 'no-matching-fixture-post-9471' }) }],
    });
    await assertRefused(site, id, before, result, { error: 'query_preview_empty' });
  });
});

generated('dynamic blocks obey native page insertion policy', async (t) => {
  const names = [
    'core/post-title',
    'core/post-content',
    'core/post-excerpt',
    'core/post-featured-image',
    'core/term-description',
    'core/latest-posts',
    'core/categories',
    'core/archives',
    'core/rss',
    'core/search',
    'core/tag-cloud',
    'core/site-title',
    'core/site-tagline',
    'core/site-logo',
  ];

  const selected = names.filter((name) => t.selected(name));

  if (!selected.length) return;
  await withDocument(
    site,
    { content: paragraph('Anchor') },
    async ({ blockwork, tab, id, before }) => {
      let accepted = false;

      for (const name of selected) {
        const leaf = await t.test(name, async () => {
          const allowed = await site.evaluate(
            tab,
            `wp.data.select('core/block-editor').canInsertBlockType(${JSON.stringify(name)})`,
          );
          const result = await blockwork.edit({ edits: [{ op: 'insert', block: { name } }] });

          if (allowed) {
            assert.equal(result.ok, true, JSON.stringify(result));
            accepted = true;
          } else {
            await assertRefused(site, id, before, result, { error: 'insertion_refused' });
          }
        });

        if (!leaf.completed) return;
      }

      if (accepted) {
        const saved = await blockwork.save();
        await assertSavedCleanly(site, id, before, saved);
      }
    },
  );
});

generated(
  'inserting a Query leaves the page valid',
  { findings: [] },
  async (t) => {
    for (const [name, options, updateQuery] of [
      ['insertion', {}, false],
      [
        'existing Query with no results and a sibling insert',
        {},
        true,
      ],
    ]) {
      await t.test(name, options, async () => {
        await seedDocument(site, {
          type: 'post',
          content: paragraph('Post body'),
          title: 'Query fixture',
        });
        await withDocument(
          site,
          { content: paragraph('Anchor') },
          async ({ blockwork, id, before }) => {
            const result = await blockwork.edit({ edits: [{ op: 'insert', block: query() }] });
            assert.equal(result.ok, true, JSON.stringify(result));

            if (updateQuery) {
              const update = await blockwork.edit({
                edits: [
                  {
                    op: 'update',
                    path: [1],
                    name: 'core/query',
                    attributes: { query: { search: 'no-matching-fixture-post-9471' } },
                  },
                  {
                    op: 'insert',
                    block: {
                      name: 'core/buttons',
                      inner_blocks: [{ name: 'core/button', attributes: { text: 'Continue' } }],
                    },
                  },
                ],
              });
              assert.equal(update.ok, true, JSON.stringify(update));
            }

            const saved = await blockwork.save();
            await assertSavedCleanly(site, id, before, saved);
          },
        );
      });
    }
  },
);

test('post-meta binding survives a neighbor edit and writes through its backing field', async () => {
  const bound = block(
    'paragraph',
    {
      metadata: {
        bindings: { content: { source: 'core/post-meta', args: { key: 'bw_shared_field' } } },
      },
    },
    '<p>Fallback</p>',
  );
  await withDocument(
    site,
    { content: doc(bound, paragraph('Neighbor')), meta: { bw_shared_field: 'Original field' } },
    async ({ blockwork, id, before }) => {
      const result = await blockwork.edit({
        edits: [
          {
            op: 'update',
            path: [1],
            name: 'core/paragraph',
            attributes: { content: 'Revised neighbor' },
          },
        ],
        binding_writes: [
          { path: [0], name: 'core/paragraph', attribute: 'content', value: 'Revised field' },
        ],
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      const saved = await blockwork.save();
      const { after: stored } = await assertSavedCleanly(site, id, before, saved, {
        allow: ['meta'],
      });
      assert.equal(stored.content, doc(bound, paragraph('Revised neighbor')));
      assert.deepEqual(stored.meta.bw_shared_field, ['Revised field']);
    },
  );
});

generated(
  'bound attributes refuse direct writes while a neighbor edit preserves every binding',
  async (t) => {
    const cases = [];

    for (const source of [
      'core/post-meta',
      'blockwork/fixture',
      'blockwork/unregistered',
      'core/pattern-overrides',
    ]) {
      for (const name of ['paragraph', 'heading', 'image', 'button']) {
        const attribute = name === 'image' ? 'url' : name === 'button' ? 'text' : 'content';
        cases.push({
          source,
          name,
          attribute,
          attributes: {
            metadata: { bindings: { [attribute]: { source, args: { key: 'bw_shared_field' } } } },
          },
        });
      }
    }

    const expression = cases.map(
      ({ name, attributes }) =>
        'wp.blocks.createBlock(' +
        JSON.stringify('core/' + name) +
        ',' +
        JSON.stringify(attributes) +
        ')',
    );
    expression.push("wp.blocks.createBlock('core/paragraph',{content:'Neighbor'})");
    const markup = await serializeNatively(site, '[' + expression.join(',') + ']');
    await withDocument(
      site,
      { content: markup, meta: { bw_shared_field: 'Original field' } },
      async ({ blockwork, id, before }) => {
        for (const [index, item] of cases.entries()) {
          await t.test(item.source + ' on ' + item.name, async () => {
            const refused = await blockwork.edit({
              edits: [
                {
                  op: 'update',
                  path: [index],
                  name: 'core/' + item.name,
                  attributes: { [item.attribute]: 'Changed' },
                },
              ],
            });
            await assertRefused(site, id, before, refused, { error: 'bound_block_unsupported' });
          });
        }

        await t.test('neighbor edit preserves every binding', async () => {
          const result = await blockwork.edit({
            edits: [
              {
                op: 'update',
                path: [cases.length],
                name: 'core/paragraph',
                attributes: { content: 'Changed neighbor' },
              },
            ],
          });
          assert.equal(result.ok, true, JSON.stringify(result));
          const { after: stored } = await assertSavedCleanly(
            site,
            id,
            before,
            await blockwork.save(),
          );
          assert.equal(
            stored.content,
            markup.replace('<p>Neighbor</p>', '<p>Changed neighbor</p>'),
          );
        });
      },
    );
  },
);

for (const name of ['core/site-title', 'core/site-tagline']) {
  test(`${name} update cannot silently write site settings`, async () => {
    const markup = await serializeNatively(
      site,
      `[wp.blocks.createBlock(${JSON.stringify(name)})]`,
    );
    const settings = await site.php(
      "echo json_encode([get_option('blogname'),get_option('blogdescription')]);",
    );
    await withDocument(site, { content: markup }, async ({ blockwork, id, before }) => {
      const result = await blockwork.edit({
        edits: [
          { op: 'update', path: [0], name, attributes: { content: 'Unapproved site change' } },
        ],
      });
      await assertRefused(site, id, before, result);
      assert.deepEqual(
        await site.php("echo json_encode([get_option('blogname'),get_option('blogdescription')]);"),
        settings,
      );
    });
  });
}

test(
  'Post Date insertion round-trips without preceding dynamic inserts',
  async () => {
    await withDocument(
      site,
      { content: paragraph('Anchor') },
      async ({ blockwork, id, before }) => {
        const result = await blockwork.edit({
          edits: [{ op: 'insert', block: { name: 'core/post-date' } }],
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        await assertSavedCleanly(site, id, before, await blockwork.save());
      },
    );
  },
);

test('dynamic Post Date insertion preserves its native post-data binding', async () => {
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before }) => {
    const result = await blockwork.edit({
      edits: [{ op: 'insert', block: { name: 'core/post-date' } }],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.deepEqual((await storedTree(site, id)).filter((block) => block.blockName)[1].attrs.metadata.bindings.datetime, { source: 'core/post-data', args: { field: 'date' } });
  });
});

test('literal Post Date insertion preserves the requested datetime', async () => {
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before }) => {
    const result = await blockwork.edit({
      edits: [
        {
          op: 'insert',
          block: { name: 'core/post-date', attributes: { datetime: '2026-01-01T00:00:00' } },
        },
      ],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(
      (await storedTree(site, id)).filter((block) => block.blockName)[1].attrs.datetime,
      '2026-01-01T00:00:00',
    );
  });
});

test(
  'empty Query update with sibling insertion in a fresh document',
  {},
  async () => {
    const markup = await serializeNatively(
      site,
      "[wp.blocks.createBlock('core/query',{queryId:99,query:{inherit:false,postType:'post',perPage:2}},[wp.blocks.createBlock('core/post-template',{},[wp.blocks.createBlock('core/post-title')])])]",
    );
    await withDocument(
      site,
      { content: markup },
      async ({ blockwork, id, before }) => {
        const result = await blockwork.edit({
          edits: [
            { op: 'update', path: [0, 0, 0], name: 'core/post-title', attributes: { level: 3 } },
            {
              op: 'update',
              path: [0],
              name: 'core/query',
              attributes: { query: { search: 'no-matching-fixture-post-9471' } },
            },
            {
              op: 'insert',
              block: {
                name: 'core/buttons',
                inner_blocks: [{ name: 'core/button', attributes: { text: 'Continue' } }],
              },
            },
          ],
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        await assertSavedCleanly(
          site,
          id,
          before,
          await blockwork.save({ save_all_pending: true }),
        );
      },
      { workflow: 'attached' },
    );
  },
);

for (const attributes of [
  { inherit: true, perPage: 7 },
  { inherit: false, perPage: 3, excludeCurrent: true },
  { inherit: false, sticky: 'only' },
  { inherit: false, postType: 'bw_shared_item' },
]) {
  test(
    `Query initialization preserves requested attributes ${JSON.stringify(attributes)}`,
    {
      todo:
        attributes.inherit || attributes.excludeCurrent ? 'finding: query-requested-values' : false,
    },
    async () => {
      await seedDocument(site, {
        type: attributes.postType ?? 'post',
        content: paragraph('Query match'),
        extra: { sticky: true },
      });

      if (attributes.sticky)
        await site.php("$p=get_posts(['numberposts'=>1]);stick_post($p[0]->ID);");
      await withDocument(
        site,
        { content: paragraph('Anchor') },
        async ({ blockwork, id, before }) => {
          const result = await blockwork.edit({
            edits: [{ op: 'insert', block: query(attributes) }],
          });
          assert.equal(result.ok, true, JSON.stringify(result));
          const { after: stored } = await assertSavedCleanly(
            site,
            id,
            before,
            await blockwork.save(),
          );
          const tree = (await storedTree(site, id)).filter((item) => item.blockName);

          for (const [key, value] of Object.entries(attributes))
            assert.deepEqual(tree[1].attrs.query[key], value, stored.content);
        },
      );
    },
  );
}

test('unavailable Query context refuses a mixed batch without inserting its sibling', async () => {
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before, tab }) => {
    const result = await blockwork.edit({
      edits: [
        {
          op: 'insert',
          block: { name: 'core/paragraph', attributes: { content: 'Never inserted' } },
        },
        { op: 'insert', block: query({ postType: 'unregistered_fixture' }) },
      ],
    });
    await assertRefused(site, id, before, result, { error: 'query_preview_unavailable' });
    assert.equal(result.diagnostics.completed_edits, undefined);
    assert.equal(result.editor_result, 'not_applied');
    assert.equal(
      await site.evaluate(tab, "wp.data.select('core/editor').getEditedPostContent()"),
      before.content,
    );
  });
});

test('category Query updates beside an unrelated insert read no preview', async () => {
  const categories = await site.php(
    "$a=wp_insert_term('Fixture category A','category');$b=wp_insert_term('Fixture category B','category');echo json_encode([$a['term_id'],$b['term_id']]);",
  );
  const post = await seedDocument(site, { type: 'post', content: paragraph('Categorized') });
  await site.php(`wp_set_post_categories(${post},${JSON.stringify(categories)});`);
  const tree = query({ taxQuery: { include: { category: categories } } });
  const markup = await serializeNatively(
    site,
    `[wp.blocks.createBlock('core/query',${JSON.stringify({ ...tree.attributes, queryId: 99 })},[wp.blocks.createBlock('core/post-template',{},[wp.blocks.createBlock('core/post-title')])])]`,
  );
  await withDocument(
    site,
    { content: markup },
    async ({ blockwork, id, before }) => {
      const result = await blockwork.edit({
        edits: [
          {
            op: 'update',
            path: [0, 0],
            name: 'core/post-template',
            attributes: { layout: { type: 'grid', columnCount: 2 } },
          },
          {
            op: 'insert',
            block: {
              name: 'core/buttons',
              inner_blocks: [{ name: 'core/button', attributes: { text: 'Continue' } }],
            },
          },
        ],
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      await assertSavedCleanly(site, id, before, await blockwork.save({ save_all_pending: true }));
      assert.deepEqual(
        (await storedTree(site, id)).find((item) => item.blockName === 'core/query').attrs.query
          .taxQuery,
        tree.attributes.query.taxQuery,
      );
    },
    { workflow: 'attached' },
  );
});

test('Query nested in Group and Columns supports all post context children', async () => {
  await seedDocument(site, { type: 'post', content: paragraph('Nested match') });
  const inner = query();
  inner.inner_blocks[0].inner_blocks = [
    'post-title',
    'post-content',
    'post-excerpt',
    'post-featured-image',
    'post-date',
    'post-author',
    'post-terms',
  ].map((name) => ({
    name: `core/${name}`,
    attributes:
      name === 'post-terms'
        ? { term: 'category' }
        : name === 'post-date'
          ? { datetime: '2026-01-01T00:00:00' }
          : {},
  }));
  inner.inner_blocks.push(
    {
      name: 'core/query-pagination',
      inner_blocks: ['previous', 'numbers', 'next'].map((suffix) => ({
        name: 'core/query-pagination-' + suffix,
      })),
    },
    {
      name: 'core/query-no-results',
      inner_blocks: [{ name: 'core/paragraph', attributes: { content: 'No matches' } }],
    },
  );
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before }) => {
    const result = await blockwork.edit({
      edits: [
        {
          op: 'insert',
          block: {
            name: 'core/columns',
            inner_blocks: [
              {
                name: 'core/column',
                inner_blocks: [{ name: 'core/group', inner_blocks: [inner] }],
              },
            ],
          },
        },
      ],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    await assertSavedCleanly(site, id, before, await blockwork.save());
    const columns = (await storedTree(site, id)).find(
      (block) => block.blockName === 'core/columns',
    );
    const column = columns.innerBlocks.find((block) => block.blockName === 'core/column');
    const group = column.innerBlocks.find((block) => block.blockName === 'core/group');
    const savedQuery = group.innerBlocks.find((block) => block.blockName === 'core/query');
    assert.ok(Number.isInteger(savedQuery.attrs.queryId));
  });
});

async function withShared(type, body, entityId) {
  await withDocument(site, { content: paragraph('Shared discovery') }, async ({ blockwork }) => {
    const listed = await blockwork.call({
      operation: 'list_entities',
      target: siteTarget(),
      entity_type: type,
    });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    const target = entityId ? entityTarget(entityId, type) : listed.items[0].target;
    const inspected = await blockwork.call({ operation: 'inspect_entity', target });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const tab = await site.openTab(inspected.editor_url);
    const caller = await site.createCaller(tab);

    try {
      const { user_id: _userId, ...connectTarget } = target;
      const connected = await caller.connect({ target: connectTarget, workflow: 'background' });
      assert.equal(connected.ok, true, JSON.stringify(connected));
      await body({ caller, tab, target, inspected });
    } finally {
      const released = await caller.release();
      assert.equal(released.cleanup, 'no_post_lock', JSON.stringify(released));
      await tab.close();
    }
  });
}

test('an older template part takes an edit after the user saves it in the Site Editor', async () => {
  const encoded = Buffer.from(olderAccordion).toString('base64');
  const { theme } = await site.php(`
    kses_remove_filters();
    $id = wp_insert_post(['post_type' => 'wp_template_part', 'post_status' => 'publish', 'post_name' => 'older-part', 'post_title' => 'Older part', 'post_content' => base64_decode('${encoded}')], true);
    wp_set_object_terms($id, get_stylesheet(), 'wp_theme');
    wp_set_object_terms($id, 'uncategorized', 'wp_template_part_area');
    echo wp_json_encode(['theme' => get_stylesheet()]);
  `);
  const target = entityTarget(`${theme}//older-part`, 'wp_template_part');
  await withDocument(site, { content: paragraph('Discovery') }, async ({ blockwork }) => {
    const inspected = await blockwork.call({ operation: 'inspect_entity', target });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const tab = await site.openTab(inspected.editor_url);
    const caller = await site.createCaller(tab);

    try {
      const { user_id: _userId, ...connectTarget } = target;
      const opened = await caller.connect({ target: connectTarget, workflow: 'attached' });
      assert.equal(opened.ok, true, JSON.stringify(opened));
      const change = {
        scope: 'site_wide',
        edits: [
          {
            op: 'update',
            client_id: opened.blocks.at(-1).client_id,
            attributes: { content: 'Changed' },
          },
        ],
      };
      assert.equal((await caller.edit(change)).error, 'initial_serialization_changed');
      assert.equal((await caller.prepare_resave()).dirty, true);
      await site.evaluate(
        tab,
        `(async () => {
          document.querySelector('.editor-post-publish-button').click();
          await new Promise((done) => setTimeout(done, 500));
          document.querySelector('.editor-entities-saved-states__save-button')?.click();
        })()`,
      );
      const waited = await caller.wait_for_save();
      assert.equal(waited.dirty, false, JSON.stringify(waited));
      const edited = await caller.edit(change);
      assert.equal(edited.ok, true, JSON.stringify(edited));
      const saved = await caller.save({ save_all_pending: true });
      assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
    } finally {
      await caller.release().catch(() => undefined);
      await tab.close();
    }
  });
});

for (const type of ['wp_template', 'wp_template_part']) {
  test(`${type} first save creates an override and a second edit persists`, async () => {
    await withShared(type, async ({ caller, target }) => {
      const first = await caller.edit({
        scope: 'site_wide',
        edits: [
          {
            op: 'insert',
            block: { name: 'core/paragraph', attributes: { content: 'First override' } },
          },
        ],
      });
      assert.equal(first.ok, true, JSON.stringify(first));
      const saved = await caller.save();
      assert.equal(saved.ok, true, JSON.stringify(saved));
      assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
      const inspected = await caller.call({ operation: 'inspect_entity', target });
      assert.equal(inspected.ok, true, JSON.stringify(inspected));
      assert.match(JSON.stringify(inspected), /custom/);
      const second = await caller.edit({
        scope: 'site_wide',
        edits: [
          {
            op: 'insert',
            block: { name: 'core/paragraph', attributes: { content: 'Second override' } },
          },
        ],
      });
      assert.equal(second.ok, true, JSON.stringify(second));
      const again = await caller.save();
      assert.equal(again.ok, true, JSON.stringify(again));
      assert.equal(again.persistence, 'verified', JSON.stringify(again));
    });
  });
  test(`${type} refuses a saved record changed by another client`, async () => {
    await withShared(type, async ({ caller, target, inspected }) => {
      const edited = await caller.edit({
        scope: 'site_wide',
        edits: [
          {
            op: 'insert',
            block: { name: 'core/paragraph', attributes: { content: 'Pending override' } },
          },
        ],
      });
      assert.equal(edited.ok, true, JSON.stringify(edited));
      const entity = await site.php(
        `$t=get_block_template(${JSON.stringify(target.post_id)},${JSON.stringify(type)});echo json_encode(['id'=>$t->wp_id]);`,
      );
      assert.ok(entity.id, JSON.stringify(inspected));
      await site.php(
        `wp_update_post(['ID'=>${entity.id},'post_content'=>'${paragraph('External override')}']);`,
      );
      const result = await caller.save();
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.error, 'saved_record_changed', JSON.stringify(result));
      assert.ok(result.hint && result.next, JSON.stringify(result));
    });
  });
}

test('navigation add, submenu, reorder and ampersand labels persist as children', async () => {
  const navigation = await seedDocument(site, {
    type: 'wp_navigation',
    content: block('navigation-link', {
      label: 'Original',
      url: 'https://example.test/original',
      kind: 'custom',
    }),
  });
  await withShared(
    'wp_navigation',
    async ({ caller }) => {
      const result = await caller.edit({
        scope: 'site_wide',
        edits: [
          {
            op: 'insert',
            block: {
              name: 'core/navigation-submenu',
              attributes: { label: 'More & help' },
              inner_blocks: [
                {
                  name: 'core/navigation-link',
                  attributes: { label: 'Help', url: 'https://example.test/help', kind: 'custom' },
                },
              ],
            },
          },
          {
            op: 'insert',
            block: {
              name: 'core/navigation-link',
              attributes: { label: 'About', url: 'https://example.test/about', kind: 'custom' },
            },
          },
          { op: 'move', path: [2], name: 'core/navigation-link', index: 0 },
        ],
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      // A Navigation post has no post.php editor to reopen, so this checks what's stored.
      const saved = await caller.save();
      assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
      const tree = (await storedTree(site, navigation)).filter((item) => item.blockName);
      assert.deepEqual(
        tree.map((item) => item.blockName),
        ['core/navigation-link', 'core/navigation-link', 'core/navigation-submenu'],
      );
      // A label is a plain string attribute, and PHP escapes it when rendering.
      assert.equal(tree[2].attrs.label, 'More & help');
    },
    navigation,
  );
  const navigationContent = (await storedDocument(site, navigation)).content;
  await withDocument(
    site,
    { content: doc(block('navigation', { ref: navigation }), paragraph('Neighbor')) },
    async ({ blockwork, id, before: original }) => {
      const result = await blockwork.edit({
        edits: [
          {
            op: 'update',
            path: [1],
            name: 'core/paragraph',
            attributes: { content: 'Changed neighbor' },
          },
        ],
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      await assertSavedCleanly(site, id, original, await blockwork.save());
      assert.equal((await storedDocument(site, navigation)).content, navigationContent);
    },
  );
});

for (const classic of [false, true]) {
  test(`Navigation without ref preserves page content with classic fallback ${classic}`, async () => {
    if (classic)
      await site.php(
        "$m=wp_create_nav_menu('Fixture classic');wp_update_nav_menu_item($m,0,['menu-item-title'=>'Classic link','menu-item-url'=>'https://example.test/classic','menu-item-status'=>'publish']);",
      );
    await withDocument(
      site,
      { content: doc(block('navigation'), paragraph('Neighbor')) },
      async ({ doc: connected, id, before }) => {
        await assertRefused(site, id, before, connected, { error: 'editor_not_clean' });
      },
      { connected: false },
    );
  });
}

test('pattern instance content overrides survive neighboring edits without changing source', async () => {
  const bound = paragraph('Default question', {
    metadata: { name: 'Question', bindings: { content: { source: 'core/pattern-overrides' } } },
  });
  const pattern = await seedDocument(site, { type: 'wp_block', content: bound });
  const instance = block('block', {
    ref: pattern,
    content: { Question: { content: 'Visible FAQ question' } },
  });
  await withDocument(
    site,
    { content: doc(instance, paragraph('Neighbor')) },
    async ({ blockwork, id, before }) => {
      const edited = await blockwork.edit({
        edits: [
          {
            op: 'update',
            path: [0],
            name: 'core/block',
            attributes: { content: { Question: { content: 'Changed FAQ question' } } },
          },
          {
            op: 'update',
            path: [1],
            name: 'core/paragraph',
            attributes: { content: 'Changed neighbor' },
          },
        ],
      });
      assert.equal(edited.ok, true, JSON.stringify(edited));
      const { after: stored } = await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal(
        stored.content,
        doc(
          block('block', {
            ref: pattern,
            content: { Question: { content: 'Changed FAQ question' } },
          }),
          paragraph('Changed neighbor'),
        ),
      );
      assert.equal((await storedDocument(site, pattern)).content, bound);
      assert.match((await frontEnd(site, id)).html, /Changed FAQ question/);
    },
  );
});

test('attached save identifies a dirty shared entity left outside page persistence', async () => {
  const pattern = await seedDocument(site, {
    type: 'wp_block',
    content: paragraph('Shared original'),
  });
  await withDocument(
    site,
    { content: doc(referenceBlock(pattern), paragraph('Neighbor')) },
    async ({ blockwork, tab, id, before }) => {
      await site.evaluate(
        tab,
        `(async()=>{await wp.data.resolveSelect('core').getEntityRecord('postType','wp_block',${pattern});wp.data.dispatch('core').editEntityRecord('postType','wp_block',${pattern},{content:${JSON.stringify(paragraph('Dirty shared change'))}});return true;})()`,
      );
      const edited = await blockwork.edit({
        edits: [
          {
            op: 'update',
            path: [1],
            name: 'core/paragraph',
            attributes: { content: 'Page change' },
          },
        ],
      });
      assert.equal(edited.ok, true, JSON.stringify(edited));
      const saved = await blockwork.save({ save_all_pending: true });
      const remainingDirty = await site.evaluate(
        tab,
        `wp.data.select('core').hasEditsForEntityRecord('postType','wp_block',${pattern})`,
      );
      await assertSavedCleanly(site, id, before, saved);
      const patternSaved =
        (await storedDocument(site, pattern)).content === paragraph('Dirty shared change');
      assert.ok(
        (patternSaved && !remainingDirty) || saved.saved_all_pending !== true,
        JSON.stringify({ saved, patternSaved, remainingDirty }),
      );
    },
    { workflow: 'attached' },
  );
});

test('binding writes reject a custom source and a foreign Query context', async () => {
  for (const source of ['blockwork/fixture', 'blockwork/unregistered']) {
    const markup = paragraph('Fallback', { metadata: { bindings: { content: { source } } } });
    await withDocument(site, { content: markup }, async ({ blockwork, id, before }) => {
      const result = await blockwork.edit({
        binding_writes: [
          { path: [0], name: 'core/paragraph', attribute: 'content', value: 'Changed' },
        ],
      });
      await assertRefused(site, id, before, result);
    });
  }

  const bound = {
    name: 'core/paragraph',
    attributes: {
      content: 'Fallback',
      metadata: {
        bindings: { content: { source: 'core/post-meta', args: { key: 'bw_shared_field' } } },
      },
    },
  };
  const markup = await serializeNatively(
    site,
    `[wp.blocks.createBlock('core/query',{queryId:99,query:{inherit:false,postType:'post',perPage:2}},[wp.blocks.createBlock('core/post-template',{},[wp.blocks.createBlock(${JSON.stringify(bound.name)},${JSON.stringify(bound.attributes)})])])]`,
  );
  await withDocument(
    site,
    { content: markup, meta: { bw_shared_field: 'Original field' } },
    async ({ blockwork, id, before }) => {
      const result = await blockwork.edit({
        binding_writes: [
          { path: [0, 0, 0], name: 'core/paragraph', attribute: 'content', value: 'Wrong context' },
        ],
      });
      await assertRefused(site, id, before, result);
    },
    { workflow: 'attached' },
  );
});

test('template Query and Post Content can be edited without editing the page entity', async () => {
  await seedDocument(site, { type: 'post', content: paragraph('Template query match') });
  await withShared('wp_template', async ({ caller, target }) => {
    const result = await caller.edit({
      scope: 'site_wide',
      edits: [
        { op: 'insert', block: query() },
        { op: 'insert', block: { name: 'core/post-content' } },
      ],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const content = result.changed.find((item) => item.name === 'core/post-content');
    assert.ok(content, JSON.stringify(result));
    const updated = await caller.edit({
      scope: 'site_wide',
      edits: [
        {
          op: 'update',
          client_id: content.client_id,
          attributes: { className: 'fixture-content' },
        },
      ],
    });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    const saved = await caller.save();
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
    const inspected = await caller.call({ operation: 'inspect_entity', target });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
  });
});

test('multi-category Query insertion supports taxonomy previews alongside a sibling', async () => {
  const categories = await site.php(
    "$a=wp_insert_term('Insert category A','category');$b=wp_insert_term('Insert category B','category');echo json_encode([$a['term_id'],$b['term_id']]);",
  );
  const post = await seedDocument(site, {
    type: 'post',
    content: paragraph('Multi-category match'),
  });
  await site.php(`wp_set_post_categories(${post},${JSON.stringify(categories)});`);
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before }) => {
    const result = await blockwork.edit({
      edits: [
        { op: 'insert', block: query({ taxQuery: { include: { category: categories } } }) },
        { op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'Sibling' } } },
      ],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.deepEqual(
      (await storedTree(site, id)).find((item) => item.blockName === 'core/query').attrs.query
        .taxQuery,
      { include: { category: categories } },
    );
  });
});

test('pattern metadata survives copying a serialized section through replacement', async () => {
  const markup = await serializeNatively(
    site,
    "[wp.blocks.createBlock('core/group',{metadata:{patternName:'fixture/section',categories:['fixture']}},[wp.blocks.createBlock('core/paragraph',{content:'Pattern text'})])]",
  );
  await withDocument(
    site,
    { content: doc(markup, paragraph('Neighbor')) },
    async ({ blockwork, id, before }) => {
      const result = await blockwork.edit({
        edits: [
          { op: 'replace', path: [0], name: 'core/group', markup },
          {
            op: 'update',
            path: [1],
            name: 'core/paragraph',
            attributes: { content: 'Changed neighbor' },
          },
        ],
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      const { after: stored } = await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal(stored.content, doc(markup, paragraph('Changed neighbor')));
    },
  );
});

for (const name of ['heading', 'image', 'button']) {
  test(`post-meta binding writes update the backing value for ${name}`, async () => {
    const attribute = name === 'image' ? 'url' : name === 'button' ? 'text' : 'content';
    const attributes = {
      metadata: {
        bindings: { [attribute]: { source: 'core/post-meta', args: { key: 'bw_shared_field' } } },
      },
    };
    const markup = await serializeNatively(
      site,
      `[wp.blocks.createBlock('core/${name}',${JSON.stringify(attributes)})]`,
    );
    await withDocument(
      site,
      { content: markup, meta: { bw_shared_field: 'Original field' } },
      async ({ blockwork, id, before }) => {
        const result = await blockwork.edit({
          binding_writes: [
            { path: [0], name: `core/${name}`, attribute, value: 'https://example.test/revised' },
          ],
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        const { after: stored } = await assertSavedCleanly(
          site,
          id,
          before,
          await blockwork.save(),
          { allow: ['meta'] },
        );
        assert.equal(stored.content, markup);
        assert.deepEqual(stored.meta.bw_shared_field, ['https://example.test/revised']);
      },
    );
  });
}

run();
