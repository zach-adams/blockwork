import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';
import { paragraph } from './blocks.mjs';
import { startEditingSite, withDocument, assertSavedCleanly } from './harness.mjs';

const { before, after, test, run } = editingTests(import.meta.url);
let site;
before(async () => {
  site = await startEditingSite();
  await site.php("update_option('blockwork_matrix_comments', false);");
});
after(() => site?.[Symbol.asyncDispose]());
const ok = (result) => assert.equal(result.ok, true, JSON.stringify(result));
test('root empty Comments recipe matches mounted native insertion and survives save and a later neighbor edit', async () => {
  let oracle;
  let savedId;
  let savedBefore;
  await withDocument(site, { content: paragraph('Neighbor') }, async ({ tab }) => {
    oracle = await site.evaluate(
      tab,
      `(async () => {
      await wp.data.resolveSelect('core').getBlockPatterns();
      const store = wp.data.select('core/block-editor');
      const patterns = store.__experimentalGetAllowedPatterns();
      const hasComments = blocks => blocks.some(b => b.name === 'core/comments' || hasComments(b.innerBlocks || []));
      const pattern = patterns.find(p => !p.syncStatus && p.blocks.length === 1 && hasComments(p.blocks));
      if (!pattern) throw new Error('Native root Comments recipe unavailable');
      wp.data.dispatch('core/block-editor').insertBlocks(pattern.blocks.map(b => wp.blocks.cloneBlock(b)), 1, undefined, false);
      const end = Date.now() + 20000;
      let stable = ''; let since = Date.now();
      while (Date.now() < end) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const blocks = store.getBlocks();
        const current = wp.blocks.serialize(blocks);
        const template = blocks.flatMap(function walk(b) { return [b, ...(b.innerBlocks || []).flatMap(walk)]; }).find(b => b.name === 'core/comment-template');
        const docs = [document, ...Array.from(document.querySelectorAll('iframe')).map(f => f.contentDocument).filter(Boolean)];
        const mounted = template && docs.some(d => d.querySelector('[data-block="' + template.clientId + '"]'));
        if (current !== stable || wp.data.select('core').hasResolvingSelectors() || !mounted) { stable = current; since = Date.now(); }
        if (mounted && Date.now() - since >= 250) return { name: pattern.name, content: current };
      }
      throw new Error('Native Comments components did not settle');
    })()`,
    );
  });
  await withDocument(
    site,
    { content: paragraph('Neighbor') },
    async ({ blockwork, id, before }) => {
      ok(await blockwork.read({ blocks: 'all' }));
      ok(
        await blockwork.edit({
          edits: [{ op: 'insert_pattern', pattern: oracle.name, parent: [], index: 1 }],
        }),
      );
      const { after: stored } = await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal(stored.content, oracle.content);
      savedId = id;
      savedBefore = stored;
    },
  );
  const tab = await site.openTab(site.site + '/wp-admin/post.php?post=' + savedId + '&action=edit');
  const blockwork = await site.createCaller(tab);

  try {
    ok(
      await blockwork.connect({
        target: { site_url: site.site, post_id: savedId, post_type: 'page' },
        workflow: 'background',
      }),
    );
    ok(await blockwork.read({ blocks: 'all' }));
    ok(
      await blockwork.edit({
        edits: [
          {
            op: 'update',
            path: [0],
            name: 'core/paragraph',
            attributes: { content: 'Changed neighbor' },
          },
        ],
      }),
    );
    const { after: stored } = await assertSavedCleanly(
      site,
      savedId,
      savedBefore,
      await blockwork.save(),
    );
    assert.equal(stored.content, oracle.content.replace('Neighbor', 'Changed neighbor'));
  } finally {
    await blockwork.release();
    await tab.close();
  }
});
await run();
