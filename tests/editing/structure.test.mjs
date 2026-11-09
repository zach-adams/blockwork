import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';

import { doc, group, paragraph } from './blocks.mjs';
import {
  assertRefused,
  assertSavedCleanly,
  changedPaths,
  startEditingSite,
  serializeNatively,
  storedDocument,
  storedTree,
  seedDocument,
  waitFor,
  withDocument,
} from './harness.mjs';

const { after, before, generated, test, run } = editingTests(import.meta.url);
let site;
before(async () => {
  site = await startEditingSite();
});
after(() => site?.[Symbol.asyncDispose]());

const p = (content) => ({ name: 'core/paragraph', attributes: { content } });
const ok = (result) => assert.equal(result.ok, true, JSON.stringify(result));
const refusal = (result) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(result.hint?.length > 10 && result.next, JSON.stringify(result));
  assert.ok(
    ['not_attempted', 'not_applied', 'rolled_back'].includes(result.editor_result),
    JSON.stringify(result),
  );
};

async function savedPaths(id, before, blockwork, original, expected) {
  await assertSavedCleanly(site, id, before, await blockwork.save());
  assert.deepEqual(changedPaths(original, await storedTree(site, id)), expected);
}

test('wrap and unwrap preserve the existing blocks', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('One'), paragraph('Two'), paragraph('Unchanged')) },
    async ({ blockwork, id, before }) => {
      const original = await storedTree(site, id);
      ok(
        await blockwork.edit({
          edits: [
            { op: 'insert', index: 0, block: { name: 'core/group' } },
            { op: 'move', path: [1], parent: [0], index: 0 },
            { op: 'move', path: [1], parent: [0], index: 1 },
          ],
        }),
      );
      await savedPaths(id, before, blockwork, original, ['0', '0.0', '0.1', '1', '2']);
    },
  );
  await withDocument(
    site,
    { content: doc(group(paragraph('One'), paragraph('Two')), paragraph('Unchanged')) },
    async ({ blockwork, id, before }) => {
      const original = await storedTree(site, id);
      ok(
        await blockwork.edit({
          edits: [
            { op: 'move', path: [0, 0], index: 1 },
            { op: 'move', path: [0, 0], index: 2 },
            { op: 'remove', path: [0] },
          ],
        }),
      );
      await savedPaths(id, before, blockwork, original, ['0', '0.0', '0.1', '1', '2']);
    },
  );
});

test('batch selectors resolve against earlier edits and a bad edit is atomic', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('One'), paragraph('Two')) },
    async ({ blockwork, id, before }) => {
      const original = await storedTree(site, id);
      const bad = await blockwork.edit({
        edits: [
          { op: 'remove', path: [0] },
          { op: 'move', path: [9], index: 0 },
        ],
      });
      refusal(bad);
      await assertRefused(site, id, before, bad);
      ok(
        await blockwork.edit({
          edits: [
            { op: 'insert', index: 0, block: p('Inserted') },
            { op: 'move', path: [0], index: 2 },
            { op: 'replace', path: [0], block: p('Replacement') },
          ],
        }),
      );
      await savedPaths(id, before, blockwork, original, ['0', '2']);
    },
  );
});

test('index boundaries and a descendant move are safe', async () => {
  await withDocument(
    site,
    { content: doc(group(paragraph('Inside')), paragraph('End')) },
    async ({ blockwork, id, before }) => {
      for (const edit of [
        { op: 'insert', index: -1, block: p('Negative') },
        { op: 'insert', index: 99, block: p('Past end') },
        { op: 'move', path: [1], index: -1 },
        { op: 'move', path: [1], index: 99 },
        { op: 'move', path: [0], parent: [0], index: 0 },
      ]) {
        const result = await blockwork.edit({ edits: [edit] });
        refusal(result);
        await assertRefused(site, id, before, result);
      }

      const original = await storedTree(site, id);
      refusal(await blockwork.edit({ edits: [{ op: 'move', path: [1], index: 1 }] }));
      ok(
        await blockwork.edit({
          edits: [
            { op: 'insert', index: 0, block: p('First') },
            { op: 'insert', index: 3, block: p('Last') },
          ],
        }),
      );
      await savedPaths(id, before, blockwork, original, ['0', '0.0', '1', '1.0', '2', '3']);
    },
  );
});

test('32 edits are accepted and 33 are refused', async () => {
  await withDocument(
    site,
    { content: paragraph('Original') },
    async ({ blockwork, id, before }) => {
      const edits = Array.from({ length: 33 }, (_, index) => ({
        op: 'insert',
        block: p(`Item ${index}`),
      }));
      const refused = await blockwork.edit({ edits });
      refusal(refused);
      await assertRefused(site, id, before, refused);
      const original = await storedTree(site, id);
      ok(await blockwork.edit({ edits: edits.slice(0, 32) }));
      await savedPaths(
        id,
        before,
        blockwork,
        original,
        Array.from({ length: 32 }, (_, index) => String(index + 1)),
      );
    },
  );
});

test('revert undoes the latest edit and a batch', async () => {
  await withDocument(
    site,
    { content: paragraph('Original') },
    async ({ blockwork, id, before }) => {
      const original = await storedTree(site, id);
      ok(await blockwork.edit({ edits: [{ op: 'insert', block: p('First') }] }));
      ok(
        await blockwork.edit({
          edits: [
            { op: 'insert', block: p('Second') },
            { op: 'insert', block: p('Third') },
          ],
        }),
      );
      ok(await blockwork.revert());
      ok(await blockwork.edit({ edits: [{ op: 'insert', block: p('Final') }] }));
      await savedPaths(id, before, blockwork, original, ['1', '2']);
    },
  );
});

test('root Page Break follows native insertion policy', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('One'), paragraph('Two')) },
    async ({ blockwork, id, before, tab }) => {
      const native = await site.evaluate(
        tab,
        "wp.data.select('core/block-editor').canInsertBlockType('core/nextpage', '')",
      );
      assert.equal(native, true);
      const original = await storedTree(site, id);
      ok(
        await blockwork.edit({
          edits: [{ op: 'insert', index: 1, block: { name: 'core/nextpage' } }],
        }),
      );
      await savedPaths(id, before, blockwork, original, ['1', '2']);
    },
  );
});

generated(
  'inserting 50, 100 and 200 total blocks completes within the native limit',
  { findings: [] },
  async (t) => {
    for (const count of [49, 99, 199]) {
      await t.test(`${count + 1} blocks`, async (t) => {
        await withDocument(
          site,
          {
            content:
              count === 49
                ? doc(...Array.from({ length: 800 }, (_, i) => paragraph(`Existing ${i}`)))
                : paragraph('Anchor'),
          },
          async ({ blockwork, id, before }) => {
            const original = await storedTree(site, id);
            const start = performance.now();
            const result = await blockwork.edit({
              edits: [
                {
                  op: 'insert',
                  block: {
                    name: 'core/group',
                    attributes: { metadata: { name: 'Section' } },
                    inner_blocks: Array.from({ length: count }, (_, index) => p(`Item ${index}`)),
                  },
                },
              ],
            });
            const elapsed = performance.now() - start;
            t.diagnostic(`${count + 1} blocks: ${Math.round(elapsed)} ms`);
            ok(result);
            assert.ok(elapsed < 30_000, `${elapsed} ms`);
            await savedPaths(id, before, blockwork, original, [count === 49 ? '800' : '1']);
          },
        );
      });
    }
  },
);

test('per-block locks prohibit movement and removal without prohibiting content updates', async () => {
  await withDocument(
    site,
    {
      content: doc(paragraph('Locked', { lock: { move: true, remove: true } }), paragraph('Other')),
    },
    async ({ blockwork, id, before }) => {
      for (const edit of [
        { op: 'move', path: [0], index: 1 },
        { op: 'remove', path: [0] },
        { op: 'update', path: [0], attributes: { lock: { move: false, remove: false } } },
      ]) {
        const result = await blockwork.edit({ edits: [edit] });
        refusal(result);
        await assertRefused(site, id, before, result);
      }

      const original = await storedTree(site, id);
      ok(
        await blockwork.edit({
          edits: [{ op: 'update', path: [0], attributes: { content: 'Edited' } }],
        }),
      );
      await savedPaths(id, before, blockwork, original, ['0']);
    },
  );
});

test('inserted tree and read limits are bounded', async () => {
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before }) => {
    const tree = {
      name: 'core/group',
      inner_blocks: Array.from({ length: 200 }, (_, index) => p(`Item ${index}`)),
    };
    const result = await blockwork.edit({ edits: [{ op: 'insert', block: tree }] });
    refusal(result);
    await assertRefused(site, id, before, result);
    const read = await blockwork.read({ blocks: { search: 'Anchor', limit: 500 } });
    ok(read);
    assert.equal(read.selection.clamped.limit, 50);
  });
});

test('remove every root and save the empty document', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('One'), paragraph('Two')) },
    async ({ blockwork, id, before }) => {
      const original = await storedTree(site, id);
      ok(
        await blockwork.edit({
          edits: [
            { op: 'remove', path: [0] },
            { op: 'remove', path: [0] },
          ],
        }),
      );
      await savedPaths(id, before, blockwork, original, ['0', '1']);
    },
  );
});

test('parent and allowedBlocks follow the native insertion selector', async () => {
  const content =
    '<!-- wp:bw/structure-box --><div class="wp-block-bw-structure-box"></div><!-- /wp:bw/structure-box -->';
  await withDocument(site, { content }, async ({ blockwork, id, before, tab }) => {
    const native = await site.evaluate(
      tab,
      "(() => { const s = wp.data.select('core/block-editor'); return s.canInsertBlockType('bw/structure-item', s.getBlocks()[0].clientId); })()",
    );
    assert.equal(native, false);
    const result = await blockwork.edit({
      edits: [{ op: 'insert', parent: [0], block: { name: 'bw/structure-item' } }],
    });
    refusal(result);
    await assertRefused(site, id, before, result);
  });
});

test(
  'new custom block finishes its mount effect before saving',
  { todo: 'finding: mount-default-change' },
  async () => {
    await withDocument(
      site,
      { content: paragraph('Anchor') },
      async ({ blockwork, id, before }) => {
        const original = await storedTree(site, id);
        ok(await blockwork.edit({ edits: [{ op: 'insert', block: { name: 'bw/mount-label' } }] }));
        await savedPaths(id, before, blockwork, original, ['1']);
        const tree = await storedTree(site, id);
        assert.equal(tree[1].attrs.initialized, true);
      },
    );
  },
);

test('an explicitly supplied mount value survives native initialization', async () => {
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    ok(await blockwork.edit({ edits: [{ op: 'insert', block: { name: 'bw/mount-label', attributes: { initialized: true } } }] }));
    await savedPaths(id, before, blockwork, original, ['1']);
    assert.equal((await storedTree(site, id)).find(block => block.blockName === 'bw/mount-label')?.attrs.initialized, true);
  });
});

test('an explicitly unlocked inner group follows native insertion policy', async () => {
  const inner =
    '<!-- wp:group {"templateLock":false,"layout":{"type":"constrained"}} --><div class="wp-block-group">' +
    paragraph('Inside') +
    '</div><!-- /wp:group -->';
  const content =
    '<!-- wp:group {"templateLock":"all","layout":{"type":"constrained"}} --><div class="wp-block-group">' +
    inner +
    '</div><!-- /wp:group -->';
  await withDocument(site, { content }, async ({ blockwork, id, before, tab }) => {
    const native = await site.evaluate(
      tab,
      "(() => { const s = wp.data.select('core/block-editor'); return s.canInsertBlockType('core/paragraph', s.getBlocks()[0].innerBlocks[0].clientId); })()",
    );
    assert.equal(native, true);
    const original = await storedTree(site, id);
    ok(await blockwork.edit({ edits: [{ op: 'insert', parent: [0, 0], block: p('Allowed') }] }));
    // The seed has no whitespace between its groups, and a native save adds it.
    await savedPaths(id, before, blockwork, original, ['0', '0.0', '0.0.1']);
  });
});

// Each row supplies a valid immediate child and its actual destination path.
const nestingCases = [
  ['root', null, [], 'core/paragraph', { content: 'Child' }],
  ['Group', 'core/group', [0], 'core/paragraph', { content: 'Child' }],
  ['Columns', 'core/columns', [0], 'core/column', {}],
  ['Column', 'core/columns', [0, 0], 'core/paragraph', { content: 'Child' }],
  ['Cover', 'core/cover', [0], 'core/paragraph', { content: 'Child' }],
  ['Media and Text', 'core/media-text', [0], 'core/paragraph', { content: 'Child' }],
  ['Buttons', 'core/buttons', [0], 'core/button', { text: 'Child' }],
  ['List', 'core/list', [0], 'core/list-item', { content: 'Child' }],
  ['nested List', 'core/list', [0, 0, 0], 'core/list-item', { content: 'Child' }],
  ['Quote', 'core/quote', [0], 'core/paragraph', { content: 'Child' }],
  ['Details', 'core/details', [0], 'core/paragraph', { content: 'Child' }],
  [
    'Gallery',
    'core/gallery',
    [0],
    'core/image',
    { url: 'https://example.test/image.png', alt: 'Child' },
  ],
  ['Accordion', 'core/accordion', [0], 'core/accordion-item', {}],
  [
    'Navigation submenu',
    'core/navigation',
    [0, 0],
    'core/navigation-link',
    { label: 'Child', url: 'https://example.test/' },
  ],
  ['custom card', 'bw/context-box', [0], 'core/paragraph', { content: 'Child' }],
];

generated(
  'structural operation table covers native nesting contexts',
  { findings: [] },
  async (t) => {
    for (const [label, container, parent, child, attributes] of nestingCases) {
      await t.test(`${label}: insert, move, replace, remove`, async () => {
        const inner_blocks =
          child === 'core/accordion-item'
            ? [
                { name: 'core/accordion-heading', attributes: { title: 'Title', level: 3 } },
                { name: 'core/accordion-panel', inner_blocks: [p('Panel')] },
              ]
            : [];
        const childSpec = { name: child, attributes, inner_blocks };
        const childExpression = `(() => { const create = b => wp.blocks.createBlock(b.name, b.attributes, (b.inner_blocks || []).map(create)); return create(${JSON.stringify(childSpec)}); })()`;
        let children = `[${childExpression}, ${childExpression}]`;

        if (label === 'Column')
          children = `[wp.blocks.createBlock('core/column', {}, ${children})]`;

        if (label === 'Navigation submenu')
          children = `[wp.blocks.createBlock('core/navigation-submenu', {}, ${children})]`;

        if (label === 'nested List')
          children = `[wp.blocks.createBlock('core/list-item', {content:'Parent'}, [wp.blocks.createBlock('core/list', {}, ${children})])]`;
        const expression = container
          ? `[wp.blocks.createBlock(${JSON.stringify(container)}, {}, ${children})]`
          : children;
        let content = await serializeNatively(site, expression);

        if (label === 'Gallery') {
          await withDocument(
            site,
            { content },
            async ({ tab }) => {
              content = await site.evaluate(
                tab,
                "wp.data.select('core/editor').getEditedPostContent()",
              );
            },
            { connected: false },
          );
        }

        await withDocument(site, { content }, async ({ blockwork, id, before, tab }) => {
          const original = await site.evaluate(
            tab,
            "wp.data.select('core/editor').getEditedPostContent()",
          );
          const destination = parent.length ? { parent } : {};
          const path = [...parent, 0];
          ok(
            await blockwork.edit({
              edits: [
                { op: 'insert', ...destination, block: childSpec },
                { op: 'move', path: [...parent, 2], ...destination, index: 0 },
                { op: 'replace', path, block: childSpec },
                { op: 'remove', path },
                { op: 'insert', block: p('Saved marker') },
              ],
            }),
          );
          assert.equal(
            await site.evaluate(tab, "wp.data.select('core/editor').getEditedPostContent()"),
            doc(original, paragraph('Saved marker')),
          );
          await assertSavedCleanly(site, id, before, await blockwork.save());
        });
      });
    }
  },
);

test('markup expansion and removed client IDs refuse the entire batch', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('One'), paragraph('Two')) },
    async ({ blockwork, id, before, tab }) => {
      const client_id = await site.evaluate(
        tab,
        "wp.data.select('core/block-editor').getBlocks()[0].clientId",
      );

      for (const edits of [
        [{ op: 'insert', markup: doc(...Array.from({ length: 33 }, () => paragraph('Expanded'))) }],
        [
          { op: 'remove', client_id },
          { op: 'remove', client_id },
        ],
      ]) {
        const result = await blockwork.edit({ edits });
        await assertRefused(site, id, before, result);
        assert.ok(
          ['not_applied', 'rolled_back'].includes(result.editor_result),
          JSON.stringify(result),
        );
        assert.equal(
          await site.evaluate(tab, "wp.data.select('core/block-editor').getBlocks().length"),
          2,
        );
      }
    },
  );
});

test('existing client IDs survive earlier index changes', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('One'), paragraph('Two'), paragraph('Three')) },
    async ({ blockwork, id, before, tab }) => {
      const client_id = await site.evaluate(
        tab,
        "wp.data.select('core/block-editor').getBlocks()[1].clientId",
      );
      ok(
        await blockwork.edit({
          edits: [
            { op: 'insert', index: 0, block: p('New') },
            { op: 'move', client_id, index: 3 },
          ],
        }),
      );
      await assertSavedCleanly(site, id, before, await blockwork.save());
      const tree = (await storedTree(site, id)).filter((block) => block.blockName);
      assert.deepEqual(
        tree.map((block) => block.innerHTML.trim()),
        ['<p>New</p>', '<p>One</p>', '<p>Three</p>', '<p>Two</p>'],
      );
    },
  );
});

generated(
  'template locks preserve content editing and refuse structure and lock changes',
  { findings: [] },
  async (t) => {
    for (const templateLock of ['all', 'insert', 'contentOnly']) {
      await t.test(templateLock, async () => {
        const content = await serializeNatively(
          site,
          `[wp.blocks.createBlock('core/group', ${JSON.stringify({ templateLock })}, [wp.blocks.createBlock('core/paragraph', {content:'Original'}), wp.blocks.createBlock('core/paragraph', {content:'Second'})])]`,
        );
        await withDocument(site, { content }, async ({ blockwork, id, before }) => {
          for (const edit of [
            { op: 'insert', parent: [0], block: p('Blocked') },
            { op: 'remove', path: [0, 0] },
            { op: 'update', path: [0], attributes: { templateLock: false } },
          ])
            await assertRefused(site, id, before, await blockwork.edit({ edits: [edit] }));
          const move = await blockwork.edit({
            edits: [{ op: 'move', path: [0, 0], parent: [0], index: 1 }],
          });

          if (templateLock === 'insert') {
            ok(move);
            ok(await blockwork.revert());
          } else await assertRefused(site, id, before, move);
          ok(
            await blockwork.edit({
              edits: [{ op: 'update', path: [0, 0], attributes: { content: 'Allowed' } }],
            }),
          );
          await assertSavedCleanly(site, id, before, await blockwork.save());
          assert.equal(
            (await storedTree(site, id))[0].innerBlocks[0].innerHTML.trim(),
            '<p>Allowed</p>',
          );
        });
      });
    }
  },
);

generated(
  'singleton insertion follows the disabled native inserter',
  { findings: [] },
  async (t) => {
    for (const name of ['core/more', 'core/footnotes', 'bw/singleton']) {
      await t.test(name, async () => {
        const content = await serializeNatively(
          site,
          `[wp.blocks.createBlock(${JSON.stringify(name)})]`,
        );
        await withDocument(site, { content }, async ({ blockwork, id, before, tab }) => {
          assert.equal(
            await site.evaluate(
              tab,
              `wp.blocks.getBlockSupport(${JSON.stringify(name)}, 'multiple', true)`,
            ),
            false,
          );

          if (name !== 'core/footnotes')
            assert.equal(
              await site.evaluate(
                tab,
                `wp.data.select('core/block-editor').getInserterItems('').find(item => item.name === ${JSON.stringify(name)}).isDisabled`,
              ),
              true,
            );
          await assertRefused(
            site,
            id,
            before,
            await blockwork.edit({ edits: [{ op: 'insert', block: { name } }] }),
          );
        });
      });
    }
  },
);

test('revert restores only the latest edit and refuses reuse, saved work and human changes', async () => {
  await withDocument(
    site,
    { content: paragraph('Original') },
    async ({ blockwork, id, before, tab }) => {
      const content = () =>
        site.evaluate(tab, "wp.data.select('core/editor').getEditedPostContent()");
      const original = await content();
      ok(await blockwork.edit({ edits: [{ op: 'insert', block: p('One') }] }));
      ok(await blockwork.revert());
      assert.equal(await content(), original);
      await assertRefused(site, id, before, await blockwork.revert(), {
        error: 'revert_not_available',
      });
      ok(await blockwork.edit({ edits: [{ op: 'insert', block: p('One') }] }));
      const first = await content();
      ok(await blockwork.edit({ edits: [{ op: 'insert', block: p('Two') }] }));
      ok(await blockwork.revert());
      assert.equal(await content(), first);
      await assertSavedCleanly(site, id, before, await blockwork.save());
      const saved = await storedDocument(site, id);
      await assertRefused(site, id, saved, await blockwork.revert(), {
        error: 'revert_not_available',
      });
      ok(await blockwork.edit({ edits: [{ op: 'insert', block: p('Agent') }] }));
      await site.evaluate(
        tab,
        "wp.data.dispatch('core/block-editor').updateBlockAttributes(wp.data.select('core/block-editor').getBlocks()[0].clientId, {content:'Human'})",
      );
      const human = await content();
      await assertRefused(site, id, saved, await blockwork.revert(), {
        error: 'intervening_editor_change',
      });
      assert.equal(await content(), human);
    },
  );
});

test('read clamps depth and limit and inserted paths enforce fifteen levels', async () => {
  await withDocument(
    site,
    { content: paragraph('Anchor') },
    async ({ blockwork, id, before, tab }) => {
      const client_id = await site.evaluate(
        tab,
        "wp.data.select('core/block-editor').getBlocks()[0].clientId",
      );
      const result = await blockwork.read({ blocks: { client_id, depth: 99, limit: 999 } });
      ok(result);
      assert.deepEqual(result.selection.clamped, { depth: 8, limit: 50 });
      let tree = p('Deep');

      for (let depth = 0; depth < 15; depth++) tree = { name: 'core/group', inner_blocks: [tree] };
      await assertRefused(
        site,
        id,
        before,
        await blockwork.edit({ edits: [{ op: 'insert', block: tree }] }),
      );
      await assertRefused(
        site,
        id,
        before,
        await blockwork.edit({ edits: [{ op: 'remove', path: Array(16).fill(0) }] }),
      );
    },
  );
});

generated(
  'document block and stored content ceilings refuse before mutation',
  { findings: [] },
  async (t) => {
    await t.test('2000 blocks', async () => {
      await withDocument(
        site,
        { content: doc(...Array.from({ length: 2000 }, (_, i) => paragraph(`Item ${i}`))) },
        async ({ blockwork, id, before }) => {
          const siteOriginal = await storedTree(site, id);
          await assertRefused(
            site,
            id,
            before,
            await blockwork.edit({ edits: [{ op: 'insert', block: p('Overflow') }] }),
          );
          ok(
            await blockwork.edit({
              edits: [{ op: 'update', path: [1000], attributes: { content: 'Changed' } }],
            }),
          );
          await assertSavedCleanly(site, id, before, await blockwork.save());
          assert.deepEqual(changedPaths(siteOriginal, await storedTree(site, id)), ['1000']);
        },
      );
    });
    await t.test('256 KiB', async () => {
      await withDocument(
        site,
        { content: paragraph('x'.repeat(256 * 1024)) },
        async ({ doc: result, id, before }) => {
          await assertRefused(site, id, before, result, { error: 'content_too_large' });
        },
        { connected: false },
      );
    });
  },
);

test(
  'a move across context providers keeps derived native attributes',
  { todo: 'finding: context-move-partial' },
  async () => {
    const content = await serializeNatively(
      site,
      "[wp.blocks.createBlock('bw/context-box', {tone:'red'}, [wp.blocks.createBlock('bw/context-label', {resolvedTone:'red'})]), wp.blocks.createBlock('bw/context-box', {tone:'blue'})]",
    );
    await withDocument(site, { content }, async ({ blockwork, id, before }) => {
      ok(await blockwork.edit({ edits: [{ op: 'move', path: [0, 0], parent: [1], index: 0 }] }));
      await assertSavedCleanly(site, id, before, await blockwork.save());
      const tree = (await storedTree(site, id)).filter((block) => block.blockName);
      assert.equal(tree[1].innerBlocks[0].attrs.resolvedTone, 'blue');
    });
  },
);

test('a complete context move supplies its known final derived attribute', async () => {
  const content = await serializeNatively(site,
    "[wp.blocks.createBlock('bw/context-box', {tone:'red'}, [wp.blocks.createBlock('bw/context-label', {resolvedTone:'red'})]), wp.blocks.createBlock('bw/context-box', {tone:'blue'})]");
  await withDocument(site, { content }, async ({ blockwork, id, before }) => {
    ok(await blockwork.edit({ edits: [
      { op: 'move', path: [0, 0], parent: [1], index: 0 },
      { op: 'update', path: [1, 0], attributes: { resolvedTone: 'blue' } },
    ] }));
    await assertSavedCleanly(site, id, before, await blockwork.save());
    const tree = (await storedTree(site, id)).filter((block) => block.blockName);
    assert.equal(tree[1].innerBlocks[0].attrs.resolvedTone, 'blue');
  });
});

test('FAQ reordering and section duplication preserve sibling content and duplicate anchors', async () => {
  await withDocument(
    site,
    {
      content: doc(
        group(paragraph('First answer')),
        group(paragraph('Second answer')),
        paragraph('Footer'),
      ),
    },
    async ({ blockwork, id, before, tab }) => {
      ok(await blockwork.edit({ edits: [{ op: 'move', path: [1], index: 0 }] }));
      const client_id = await site.evaluate(
        tab,
        "wp.data.select('core/block-editor').getBlocks()[0].clientId",
      );
      ok(
        await blockwork.edit({
          edits: [{ op: 'update', client_id, attributes: { anchor: 'faq' } }],
        }),
      );
      const read = await blockwork.read({ blocks: { client_id, depth: 8, markup: true } });
      ok(read);
      const markup = read.markup;
      ok(await blockwork.edit({ edits: [{ op: 'insert', markup }] }));
      await assertSavedCleanly(site, id, before, await blockwork.save());
      const tree = (await storedTree(site, id)).filter((block) => block.blockName);
      assert.deepEqual(
        tree.map((block) => block.attrs.anchor),
        ['faq', undefined, undefined, 'faq'],
      );
      assert.equal(tree[0].innerBlocks[0].innerHTML.trim(), '<p>Second answer</p>');
      assert.equal(tree[3].innerBlocks[0].innerHTML, tree[0].innerBlocks[0].innerHTML);
    },
  );
});

generated(
  'remove sole required children and add a Column without redistributing widths',
  { findings: [] },
  async (t) => {
    for (const name of ['core/columns', 'core/list']) {
      await t.test(name, async () => {
        const child = name === 'core/columns' ? 'core/column' : 'core/list-item';
        const content = await serializeNatively(
          site,
          `[wp.blocks.createBlock('${name}', {}, [wp.blocks.createBlock('${child}', ${child === 'core/list-item' ? "{content:'Only item'}" : '{}'})])]`,
        );
        await withDocument(site, { content }, async ({ blockwork, id, before }) => {
          ok(await blockwork.edit({ edits: [{ op: 'remove', path: [0, 0] }] }));
          await assertSavedCleanly(site, id, before, await blockwork.save());
          assert.equal((await storedTree(site, id))[0].innerBlocks.length, 0);
        });
      });
    }

    await t.test('explicit Column widths', async () => {
      const content = await serializeNatively(
        site,
        "[wp.blocks.createBlock('core/columns', {}, [wp.blocks.createBlock('core/column', {width:'40%'}, [wp.blocks.createBlock('core/paragraph', {content:'Left'})]), wp.blocks.createBlock('core/column', {width:'60%'}, [wp.blocks.createBlock('core/paragraph', {content:'Right'})])])]",
      );
      await withDocument(site, { content }, async ({ blockwork, id, before }) => {
        ok(
          await blockwork.edit({
            edits: [
              {
                op: 'insert',
                parent: [0],
                block: { name: 'core/column', inner_blocks: [p('New')] },
              },
            ],
          }),
        );
        await assertSavedCleanly(site, id, before, await blockwork.save());
        assert.deepEqual(
          (await storedTree(site, id))[0].innerBlocks.map((block) => block.attrs.width),
          ['40%', '60%', undefined],
        );
      });
    });
  },
);

test('replace a container type with explicitly preserved children', async () => {
  await withDocument(
    site,
    { content: group(paragraph('Kept')) },
    async ({ blockwork, id, before }) => {
      ok(
        await blockwork.edit({
          edits: [
            { op: 'replace', path: [0], block: { name: 'core/quote', inner_blocks: [p('Kept')] } },
          ],
        }),
      );
      await assertSavedCleanly(site, id, before, await blockwork.save());
      const tree = (await storedTree(site, id))[0];
      assert.equal(tree.blockName, 'core/quote');
      assert.equal(tree.innerBlocks[0].innerHTML.trim(), '<p>Kept</p>');
    },
  );
});

test('unsynced pattern section requires explicit opening and preserves content-only locks', async () => {
  const content = await serializeNatively(
    site,
    "[wp.blocks.createBlock('core/group', {metadata:{patternName:'bw/section',name:'Section'}, templateLock:'contentOnly'}, [wp.blocks.createBlock('core/paragraph', {content:'Original'})])]",
  );
  await withDocument(site, { content }, async ({ blockwork, id, before, tab }) => {
    const section_client_id = await site.evaluate(
      tab,
      "wp.data.select('core/block-editor').getBlocks()[0].clientId",
    );
    await assertRefused(
      site,
      id,
      before,
      await blockwork.edit({ edits: [{ op: 'insert', parent: [0], block: p('Refused') }] }),
    );
    ok(
      await blockwork.edit({
        edits: [{ op: 'update', path: [0, 0], attributes: { content: 'Before opening' } }],
      }),
    );
    const result = await blockwork.edit({
      open_pattern_section: { section_client_id },
      edits: [{ op: 'update', path: [0, 0], attributes: { content: 'Edited' } }],
    });
    ok(result);
    assert.equal(result.pattern_section.section_client_id, section_client_id);
    await assertRefused(
      site,
      id,
      before,
      await blockwork.edit({
        edits: [{ op: 'update', path: [0, 0], attributes: { dropCap: true } }],
      }),
    );
    await assertRefused(
      site,
      id,
      before,
      await blockwork.edit({ edits: [{ op: 'remove', path: [0, 0] }] }),
    );
    await assertSavedCleanly(site, id, before, await blockwork.save());
  });
});

test('template changes block later structural edits', async () => {
  await withDocument(
    site,
    { content: paragraph('Original') },
    async ({ blockwork, id, before }) => {
      ok(await blockwork.edit({ post: { template: 'page-no-title' } }));
      await assertRefused(
        site,
        id,
        before,
        await blockwork.edit({ edits: [{ op: 'insert', block: p('Blocked') }] }),
        { error: 'settings_before_structure' },
      );
    },
  );
});

test('locked custom post template fills are adopted', async () => {
  const tab = await site.openTab(`${site.site}/wp-admin/upload.php`);
  await waitFor(site, tab, 'window.wp?.apiFetch');
  const blockwork = await site.createCaller(tab);

  try {
    const result = await blockwork.create({
      target: { site_url: site.site, user_id: 1 },
      post_type: 'bw_locked',
    });
    ok(result);
    assert.equal(result.block_count, 1);
    assert.equal(result.blocks[0].preview, 'Template text');
    const id = result.document.post_id;
    const before = await storedDocument(site, id);
    await assertRefused(
      site,
      id,
      before,
      await blockwork.edit({ edits: [{ op: 'insert', block: p('Blocked') }] }),
      { error: 'template_locked' },
    );
  } finally {
    await blockwork.release();
    await tab.close();
  }
});

generated(
  'ancestor and inserter restrictions agree with the native selector',
  { findings: [] },
  async (t) => {
    for (const [name, container, expected] of [
      ['bw/ancestor-item', 'bw/context-box', true],
      ['bw/ancestor-item', 'core/group', false],
      ['bw/no-inserter', 'core/group', true],
      ['bw/structure-item', 'core/group', true],
    ]) {
      await t.test(`${name} in ${container}`, async () => {
        const content = await serializeNatively(
          site,
          `[wp.blocks.createBlock('${container}', {}, [wp.blocks.createBlock('core/paragraph', {content:'Existing'})])]`,
        );
        await withDocument(site, { content }, async ({ blockwork, id, before, tab }) => {
          assert.equal(
            await site.evaluate(
              tab,
              `wp.data.select('core/block-editor').canInsertBlockType('${name}', wp.data.select('core/block-editor').getBlocks()[0].clientId)`,
            ),
            expected,
          );
          const result = await blockwork.edit({
            edits: [{ op: 'insert', parent: [0], block: { name } }],
          });

          if (expected) {
            ok(result);
            await assertSavedCleanly(site, id, before, await blockwork.save());
          } else await assertRefused(site, id, before, result);
        });
      });
    }
  },
);

test('reconnect cannot adopt unread native template descendants', async () => {
  const content = await serializeNatively(site, "[wp.blocks.createBlock('bw/template-card')]");
  await withDocument(site, { content }, async ({ blockwork, id, before, tab, target }) => {
    ok(await blockwork.connect({ target, workflow: 'background' }));
    const client_id = await site.evaluate(
      tab,
      "wp.data.select('core/block-editor').getBlocks()[0].clientId",
    );
    ok(await blockwork.read({ blocks: { client_id, depth: 0 } }));
    await assertRefused(site, id, before, await blockwork.save(), {
      error: 'unexpected_editor_change',
    });
  });
});

test('a genuine descendant destination and source removal lock cannot be bypassed', async () => {
  await withDocument(
    site,
    {
      content: doc(
        group(group(paragraph('Nested'))),
        paragraph('Locked', { lock: { remove: true } }),
      ),
    },
    async ({ blockwork, id, before }) => {
      for (const edit of [
        { op: 'move', path: [0], parent: [0, 0], index: 0 },
        { op: 'move', path: [1], parent: [0], index: 0 },
      ])
        await assertRefused(site, id, before, await blockwork.edit({ edits: [edit] }));
    },
  );
});

test('fifteen-level inserted tree is accepted at its boundary', async () => {
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before }) => {
    let tree = p('Deep');

    for (let depth = 1; depth < 15; depth++) tree = { name: 'core/group', inner_blocks: [tree] };
    ok(await blockwork.edit({ edits: [{ op: 'insert', block: tree }] }));
    ok(
      await blockwork.edit({
        edits: [
          { op: 'update', path: [1, ...Array(14).fill(0)], attributes: { content: 'Deeper' } },
        ],
      }),
    );
    await assertSavedCleanly(site, id, before, await blockwork.save());
    let saved = (await storedTree(site, id)).filter((block) => block.blockName)[1];

    for (let depth = 1; depth < 15; depth++) saved = saved.innerBlocks[0];
    assert.equal(saved.innerHTML.trim(), '<p>Deeper</p>');
  });
});

test('unexpected initial human content refuses editor_not_clean', async () => {
  const id = await seedDocument(site, { content: paragraph('Stored') });
  const before = await storedDocument(site, id);
  const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);
  const blockwork = await site.createCaller(tab);

  try {
    await waitFor(site, tab, "wp.data.select('core/block-editor').getBlocks().length === 1");
    await site.evaluate(
      tab,
      "wp.data.dispatch('core/block-editor').updateBlockAttributes(wp.data.select('core/block-editor').getBlocks()[0].clientId, {content:'Human pending'})",
    );
    await assertRefused(
      site,
      id,
      before,
      await blockwork.connect({
        target: { site_url: site.site, post_id: id, post_type: 'page' },
        workflow: 'background',
      }),
      { error: 'editor_not_clean' },
    );
  } finally {
    await blockwork.release();
    await tab.close();
  }
});

test('a saved template change requires reopening before structural edits', async () => {
  await withDocument(
    site,
    { content: paragraph('Original') },
    async ({ blockwork, id, before }) => {
      ok(await blockwork.edit({ post: { template: 'page-no-title' } }));
      await assertSavedCleanly(site, id, before, await blockwork.save(), { allow: ['meta'] });
      const saved = await storedDocument(site, id);
      await assertRefused(
        site,
        id,
        saved,
        await blockwork.edit({ edits: [{ op: 'insert', block: p('Blocked') }] }),
        { error: 'reopen_required' },
      );
    },
  );
});

generated(
  'individual move and remove locks match native action permissions',
  { findings: [] },
  async (t) => {
    for (const lock of [{ move: true }, { remove: true }]) {
      await t.test(JSON.stringify(lock), async () => {
        await withDocument(
          site,
          { content: doc(paragraph('Locked', { lock }), paragraph('Other')) },
          async ({ blockwork, id, before, tab }) => {
            const client_id = await site.evaluate(
              tab,
              "wp.data.select('core/block-editor').getBlocks()[0].clientId",
            );
            const permissions = await site.evaluate(
              tab,
              `(() => {const s=wp.data.select('core/block-editor');return {move:s.canMoveBlock(${JSON.stringify(client_id)}), remove:s.canRemoveBlock(${JSON.stringify(client_id)})};})()`,
            );
            ok(
              await blockwork.edit({
                edits: [{ op: 'update', client_id, attributes: { content: 'Updated' } }],
              }),
            );

            for (const op of ['move', 'remove']) {
              const edit = op === 'move' ? { op, client_id, index: 1 } : { op, client_id };
              const result = await blockwork.edit({ edits: [edit] });

              if (permissions[op]) {
                ok(result);
                ok(await blockwork.revert());
              } else await assertRefused(site, id, before, result);
            }

            await assertSavedCleanly(site, id, before, await blockwork.save());
          },
        );
      });
    }
  },
);

run();
