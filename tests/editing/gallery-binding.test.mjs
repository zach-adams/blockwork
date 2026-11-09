import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';
import {
  assertSavedCleanly,
  seedImage,
  serializeNatively,
  startEditingSite,
  waitFor,
  withDocument,
} from './harness.mjs';

let site;
const { before, after, test, run } = editingTests(import.meta.url);
before(async () => {
  site = await startEditingSite();
});
after(() => site?.[Symbol.asyncDispose]());
const check = (result) => assert.equal(result.ok, true, JSON.stringify(result));

async function settle(tab) {
  await site.evaluate(
    tab,
    `(async () => {
    let previous = '';
    let since = Date.now();
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const value = wp.blocks.serialize(wp.data.select('core/block-editor').getBlocks());
      if (value !== previous || wp.data.select('core').hasResolvingSelectors()) {
        previous = value; since = Date.now();
      }
      if (Date.now() - since > 300) return;
    }
    throw Error('Gallery did not settle');
  })()`,
  );
}

async function prepare(tab, mediaId) {
  await waitFor(
    site,
    tab,
    `!!wp.data.select('core/block-editor').getBlockListSettings(wp.data.select('core/block-editor').getBlocks()[1].clientId)`,
  );
  await site.evaluate(
    tab,
    `(() => {
    const parent = wp.data.select('core/block-editor').getBlocks()[1];
    wp.data.dispatch('core/block-editor').insertBlocks([wp.blocks.createBlock('core/image')], parent.innerBlocks.length, parent.clientId, false);
  })()`,
  );
  await settle(tab);

  return site.evaluate(
    tab,
    `(async () => {
    const clone = value => JSON.parse(JSON.stringify(value));
    const before = clone(wp.data.select('core/block-editor').getBlocks());
    const gallery = before[1], image = gallery.innerBlocks.at(-1);
    const query = { include: gallery.innerBlocks.map(block => block.clientId === image.clientId ? ${mediaId} : block.attributes.id).filter(id => id !== undefined).join(','), per_page: -1, orderby: 'include' };
    const records = await wp.data.resolveSelect('core').getEntityRecords('postType', 'attachment', query);
    const record = records.find(value => value.id === ${mediaId});
    const parentPatch = { sizeSlug: 'full', linkTo: 'none' };
    const imagePatch = { id: record.id, url: record.source_url, alt: record.alt_text, sizeSlug: 'full', caption: 'Chosen caption', linkDestination: 'none', link: record.link };
    const full = record.sizes?.full?.url || record.media_details?.sizes?.full?.source_url;
    if (full) imagePatch.fullUrl = full;
    const planned = clone(before);
    Object.assign(planned[1].attributes, parentPatch);
    Object.assign(planned[1].innerBlocks.at(-1).attributes, imagePatch);
    window.__gallery_binding_case = { before, planned, parentPatch, imagePatch, parent: gallery.clientId, image: image.clientId };
    return { before, planned, imagePath: [1, gallery.innerBlocks.length - 1], record };
  })()`,
  );
}

const normalized = (blocks) =>
  blocks.map(({ name, attributes, innerBlocks }) => ({
    name,
    attributes,
    innerBlocks: normalized(innerBlocks ?? []),
  }));

for (const scenario of ['fresh', 'saved_sibling', 'foreign_before', 'foreign_after']) {
  test('complete Gallery binding ' + scenario, async () => {
    const media = await seedImage(site, {
      name: 'complete-gallery-' + scenario,
      width: 1600,
      height: 1000,
      caption: 'Attachment caption',
      alt: 'Attachment alt',
    });
    const siblings =
      scenario === 'saved_sibling'
        ? `[wp.blocks.createBlock('core/image', { id: ${media.id}, url: ${JSON.stringify(media.url)}, alt: 'Keep sibling alt', caption: 'Keep sibling caption', sizeSlug: 'full', linkDestination: 'custom', href: 'https://example.test/sibling', linkTarget: '_blank', rel: 'noreferrer' })]`
        : '[]';
    const content = await serializeNatively(
      site,
      `[wp.blocks.createBlock('core/paragraph', { content: 'Anchor' }), wp.blocks.createBlock('core/gallery', { sizeSlug: 'large', linkTo: 'none' }, ${siblings})]`,
    );
    let oracle;
    await withDocument(site, { content }, async ({ tab }) => {
      const prepared = await prepare(tab, media.id);
      await site.evaluate(
        tab,
        `(() => {
        const plan = window.__gallery_binding_case;
        wp.data.dispatch('core/block-editor').updateBlockAttributes([plan.parent, plan.image], { [plan.parent]: plan.parentPatch, [plan.image]: plan.imagePatch }, true);
      })()`,
      );
      await settle(tab);
      oracle = await site.evaluate(
        tab,
        'JSON.parse(JSON.stringify(wp.data.select("core/block-editor").getBlocks()))',
      );
      assert.deepEqual(oracle, prepared.planned);
    });
    await withDocument(site, { content }, async ({ tab, blockwork, id, before: savedBefore }) => {
      const prepared = await prepare(tab, media.id);
      check(await blockwork.read({ blocks: { depth: 3 } }));
      const inspected = await blockwork.call({ operation: 'inspect_media', target: { site_url: site.site }, id: media.id });
      check(inspected);

      for (const key of ['id', 'source_url', 'alt_text', 'link'])
        assert.deepEqual(prepared.record[key], inspected.record[key]);
      const request = {
        edits: [
          {
            op: 'update',
            path: [1],
            name: 'core/gallery',
            attributes: { sizeSlug: 'full', linkTo: 'none' },
          },
          {
            op: 'update',
            path: prepared.imagePath,
            name: 'core/image',
            attributes: { caption: 'Chosen caption', sizeSlug: 'full', linkDestination: 'none' },
          },
        ],
        media_bindings: [
          {
            path: prepared.imagePath,
            name: 'core/image',
            media_id: media.id,
            media_token: inspected.record.edit_token,
            size: 'full',
            bind: { id: 'id', url: 'url', alt: 'alt', size_slug: 'sizeSlug' },
          },
        ],
      };
      await site.evaluate(
        tab,
        `(() => {
        const scenario = ${JSON.stringify(scenario)};
        const plan = window.__gallery_binding_case;
        const actions = wp.data.dispatch('core/block-editor');
        const update = actions.updateBlockAttributes;
        window.__gallery_binding_groups = 0;
        window.__gallery_binding_reads = 0;
        if (scenario === 'foreign_before') {
          const fetch = wp.apiFetch;
          wp.apiFetch = options => {
            const result = fetch(options);
            if (options.path?.split('?')[0] !== '/wp/v2/media/' + plan.imagePatch.id) return result;
            window.__gallery_binding_reads++;
            if (window.__gallery_binding_reads !== 2) return result;
            return Promise.resolve(result).then(value => {
              wp.apiFetch = fetch;
              update(plan.before[0].clientId, { content: 'Foreign before' });
              return value;
            });
          };
          Object.assign(wp.apiFetch, fetch);
        }
        actions.updateBlockAttributes = (ids, attributes, unique) => {
          if (Array.isArray(ids) && unique && ids.includes(plan.image)) window.__gallery_binding_groups++;
          const result = update(ids, attributes, unique);
          if (scenario === 'foreign_after' && Array.isArray(ids) && ids.includes(plan.image)) update(plan.before[0].clientId, { content: 'Foreign after' });
          return result;
        };
      })()`,
      );
      const result = await blockwork.edit(request);
      await settle(tab);
      const reached = await site.evaluate(
        tab,
        '({ blocks: JSON.parse(JSON.stringify(wp.data.select("core/block-editor").getBlocks())), groups: window.__gallery_binding_groups, mediaReads: window.__gallery_binding_reads })',
      );

      if (scenario.startsWith('foreign')) {
        assert.equal(result.ok, false, JSON.stringify(result));
        assert.equal(reached.groups, scenario === 'foreign_before' ? 0 : 1);

        if (scenario === 'foreign_before') assert.equal(reached.mediaReads, 2);
        assert.equal(
          reached.blocks[0].attributes.content,
          scenario === 'foreign_before' ? 'Foreign before' : 'Foreign after',
        );

        return;
      }

      check(result);
      assert.equal(reached.groups, 1);
      assert.deepEqual(reached.blocks, prepared.planned);
      assert.deepEqual(normalized(reached.blocks), normalized(oracle));

      if (scenario === 'saved_sibling')
        assert.deepEqual(reached.blocks[1].innerBlocks[0], prepared.before[1].innerBlocks[0]);
      check(await blockwork.edit({ edits: [{ op: 'insert', block: { name: 'core/site-logo' } }] }));
      const afterNeighbor = await site.evaluate(
        tab,
        'JSON.parse(JSON.stringify(wp.data.select("core/block-editor").getBlocks().slice(0, 2)))',
      );
      assert.deepEqual(afterNeighbor, prepared.planned);
      await assertSavedCleanly(site, id, savedBefore, await blockwork.save());
    });
  });
}


test('saved Gallery Images keep ordinary media rebinding', async () => {
  const first = await seedImage(site, { name: 'saved-gallery-first', alt: 'Previous alt' });
  const second = await seedImage(site, { name: 'saved-gallery-second', alt: 'Replacement alt' });
  const content = await serializeNatively(site,
    '[wp.blocks.createBlock("core/paragraph", { content: "Anchor" }), wp.blocks.createBlock("core/gallery", { sizeSlug: "full", linkTo: "none" }, [wp.blocks.createBlock("core/image", { id: ' + first.id + ', url: ' + JSON.stringify(first.url) + ', alt: "Previous alt", caption: "Keep caption", sizeSlug: "full", linkDestination: "none" })])]');
  await withDocument(site, { content }, async ({ tab, blockwork, id, before }) => {
    const original = await site.evaluate(tab, 'JSON.parse(JSON.stringify(wp.data.select("core/block-editor").getBlocks()))');
    assert.ok(original[1].innerBlocks[0].originalContent);
    const inspected = await blockwork.call({ operation: 'inspect_media', target: { site_url: site.site }, id: second.id });
    check(inspected);
    check(await blockwork.edit({ media_bindings: [{ path: [1, 0], name: 'core/image', media_id: second.id,
      media_token: inspected.record.edit_token, size: 'full', bind: { id: 'id', url: 'url', alt: 'alt' } }] }));
    const current = await site.evaluate(tab, 'JSON.parse(JSON.stringify(wp.data.select("core/block-editor").getBlocks()))');
    assert.equal(current[1].innerBlocks[0].clientId, original[1].innerBlocks[0].clientId);
    assert.equal(current[1].innerBlocks[0].attributes.id, second.id);
    assert.equal(current[1].innerBlocks[0].attributes.caption, 'Keep caption');
    assert.deepEqual(current[1].attributes, original[1].attributes);
    assert.deepEqual(current[0], original[0]);
    await assertSavedCleanly(site, id, before, await blockwork.save());
  });
});

run();
