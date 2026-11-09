import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';

const { after, before, generated, test, run } = editingTests(import.meta.url);

import { doc, paragraph } from './blocks.mjs';
import {
  assertRefused,
  assertSavedCleanly,
  changedPaths,
  frontEnd,
  seedDocument,
  startEditingSite,
  storedDocument,
  storedTree,
  waitFor,
  withDocument,
} from './harness.mjs';

let site;
let registered;
let discovery;
const mathUpdate = {
  latex: 'y',
  mathML:
    '<semantics><mi>y</mi><annotation encoding="application/x-tex">y</annotation></semantics>',
};
const mediaSources = new Map();
const mediaFinding = 'native-default-serialization';
const todoFor = (slug) => slug && `finding: ${slug}`;
const nativeFixtures = new Map();
before(async () => {
  site = await startEditingSite();
  const audio = await site.php(
    "update_option('blockwork_matrix_comments', true); echo wp_json_encode(blockwork_matrix_audio());",
  );
  mediaSources.set('core/audio', audio);
  attrs['core/audio'] = { ...audio, autoplay: false, loop: false };
  attrs['core/file'] = {
    href: audio.src,
    fileName: 'Matrix audio.wav',
    textLinkHref: audio.src,
    showDownloadButton: true,
    downloadButtonText: 'Download',
  };
  const video = await site.php('echo wp_json_encode(blockwork_matrix_video());');
  mediaSources.set('core/video', video);
  attrs['core/video'] = {
    ...video,
    controls: true,
    autoplay: false,
    loop: false,
    muted: false,
    playsInline: false,
  };
  attrs['core/playlist-track'] = audio;
  await seedDocument(site, {
    type: 'post',
    title: 'Matrix query post',
    content: paragraph('Matrix query content'),
  });
  await withDocument(site, { content: paragraph('Discovery') }, async ({ tab }) => {
    registered = await site.evaluate(
      tab,
      "wp.blocks.getBlockTypes().map(block => block.name).filter(name => name.startsWith('core/'))",
    );
  });
});
after(async () => {
  await discovery?.tab.close().catch(() => undefined);
  await site?.[Symbol.asyncDispose]();
});

// Every registered core block must be assigned a treatment. Parent names form a
// chain from the block to the document root.
const roots =
  `paragraph image heading gallery list quote accordion archives audio buttons calendar categories code columns cover details embed file group math latest-comments latest-posts media-text more page-list playlist preformatted pullquote rss search separator social-links spacer table tabs tag-cloud verse video footnotes site-logo site-title site-tagline query avatar post-title post-excerpt post-featured-image post-author post-author-name post-comments-count post-comments-link post-date post-terms post-navigation-link post-time-to-read read-more comments post-comments-form icon loginout term-count term-description term-name terms-query query-title post-author-biography breadcrumbs`.split(
    ' ',
  );
const parents = {
  'list-item': ['list'],
  button: ['buttons'],
  column: ['columns'],
  'accordion-item': ['accordion'],
  'accordion-heading': ['accordion-item', 'accordion'],
  'accordion-panel': ['accordion-item', 'accordion'],
  'social-link': ['social-links'],
  'navigation-link': ['navigation'],
  'navigation-submenu': ['navigation'],
  'home-link': ['navigation'],
  'page-list-item': ['page-list'],
  'playlist-track': ['playlist'],
  'tab-list': ['tabs'],
  'tab-panels': ['tabs'],
  'tab-panel': ['tab-panels', 'tabs'],
  'post-content': ['post-template', 'query'],
  'post-title': ['post-template', 'query'],
  'post-template': ['query'],
  'query-pagination': ['query'],
  'query-no-results': ['query'],
  'query-total': ['query'],
  'query-pagination-next': ['query-pagination', 'query'],
  'query-pagination-numbers': ['query-pagination', 'query'],
  'query-pagination-previous': ['query-pagination', 'query'],
  'comment-author-name': ['comment-template', 'comments'],
  'comment-content': ['comment-template', 'comments'],
  'comment-date': ['comment-template', 'comments'],
  'comment-edit-link': ['comment-template', 'comments'],
  'comment-reply-link': ['comment-template', 'comments'],
  'comment-template': ['comments'],
  'comments-title': ['comments'],
  'comments-pagination': ['comments'],
  'comments-pagination-next': ['comments-pagination', 'comments'],
  'comments-pagination-numbers': ['comments-pagination', 'comments'],
  'comments-pagination-previous': ['comments-pagination', 'comments'],
  'term-template': ['terms-query'],
  'term-name': ['term-template', 'terms-query'],
  'term-description': ['term-template', 'terms-query'],
  'term-count': ['term-template', 'terms-query'],
};
// These blocks are shared entities, raw content, or require a template or a
// WordPress-managed block rather than an ordinary page insertion.
const restricted = `html missing block navigation template-part freeform`.split(' ');
const entries = Object.fromEntries([
  ...roots.map((name) => [`core/${name}`, { parents: [] }]),
  ...Object.entries(parents).map(([name, chain]) => [`core/${name}`, { parents: chain }]),
  ...restricted.map((name) => [
    `core/${name}`,
    {
      parents: [],
      restricted: true,
      reason: ['block', 'navigation', 'template-part'].includes(name)
        ? 'Shared entities require reference operations.'
        : 'Raw HTML, classic content, and missing blocks are outside the supported edit API.',
    },
  ]),
]);

for (const name of [
  'nextpage',
  'pattern',
  'shortcode',
  'text-columns',
  'navigation-overlay-close',
  'legacy-widget',
  'widget-group',
]) {
  entries['core/' + name] = { parents: [] };
}

entries['core/page-list-item'].restricted = true;
entries['core/page-list-item'].reason =
  'Page List creates these editor-only children from site pages and omits them from saved markup.';

for (const name of ['core/navigation-overlay-close']) {
  entries[name].restricted = true;
  entries[name].native_page = true;
  entries[name].reason = 'The native page editor disallows insertion of this registration.';
}

entries['core/nextpage'] = { parents: [], isolated: true };

const attrs = {
  'core/html': { content: '<p>Native HTML content</p>' },
  'core/freeform': { content: '<p>Native classic content</p>' },
  'core/text-columns': {
    content: [{ children: 'First column' }, { children: 'Second column' }],
    columns: 2,
  },
  'core/shortcode': { text: '[blockwork_matrix]' },
  'core/navigation-link': { label: 'Example', url: 'https://example.test/' },
  'core/navigation-submenu': { label: 'Examples', url: 'https://example.test/' },
  'core/audio': { src: 'https://example.test/audio.mp3' },
  'core/video': { src: 'https://example.test/video.mp4' },
  'core/file': {
    href: 'https://example.test/file.pdf',
    fileName: 'Example file',
    textLinkHref: 'https://example.test/file.pdf',
  },
  'core/math': {
    latex: 'x',
    mathML:
      '<semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics>',
  },
  'core/rss': { feedURL: 'https://example.test/feed/' },
  'core/post-terms': { term: 'category' },
  'core/post-date': { datetime: '2026-01-01T00:00:00' },
  'core/query': {
    query: {
      perPage: 1,
      pages: 0,
      offset: 0,
      postType: 'post',
      order: 'desc',
      orderBy: 'date',
      inherit: false,
    },
  },
  'core/paragraph': { content: 'Matrix paragraph' },
  'core/heading': { content: 'Matrix heading', level: 2 },
  'core/list-item': { content: 'Matrix item' },
  'core/button': { text: 'Read more', url: 'https://example.test/' },
  'core/image': { url: 'https://example.test/image.png', alt: 'Example image' },
  'core/embed': { url: 'https://example.test/video', type: 'video', providerNameSlug: 'youtube' },
  'core/social-link': { service: 'wordpress', url: 'https://example.test/' },
  'core/code': { content: 'Example code' },
  'core/verse': { content: 'Example verse' },
  'core/preformatted': { content: 'Example text' },
  'core/details': { summary: 'Details' },
  'core/table': { body: [{ cells: [{ content: 'Cell', tag: 'td' }] }] },
};
const children = {
  'core/terms-query': [{ name: 'core/term-template', inner_blocks: [{ name: 'core/term-name' }] }],
  'core/term-template': [{ name: 'core/term-name' }],
  'core/gallery': [{ name: 'core/image', attributes: attrs['core/image'] }],
  'core/post-template': [{ name: 'core/post-title' }],
  'core/query': [{ name: 'core/post-template', inner_blocks: [{ name: 'core/post-title' }] }],
  'core/query-no-results': [
    { name: 'core/paragraph', attributes: { content: 'No matching posts' } },
  ],
  'core/list': [{ name: 'core/list-item', attributes: { content: 'Item' } }],
  'core/buttons': [
    { name: 'core/button', attributes: { text: 'Read more', url: 'https://example.test/' } },
  ],
  'core/columns': [
    {
      name: 'core/column',
      inner_blocks: [{ name: 'core/paragraph', attributes: { content: 'Column' } }],
    },
  ],
  'core/group': [{ name: 'core/paragraph', attributes: { content: 'Group' } }],
  'core/cover': [{ name: 'core/paragraph', attributes: { content: 'Cover' } }],
  'core/quote': [{ name: 'core/paragraph', attributes: { content: 'Quote' } }],
  'core/media-text': [{ name: 'core/paragraph', attributes: { content: 'Media text' } }],
  'core/social-links': [
    {
      name: 'core/social-link',
      attributes: { service: 'wordpress', url: 'https://example.test/' },
    },
  ],
};

function containsBlock(input, name) {
  return input.name === name || input.inner_blocks.some((child) => containsBlock(child, name));
}

async function build(name, entry, tab) {
  for (const parent of ['tabs', 'comments', 'accordion']) {
    if (entry.parents.includes(parent)) {
      const context = (await nativeFixture(`core/${parent}`, tab)).input;

      if (containsBlock(context, name)) return structuredClone(context);
    }
  }

  let block = { name, attributes: attrs[name] ?? {}, inner_blocks: children[name] ?? [] };

  for (const parent of entry.parents) {
    const inner = [block];

    if (parent === 'query' && block.name !== 'core/post-template') {
      inner.unshift({ name: 'core/post-template', inner_blocks: [{ name: 'core/post-title' }] });
    }

    if (parent === 'accordion-item') {
      if (name === 'core/accordion-heading') inner.push({ name: 'core/accordion-panel' });

      if (name === 'core/accordion-panel') inner.unshift({ name: 'core/accordion-heading' });
    }

    block = {
      name: `core/${parent}`,
      attributes: attrs[`core/${parent}`] ?? {},
      inner_blocks: inner,
    };
  }

  return block;
}

async function nativeFixture(name, tab) {
  if (nativeFixtures.has(name)) return nativeFixtures.get(name);

  const contexts = {
    'core/tabs': {
      name: 'core/tabs',
      inner_blocks: [
        { name: 'core/tab-list', attributes: { tabs: [{ label: 'First' }] } },
        {
          name: 'core/tab-panels',
          inner_blocks: [
            {
              name: 'core/tab-panel',
              attributes: { label: 'First' },
              inner_blocks: [{ name: 'core/paragraph', attributes: { content: 'First' } }],
            },
          ],
        },
      ],
    },
    'core/accordion': {
      name: 'core/accordion',
      inner_blocks: [
        {
          name: 'core/accordion-item',
          inner_blocks: [
            { name: 'core/accordion-heading', attributes: { title: 'Title', level: 3 } },
            { name: 'core/accordion-panel' },
          ],
        },
      ],
    },
    'core/comments': {
      name: 'core/comments',
      inner_blocks: [
        { name: 'core/comments-title' },
        {
          name: 'core/comment-template',
          inner_blocks: [
            'comment-author-name',
            'comment-content',
            'comment-date',
            'comment-edit-link',
            'comment-reply-link',
          ].map((name) => ({ name: `core/${name}` })),
        },
        {
          name: 'core/comments-pagination',
          inner_blocks: [
            'comments-pagination-previous',
            'comments-pagination-numbers',
            'comments-pagination-next',
          ].map((name) => ({ name: `core/${name}` })),
        },
      ],
    },
  };
  const source = contexts[name] ?? (await build(name, entries[name], tab));

  if (!discovery) {
    const id = await seedDocument(site, { content: paragraph('Discovery') });
    const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);
    discovery = { id, tab };
    await waitFor(site, tab, "window.wp?.data?.select('core/editor')?.__unstableIsEditorReady?.()");
  }

  const { id, tab: discoveryTab } = discovery;

  if (entries[name].restricted) {
    const result = {
      input: source,
      markup: await site.evaluate(
        discoveryTab,
        `wp.blocks.serialize([wp.blocks.createBlock(${JSON.stringify(source.name)}, ${JSON.stringify(source.attributes ?? {})})])`,
      ),
    };
    nativeFixtures.set(name, result);

    return result;
  }

  const clientId = await site.evaluate(
    discoveryTab,
    `(() => {
      const create = input => {
        const attributes = { ...input.attributes };
        if (input.name === 'core/query' && attributes.queryId === undefined) attributes.queryId = ${10000 + registered.indexOf(name)};
        return wp.blocks.createBlock(input.name, attributes, (input.inner_blocks || []).map(create));
      };
      const block = create(${JSON.stringify(source)});
      wp.data.dispatch('core/block-editor').resetBlocks([block]);
      return block.clientId;
    })()`,
  );
  await waitFor(
    site,
    discoveryTab,
    `[document, ...Array.from(document.querySelectorAll("iframe"), frame => frame.contentDocument).filter(Boolean)].some(doc => doc.querySelector('[data-block="${clientId}"]'))`,
  );
  await site.evaluate(discoveryTab, "wp.data.dispatch('core/editor').savePost()");
  await waitFor(
    site,
    discoveryTab,
    "!wp.data.select('core/editor').isSavingPost() && !wp.data.select('core/editor').isEditedPostDirty()",
  );
  const input = await site.evaluate(
    discoveryTab,
    `(() => {
      const input = block => {
        const schema = wp.blocks.getBlockType(block.name).attributes;
        const attributes = Object.fromEntries(Object.entries(block.attributes).filter(([key]) => schema[key]?.role !== 'local' && schema[key]?.__experimentalRole !== 'local'));
        return { name: block.name, attributes, inner_blocks: block.innerBlocks.map(input) };
      };
      return JSON.parse(JSON.stringify(input(wp.data.select('core/block-editor').getBlocks()[0])));
    })()`,
  );
  const result = { input, markup: (await storedDocument(site, id)).content };
  nativeFixtures.set(name, result);

  return result;
}

async function assertCanContinue(blockwork, leaf, name) {
  if (leaf.completed) return;
  const status = await blockwork.status();
  assertSuccess(status);

  if (
    status.busy ||
    status.persistence === 'uncertain' ||
    ['partial', 'uncertain', 'running'].includes(status.last_request?.outcome)
  ) {
    throw new Error(`Cannot continue after ${name}: ${JSON.stringify(status)}`);
  }
}

function assertSuccess(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
}

test('registered core blocks have an explicit matrix entry', () => {
  assert.deepEqual(
    registered.filter((name) => !entries[name]),
    [],
    'Add a treatment for every new core block',
  );
});

generated('core blocks insert and provide guides', async (t) => {
  const names = registered.filter(
    (name) => name !== 'core/page-list' && !entries[name].isolated && t.selected(name),
  );

  if (!names.length) return;
  await withDocument(
    site,
    { content: paragraph('Anchor') },
    async ({ blockwork, id, before, tab }) => {
      let changed = false;

      for (const name of names) {
        const leaf = await t.test(name, async () => {
          const entry = entries[name];
          assert.ok(entry, `No matrix treatment for ${name}`);
          const guide = await blockwork.read({
            attribute_guide: { name },
            style_guides: [{ name }],
          });
          assertSuccess(guide);
          assert.equal(guide.attribute_guide.name, name);
          assert.equal(guide.attribute_guide.registered, true);
          assert.ok(Array.isArray(guide.attribute_guide.attributes));
          assert.equal(guide.style_guides[0].name, name);

          if (entry.restricted || entry.parents.includes('navigation')) {
            assert.ok(entry.reason || entry.parents.includes('navigation'));

            if (entry.native_page) {
              assert.equal(
                await site.evaluate(
                  tab,
                  `wp.data.select('core/block-editor').canInsertBlockType(${JSON.stringify(name)})`,
                ),
                false,
              );
            }

            const refused = await blockwork.edit({
              edits: [
                { op: 'insert', block: entry.parents ? await build(name, entry, tab) : { name } },
              ],
            });
            await assertRefused(site, id, before, refused);

            return;
          }

          const result = await blockwork.edit({
            edits: [{ op: 'insert', block: await build(name, entry, tab) }],
          });

          assertSuccess(result);
          changed = true;
        });

        await assertCanContinue(blockwork, leaf, name);
      }

      if (changed) {
        const containers = await site.evaluate(
          tab,
          "wp.data.select('core/block-editor').getBlocks().filter(block => ['core/comments', 'core/tabs', 'core/accordion', 'core/details'].includes(block.name)).map(block => block.clientId)",
        );

        for (const client_id of containers) {
          assertSuccess(await blockwork.read({ blocks: { client_id, depth: 8, limit: 50 } }));
        }

        const saved = await blockwork.save();
        await assertSavedCleanly(site, id, before, saved);
        const page = await frontEnd(site, id);
        assert.equal(page.status, 200);
        assert.doesNotMatch(
          page.html,
          /(?:PHP (?:Warning|Fatal error)|<b>(?:Warning|Fatal error)<\/b>)/i,
        );
      }
    },
  );
});

test('Page List inserts and saves in isolation', async () => {
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before }) => {
    assertSuccess(
      await blockwork.read({
        attribute_guide: { name: 'core/page-list' },
        style_guides: [{ name: 'core/page-list' }],
      }),
    );
    assertSuccess(
      await blockwork.edit({ edits: [{ op: 'insert', block: { name: 'core/page-list' } }] }),
    );
    await assertSavedCleanly(site, id, before, await blockwork.save());
    const page = await frontEnd(site, id);
    assert.equal(page.status, 200);
    assert.doesNotMatch(
      page.html,
      /(?:PHP (?:Warning|Fatal error)|<b>(?:Warning|Fatal error)<\/b>)/i,
    );
  });
});

test('Page Break inserts in the native Post Content document', async () => {
  await withDocument(
    site,
    { content: paragraph('Before') },
    async ({ blockwork, id, before, tab }) => {
      assertSuccess(
        await blockwork.read({
          attribute_guide: { name: 'core/nextpage' },
          style_guides: [{ name: 'core/nextpage' }],
        }),
      );
      assertSuccess(
        await blockwork.edit({
          edits: [
            { op: 'insert', block: { name: 'core/nextpage' } },
            { op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'After' } } },
          ],
        }),
      );
      await assertSavedCleanly(site, id, before, await blockwork.save());
      const marker = await site.evaluate(
        tab,
        "wp.blocks.serialize([wp.blocks.createBlock('core/nextpage')])",
      );
      assert.equal(
        (await storedDocument(site, id)).content,
        doc(paragraph('Before'), marker, paragraph('After')),
      );
      const first = await frontEnd(site, id);
      assert.equal(first.status, 200);
      assert.doesNotMatch(
        first.html,
        /(?:PHP (?:Warning|Fatal error)|<b>(?:Warning|Fatal error)<\/b>)/i,
      );
      const second = await fetch(site.site + '/?page_id=' + id + '&page=2');
      assert.equal(second.status, 200);
      assert.doesNotMatch(
        await second.text(),
        /(?:PHP (?:Warning|Fatal error)|<b>(?:Warning|Fatal error)<\/b>)/i,
      );
    },
  );
});

generated('Cover overlay colors insert', async (t) => {
  const cases = [
    {},
    { dimRatio: 50 },
    { overlayColor: 'contrast' },
    { customOverlayColor: '#000000' },
    { dimRatio: 50, customOverlayColor: '#000000' },
    { overlayColor: 'contrast', isUserOverlayColor: true },
    { customOverlayColor: '#000000', isUserOverlayColor: true },
    { allowedVideoProviders: ['youtube', 'vimeo'] },
    { isUserOverlayColor: true },
  ].filter((attributes) => t.selected(JSON.stringify(attributes)));

  if (!cases.length) return;
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, tab }) => {
    for (const attributes of cases) {
      const leaf = await t.test(JSON.stringify(attributes), async () => {
        t.diagnostic(
          JSON.stringify(
            await site.evaluate(
              tab,
              `(() => {
      const name = 'core/cover';
      const block = wp.blocks.createBlock(name, { overlayColor: 'contrast' });
      const markup = wp.blocks.serialize([block]);
      const parsed = wp.blocks.parse(markup)[0];
      return { schemas: Object.fromEntries(['allowedVideoProviders', 'isUserOverlayColor'].map(key => [key, wp.blocks.getBlockType(name).attributes[key]])), planned: block.attributes, parsed: parsed.attributes, byte_identical: wp.blocks.serialize([parsed]) === markup };
    })()`,
            ),
          ),
        );

        // The native control writes isUserOverlayColor with a color, so a color alone refuses, naming it.
        const incomplete =
          (attributes.overlayColor || attributes.customOverlayColor) &&
          !attributes.isUserOverlayColor;

        const result = await blockwork.edit({
          edits: [
            {
              op: 'insert',
              block: { name: 'core/cover', attributes, inner_blocks: children['core/cover'] },
            },
          ],
        });

        if (incomplete) {
          assert.equal(result.error, 'serialization_mismatch', JSON.stringify(result));
          assert.match(JSON.stringify(result.diagnostics), /isUserOverlayColor/);
        } else {
          assertSuccess(result);
        }
      });
      await assertCanContinue(blockwork, leaf, JSON.stringify(attributes));
    }
  });
});

generated('read markup can replace and copy a block', async (t) => {
  const names = registered
    .filter(
      (name) =>
        !entries[name].restricted &&
        !entries[name].parents.includes('navigation') &&
        t.selected(name),
    )
    .toSorted((a, b) => Number(a === 'core/page-list') - Number(b === 'core/page-list'));

  if (!names.length) return;
  await withDocument(
    site,
    { content: doc(paragraph('Anchor')) },
    async ({ blockwork, id, before, tab }) => {
      let changed = false;

      for (const name of names) {
        const leaf = await t.test(name, async () => {
          const inserted = await blockwork.edit({
            edits: [{ op: 'insert', block: await build(name, entries[name], tab) }],
          });
          assertSuccess(inserted);
          changed = true;
          const clientId = inserted.changed.find((block) => block.path.length === 1).client_id;
          const read = await blockwork.read({ blocks: { client_id: clientId, markup: true } });
          assertSuccess(read);
          assert.ok(read.markup);

          if (name === 'core/search') {
            const evidence = await site.evaluate(
              tab,
              `(() => {
                const block = wp.blocks.parse(${JSON.stringify(read.markup)})[0];
                const { query, ...attributes } = block.attributes;
                const recreated = wp.blocks.createBlock(block.name, attributes, block.innerBlocks);
                return { schema: wp.blocks.getBlockType(block.name).attributes.query,
                  parsed: query, recreated: recreated.attributes.query,
                  same_markup: wp.blocks.serialize([block]) === wp.blocks.serialize([recreated]) };
              })()`,
            );
            assert.equal(evidence.schema.type, 'object');
            assert.deepEqual(evidence.schema.default, []);
            assert.deepEqual(evidence.parsed, evidence.recreated);
            assert.equal(evidence.same_markup, true);
            t.diagnostic(JSON.stringify({ block: name, parser_default: evidence }));
          }

          const copy = await blockwork.edit({ edits: [{ op: 'insert', markup: read.markup }] });

          // Core's inserter disables a second copy of these.
          if (['core/more', 'core/footnotes'].includes(name)) {
            assert.equal(copy.error, 'insertion_refused', JSON.stringify(copy));
          } else {
            assertSuccess(copy);
          }

          const replace = await blockwork.edit({
            edits: [{ op: 'replace', client_id: clientId, markup: read.markup }],
          });

          // Resending what the block already holds is a documented refusal, not a change.
          assert.equal(replace.error, 'no_change', JSON.stringify(replace));
          assert.ok(replace.hint);
        });

        await assertCanContinue(blockwork, leaf, name);
      }

      if (changed) await assertSavedCleanly(site, id, before, await blockwork.save());
    },
  );
});

generated('registered variations insert', async (t) => {
  const variations = await withDocument(site, { content: paragraph('Anchor') }, async ({ tab }) =>
    site.evaluate(
      tab,
      `wp.blocks.getBlockTypes().filter(block => block.name.startsWith('core/')).flatMap(block => wp.blocks.getBlockVariations(block.name).slice(0, 3).map(variation => ({ name: block.name, variation: variation.name, inserter: wp.blocks.getBlockVariations(block.name, 'inserter').some(candidate => candidate.name === variation.name) })))`,
    ),
  );

  const selected = variations.filter((variation) =>
    t.selected(`${variation.name} ${variation.variation}`),
  );

  if (!selected.length) return;
  await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, id, before }) => {
    for (const variation of selected) {
      const leaf = await t.test(`${variation.name} ${variation.variation}`, async () => {
        let parentClientId;

        if (!variation.inserter) {
          const result = await blockwork.edit({
            edits: [
              { op: 'insert_variation', name: variation.name, variation: variation.variation },
            ],
          });
          await assertRefused(site, id, before, result, { error: 'stale_variation' });

          return;
        }

        if (entries[variation.name]?.parents?.includes('navigation')) {
          const result = await blockwork.edit({
            edits: [{ op: 'insert', block: { name: 'core/navigation' } }],
          });
          await assertRefused(site, id, before, result, { error: 'reference_operation_required' });

          return;
        }

        if (variation.name === 'core/social-link') {
          const parent = await blockwork.edit({
            edits: [{ op: 'insert', block: { name: 'core/social-links' } }],
          });
          assertSuccess(parent);
          parentClientId = parent.changed.find(
            (block) => block.name === 'core/social-links',
          ).client_id;
        }

        const edit = {
          op: 'insert_variation',
          name: variation.name,
          variation: variation.variation,
        };

        if (variation.name === 'core/file') edit.attributes = attrs['core/file'];

        if (parentClientId) edit.parent_client_id = parentClientId;

        const result = await blockwork.edit({ edits: [edit] });

        if (variation.name === 'core/template-part') {
          await assertRefused(site, id, before, result, { error: 'reference_operation_required' });
        } else {
          assertSuccess(result);
        }
      });
      await assertCanContinue(blockwork, leaf, `${variation.name} ${variation.variation}`);
    }
  });
});

generated('registered block styles can be set and cleared', async (t) => {
  const names = [
    'core/image',
    'core/button',
    'core/quote',
    'core/separator',
    'core/table',
    'core/social-links',
  ].filter((name) => t.selected(name));

  if (!names.length) return;
  await withDocument(
    site,
    { content: paragraph('Anchor') },
    async ({ blockwork, id, before, tab }) => {
      let changed = false;

      for (const name of names) {
        const leaf = await t.test(name, async () => {
          const inserted = await blockwork.edit({
            edits: [{ op: 'insert', block: await build(name, entries[name], tab) }],
          });
          assertSuccess(inserted);
          changed = true;
          const clientId = inserted.changed.find((block) => block.name === name).client_id;
          const styles = await site.evaluate(
            tab,
            `wp.data.select('core/blocks').getBlockStyles(${JSON.stringify(name)}).map(style => style.name)`,
          );

          for (const style of [...styles, null]) {
            assertSuccess(
              await blockwork.edit({
                edits: [{ op: 'set_block_style', client_id: clientId, style }],
              }),
            );
          }
        });
        await assertCanContinue(blockwork, leaf, name);
      }

      if (changed) await assertSavedCleanly(site, id, before, await blockwork.save());
    },
  );
});


generated(
  'registered core and theme patterns insert and reopen',
  { findings: [] },
  async (t) => {
    await withDocument(site, { content: paragraph('Anchor') }, async ({ blockwork, tab }) => {
      const references = await site.evaluate(
        tab,
        `(async () => {
      const patterns = await wp.data.resolveSelect('core').getBlockPatterns();
      const containsReference = blocks => blocks.some(block => ['core/block', 'core/navigation', 'core/template-part'].includes(block.name) || containsReference(block.innerBlocks));
      return patterns.filter(pattern => containsReference(wp.blocks.parse(pattern.content))).map(pattern => pattern.name);
    })()`,
      );
      const read = await blockwork.read({ patterns: true });
      assertSuccess(read);
      const offered = read.patterns.items;
      const comments = offered.filter((pattern) => /comments/.test(pattern.name));
      const patterns = [
        ...comments,
        ...offered.filter((pattern) => !comments.includes(pattern)),
      ].slice(0, 40);
      assert.ok(patterns.length > 0);

      for (const pattern of patterns) {
        await t.test(pattern.name, {}, async () => {
          if (pattern.name === 'core/query-offset-posts') {
            for (let index = 0; index < 3; index += 1) {
              await seedDocument(site, {
                type: 'post',
                title: 'Offset preview ' + index,
                content: paragraph('Offset preview content'),
              });
            }
          }

          await withDocument(
            site,
            { content: paragraph('Pattern anchor') },
            async ({ blockwork, id, before }) => {
              const result = await blockwork.edit({
                edits: [{ op: 'insert_pattern', pattern: pattern.name }],
              });

              if (references.includes(pattern.name)) {
                await assertRefused(site, id, before, result, {
                  error: 'reference_operation_required',
                });
              } else if (pattern.name === 'twentytwentyfive/binding-format') {
                await assertRefused(site, id, before, result, { error: 'unsupported_attribute' });
                assert.equal(result.diagnostics.attribute, 'metadata.bindings');
              } else {
                assertSuccess(result);
              }

              if (result.ok) await assertSavedCleanly(site, id, before, await blockwork.save());
            },
          );
        });
      }
    });
  },
);

async function emptyCommentsPattern(check) {
  await site.php("update_option('blockwork_matrix_comments', false);");

  try {
    await withDocument(
      site,
      { content: paragraph('Anchor') },
      async ({ blockwork, id, before }) => {
        const result = await blockwork.edit({
          edits: [{ op: 'insert_pattern', pattern: 'twentytwentyfive/comments' }],
        });
        await check({ blockwork, id, before, result });
      },
    );
  } finally {
    await site.php("update_option('blockwork_matrix_comments', true);");
  }
}

test(
  'Comments pattern in a page without comments',
  async () => {
    await emptyCommentsPattern(async ({ blockwork, id, before, result }) => {
      assertSuccess(result);
      await assertSavedCleanly(site, id, before, await blockwork.save());
    });
  },
);

test('hidden Comments descendants remain readable after native pattern insertion', async () => {
  await emptyCommentsPattern(async ({ blockwork, id, before, result }) => {
    assertSuccess(result);
    const read = await blockwork.read({ blocks: 'all' });
    assertSuccess(read);
    const template = read.blocks.find(block => block.name === 'core/comment-template');
    assert.ok(template);
    assert.ok(read.blocks.some(block => block.name === 'core/comment-content'));
    const markup = await blockwork.read({ blocks: { client_id: template.client_id, markup: true } });
    assertSuccess(markup);
    assert.match(markup.markup, /wp:comment-content/);
    await assertSavedCleanly(site, id, before, await blockwork.save());
  });
});

// Generate in Gutenberg rather than guessing its save markup. Chunks keep each
// document below the engine's block and inspection budgets.
generated('every native block preserves its bytes beside an edit', async (t) => {
  const generated = [];
  const isolated = [];

  for (const name of registered) {
    const entry = entries[name];

    if (
      (entry.restricted && !['core/html', 'core/freeform'].includes(name)) ||
      entry.parents.includes('navigation')
    )
      continue;

    if (['core/post-date', 'core/page-list'].includes(name)) isolated.push([{ name }]);
    else generated.push({ name });
  }

  const batches = [];

  for (let offset = 0; offset < generated.length; offset += 12) {
    batches.push(generated.slice(offset, offset + 12));
  }

  const selectedBatches = [...batches, ...isolated].filter((batch) =>
    t.selected(batch.map(({ name }) => name).join(', ')),
  );

  if (!selectedBatches.length) return;

  for (const batch of selectedBatches) {
    for (const { name } of batch) await nativeFixture(name);
  }

  for (const batch of selectedBatches) {
    await t.test(batch.map(({ name }) => name).join(', '), async () => {
      const markup = doc(
        ...(await Promise.all(batch.map(async ({ name }) => nativeFixtures.get(name).markup))),
      );
      await withDocument(
        site,
        { content: doc(markup, paragraph('Before')) },
        async ({ blockwork, doc: opened, id, before }) => {
          const target = opened.blocks.at(-1);
          assertSuccess(
            await blockwork.edit({
              edits: [
                { op: 'update', client_id: target.client_id, attributes: { content: 'After' } },
              ],
            }),
          );
          await assertSavedCleanly(site, id, before, await blockwork.save());
          assert.equal((await storedDocument(site, id)).content, doc(markup, paragraph('After')));
        },
      );
    });
  }
});

function updateAttributes(name, guide) {
  if (name === 'core/math') return mathUpdate;

  if (name === 'core/file') return { fileName: 'Updated file.wav' };

  if (name === 'core/text-columns')
    return {
      content: [{ children: 'Updated first column' }, { children: 'Updated second column' }],
    };

  if (name === 'core/table') return { body: [{ cells: [{ content: 'Updated cell', tag: 'td' }] }] };

  if (name === 'core/query') return { query: { perPage: 2 } };

  if (name === 'core/query-pagination') return { showLabel: false, paginationArrow: 'arrow' };

  const text = ['content', 'text', 'summary', 'citation', 'caption', 'label', 'alt'].find((key) =>
    guide.attributes.some(
      (attribute) => attribute.name === key && ['string', 'rich-text'].includes(attribute.type),
    ),
  );

  if (text) return { [text]: 'Updated matrix value' };

  const boolean = guide.attributes.find(
    (attribute) =>
      attribute.editable &&
      attribute.role !== 'local' &&
      attribute.name !== 'legacy' &&
      attribute.type === 'boolean',
  );

  if (boolean) return { [boolean.name]: !boolean.default };

  const number = guide.attributes.find(
    (attribute) =>
      attribute.editable &&
      attribute.role !== 'local' &&
      ['number', 'integer'].includes(attribute.type) &&
      !attribute.enum,
  );

  if (number) return { [number.name]: (number.default ?? 1) + 1 };

  const choice = guide.attributes.find(
    (attribute) => attribute.editable && attribute.role !== 'local' && attribute.enum?.length > 1,
  );

  if (choice) return { [choice.name]: choice.enum.find((value) => value !== choice.default) };

  // Blocks without their own scalar settings still expose the native List View name.
  return { metadata: { name: 'Updated matrix setting' } };
}

generated('each block updates, moves, and removes without changing neighbors', async (t) => {
  const names = registered.filter(
    (name) => !entries[name].restricted && !entries[name].parents.includes('navigation'),
  );
  const ordinary = names.filter(
    (name) =>
      name !== 'core/page-list' && name !== 'core/tabs' && !entries[name].parents.includes('tabs'),
  );
  const tabs = names.filter(
    (name) => name === 'core/tabs' || entries[name].parents.includes('tabs'),
  );
  const batches = [];

  for (let offset = 0; offset < ordinary.length; offset += 32)
    batches.push(ordinary.slice(offset, offset + 32));

  if (tabs.length) batches.push(tabs);

  if (names.includes('core/page-list')) batches.push(['core/page-list']);
  const named = (tree) => tree.filter((block) => block.blockName);

  for (const batch of batches) {
    const selected = batch.filter((name) => t.selected(name));

    if (!selected.length) continue;
    await withDocument(
      site,
      { content: paragraph('Untouched') },
      async ({ blockwork, id, before, tab }) => {
        const original = await storedTree(site, id);
        const roots = [];

        for (const name of selected) {
          const leaf = await t.test(name, async () => {
            const inserted = await blockwork.edit({
              edits: [{ op: 'insert', block: await build(name, entries[name], tab) }],
            });
            assertSuccess(inserted);
            const root = inserted.changed.find((block) => block.path.length === 1);
            roots.push({ name, root });
            const target = inserted.changed.find((block) => block.name === name);
            const guide = await blockwork.read({ attribute_guide: { name } });
            const attributes = updateAttributes(name, guide.attribute_guide);
            const edits = [{ op: 'update', client_id: target.client_id, attributes }];

            if (name === 'core/tab-panel' && Object.hasOwn(attributes, 'label')) {
              const list = await site.evaluate(
                tab,
                `(() => { const root = wp.data.select('core/block-editor').getBlock(${JSON.stringify(root.client_id)}); return { client_id: root.innerBlocks[0].clientId, tabs: root.innerBlocks[1].innerBlocks.map(panel => ({ label: panel.clientId === ${JSON.stringify(target.client_id)} ? ${JSON.stringify(attributes.label)} : panel.attributes.label || '' })) }; })()`,
              );
              edits.push({ op: 'update', client_id: list.client_id, attributes: { tabs: list.tabs } });
            }

            assertSuccess(
              await blockwork.edit({
                edits,
              }),
            );
            const actual = await site.evaluate(
              tab,
              `JSON.parse(JSON.stringify(wp.data.select('core/block-editor').getBlock(${JSON.stringify(target.client_id)}).attributes))`,
            );
            assert.partialDeepStrictEqual(actual, attributes);
          });
          await assertCanContinue(blockwork, leaf, name);
        }

        if (!roots.length) return;
        const containers = await site.evaluate(
          tab,
          "wp.data.select('core/block-editor').getBlocks().filter(block => ['core/comments', 'core/tabs', 'core/accordion', 'core/details'].includes(block.name)).map(block => block.clientId)",
        );

        for (const client_id of containers) {
          assertSuccess(await blockwork.read({ blocks: { client_id, depth: 8, limit: 50 } }));
        }

        await assertSavedCleanly(site, id, before, await blockwork.save());
        const updated = await storedTree(site, id);
        assert.deepEqual(named(updated)[0], named(original)[0]);
        assert.ok(
          changedPaths(original, updated).every((path) => path !== '0' && !path.startsWith('0.')),
        );

        for (const { root } of roots) {
          assertSuccess(
            await blockwork.edit({ edits: [{ op: 'move', client_id: root.client_id, index: 0 }] }),
          );
        }

        await assertSavedCleanly(site, id, before, await blockwork.save());
        const moved = await storedTree(site, id);
        assert.deepEqual(named(moved), [...named(updated).slice(1).reverse(), named(updated)[0]]);

        for (const { root } of roots) {
          assertSuccess(
            await blockwork.edit({ edits: [{ op: 'remove', client_id: root.client_id }] }),
          );
        }

        await assertSavedCleanly(site, id, before, await blockwork.save());
        assert.deepEqual(changedPaths(original, await storedTree(site, id)), []);
      },
    );
  }
});

generated(
  'default and populated media serialization are independently reproducible',
  { findings: [mediaFinding] },
  async (t) => {
    for (const name of ['core/audio', 'core/video', 'core/file', 'core/math']) {
      let cases = [{}, attrs[name]];

      if (mediaSources.has(name)) cases = [{}, mediaSources.get(name), attrs[name]];

      if (name === 'core/math')
        cases = [
          {},
          { latex: 'x' },
          { mathML: attrs[name].mathML },
          attrs[name],
          { mathML: '<math><mi>x</mi></math>' },
        ];

      const labels =
        name === 'core/math'
          ? ['empty', 'latex_only', 'mathml_only', 'explicit_defaults', 'invalid_mathml']
          : mediaSources.has(name)
            ? ['empty', 'source_only', 'explicit_defaults']
            : ['empty', 'explicit_defaults'];

      for (const [index, attributes] of cases.entries()) {
        const invalidMath = name === 'core/math' && attributes.mathML?.startsWith('<math>');
        // Math's save output needs both its LaTeX and MathML, so one alone is an incomplete request.
        const incompleteMath =
          name === 'core/math' && !invalidMath && (!attributes.mathML || !attributes.latex);
        await t.test(
          `${name} ${labels[index]}`,
          { todo: name === 'core/video' && index === 0 ? todoFor(mediaFinding) : undefined },
          async () => {
            await withDocument(
              site,
              { content: paragraph('Anchor') },
              async ({ blockwork, id, before }) => {
                const result = await blockwork.edit({
                  edits: [{ op: 'insert', block: { name, attributes } }],
                });

                if (invalidMath || incompleteMath) {
                  await assertRefused(site, id, before, result, {
                    error: 'serialization_mismatch',
                  });

                  return;
                }

                assertSuccess(result);
                await assertSavedCleanly(site, id, before, await blockwork.save());
              },
            );
          },
        );
      }
    }

    await t.test(
      'core/file default File variation without a file URL',
      { todo: todoFor(mediaFinding) },
      async () => {
        await withDocument(
          site,
          { content: paragraph('Anchor') },
          async ({ blockwork, id, before }) => {
            const result = await blockwork.edit({
              edits: [{ op: 'insert_variation', name: 'core/file', variation: 'default' }],
            });
            assertSuccess(result);
            await assertSavedCleanly(site, id, before, await blockwork.save());
          },
        );
      },
    );
  },
);

generated('WordPress 7.0.8 reduced matrix', async (t) => {
  const names = [
    'core/paragraph',
    'core/heading',
    'core/image',
    'core/list',
    'core/buttons',
    'core/quote',
    'core/table',
    'core/group',
    'core/cover',
    'core/separator',
  ].filter((name) => t.selected(name));

  if (!names.length) return;
  await using baseline = await startEditingSite({ version: '7.0.8' });
  await withDocument(
    baseline,
    { content: paragraph('Anchor') },
    async ({ blockwork, id, before, tab }) => {
      let changed = false;

      for (const name of names) {
        const leaf = await t.test(name, async () => {
          assertSuccess(
            await blockwork.edit({
              edits: [{ op: 'insert', block: await build(name, entries[name], tab) }],
            }),
          );
          changed = true;
        });
        await assertCanContinue(blockwork, leaf, name);
      }

      if (changed) {
        await assertSavedCleanly(baseline, id, before, await blockwork.save());
        const page = await frontEnd(baseline, id);
        assert.equal(page.status, 200);
        assert.doesNotMatch(
          page.html,
          /(?:PHP (?:Warning|Fatal error)|<b>(?:Warning|Fatal error)<\/b>)/i,
        );
      }
    },
  );
});

const navigationChildren = (() => {
  const children = [
    {
      name: 'core/navigation-link',
      attributes: { label: 'Matrix link', url: 'https://example.test/', kind: 'custom' },
    },
    {
      name: 'core/navigation-submenu',
      attributes: { label: 'Matrix submenu' },
      inner_blocks: [
        {
          name: 'core/navigation-link',
          attributes: { label: 'Nested link', url: 'https://example.test/nested', kind: 'custom' },
        },
      ],
    },
    { name: 'core/home-link', attributes: { label: 'Matrix home' } },
  ];

  return children;
})();

async function withNavigation(body) {
  await withDocument(site, { content: paragraph('Before') }, async (context) => {
    const { blockwork, tab } = context;
    const children = navigationChildren;
    const content = await site.evaluate(
      tab,
      `(() => {
      const create = input => wp.blocks.createBlock(input.name, input.attributes || {}, (input.inner_blocks || []).map(create));
      return wp.blocks.serialize(${JSON.stringify(children)}.map(create));
    })()`,
    );
    const navigation = await seedDocument(site, { type: 'wp_navigation', content });
    const target = {
      site_url: site.site,
      user_id: 1,
      post_id: navigation,
      post_type: 'wp_navigation',
    };
    const inspected = await blockwork.call({ operation: 'inspect_entity', target });
    assertSuccess(inspected);
    await body({ ...context, content, navigation, inspected });
  });
}

async function withNavigationEditor(body) {
  await withNavigation(async ({ navigation, content, inspected }) => {
    const editor = await site.openTab(inspected.editor_url);
    const caller = await site.createCaller(editor);

    try {
      assertSuccess(
        await caller.connect({
          target: { site_url: site.site, post_id: navigation, post_type: 'wp_navigation' },
          workflow: 'background',
        }),
      );

      const navigationTree = await storedTree(site, navigation);
      await body({ caller, editor, navigation, content, navigationTree });
    } finally {
      await caller.release();
      await editor.close();
    }
  });
}

test('Navigation references and native Navigation child insertion page reference', async () => {
  await withNavigation(
    async ({ blockwork, doc: opened, id, before, tab, content, navigation, inspected }) => {
      const reference = {
        entity_type: 'wp_navigation',
        entity_id: navigation,
        reference_token: inspected.reference_token,
      };
      const insertedReference = await blockwork.edit({
        edits: [{ op: 'insert_reference', reference }],
      });
      assertSuccess(insertedReference);
      const navigationBlock = insertedReference.changed.find(
        (block) => block.name === 'core/navigation',
      );
      assertSuccess(
        await blockwork.edit({
          edits: [
            {
              op: 'update',
              client_id: navigationBlock.client_id,
              attributes: { overlayMenu: 'always' },
            },
          ],
        }),
      );
      const markup = await site.evaluate(
        tab,
        `wp.blocks.serialize([wp.blocks.createBlock('core/navigation', { ref: ${navigation}, overlayMenu: 'always' })])`,
      );
      assertSuccess(
        await blockwork.edit({
          edits: [
            {
              op: 'update',
              client_id: opened.blocks[0].client_id,
              attributes: { content: 'After' },
            },
          ],
        }),
      );
      await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal((await storedDocument(site, navigation)).content, content);
      assert.equal((await storedDocument(site, id)).content, doc(paragraph('After'), markup));
      const page = await frontEnd(site, id);
      assert.equal(page.status, 200);
      assert.doesNotMatch(
        page.html,
        /(?:PHP (?:Warning|Fatal error)|<b>(?:Warning|Fatal error)<\/b>)/i,
      );

      for (const op of ['insert', 'replace']) {
        const edit = { op, markup };

        if (op === 'replace') edit.path = [1];

        await assertRefused(
          site,
          id,
          await storedDocument(site, id),
          await blockwork.edit({ edits: [edit] }),
          { error: 'reference_operation_required' },
        );
      }

      const withReference = (await storedTree(site, id)).filter((block) => block.blockName);
      assertSuccess(
        await blockwork.edit({
          edits: [{ op: 'move', client_id: navigationBlock.client_id, index: 0 }],
        }),
      );
      await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.deepEqual(
        (await storedTree(site, id)).filter((block) => block.blockName),
        [withReference[1], withReference[0]],
      );
      assertSuccess(
        await blockwork.edit({ edits: [{ op: 'remove', client_id: navigationBlock.client_id }] }),
      );
      await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal((await storedDocument(site, id)).content, paragraph('After'));
      assert.equal((await storedDocument(site, navigation)).content, content);
    },
  );
});

generated('Navigation references and native Navigation child insertion', async (t) => {
  await withNavigationEditor(async ({ caller, editor, navigation, content, navigationTree }) => {
    let completed = false;

    for (const block of navigationChildren) {
      const operation = await t.test(block.name + ' in the shared Navigation editor', async () => {
        assertSuccess(
          await caller.read({
            attribute_guide: { name: block.name },
            style_guides: [{ name: block.name }],
          }),
        );
        const inserted = await caller.edit({
          scope: 'site_wide',
          edits: [{ op: 'insert', block }],
        });
        assertSuccess(inserted);
        const added = inserted.changed.find((item) => item.name === block.name);
        const read = await caller.read({ blocks: { client_id: added.client_id, markup: true } });
        assertSuccess(read);
        const copy = await caller.edit({
          scope: 'site_wide',
          edits: [{ op: 'insert', markup: read.markup }],
        });
        assertSuccess(copy);
        assertSuccess(
          await caller.edit({
            scope: 'site_wide',
            edits: [
              {
                op: 'remove',
                client_id: copy.changed.find((item) => item.path.length === 1).client_id,
              },
            ],
          }),
        );
        assertSuccess(
          await caller.edit({
            scope: 'site_wide',
            edits: [
              {
                op: 'update',
                client_id: added.client_id,
                attributes: { label: 'Updated navigation label' },
              },
            ],
          }),
        );
        assertSuccess(
          await caller.edit({
            scope: 'site_wide',
            edits: [{ op: 'move', client_id: added.client_id, index: 0 }],
          }),
        );
        assertSuccess(
          await caller.edit({
            scope: 'site_wide',
            edits: [{ op: 'remove', client_id: added.client_id }],
          }),
        );
        assert.deepEqual(await caller.save(), { ok: true, persistence: 'unchanged', saved: false });
        assert.deepEqual(changedPaths(navigationTree, await storedTree(site, navigation)), []);
        assert.equal((await storedDocument(site, navigation)).content, content);
      });

      if (operation.selected && !operation.completed) {
        await assertCanContinue(caller, operation, block.name);
        throw new Error(`Cannot continue after failed Navigation leaf`);
      }

      completed ||= operation.selected && operation.completed;

      const replacement = await t.test(block.name + ' identical markup replacement', async () => {
        const inserted = await caller.edit({
          scope: 'site_wide',
          edits: [{ op: 'insert', block }],
        });
        assertSuccess(inserted);
        const added = inserted.changed.find((item) => item.name === block.name);
        const read = await caller.read({ blocks: { client_id: added.client_id, markup: true } });
        assertSuccess(read);
        const replace = await caller.edit({
          scope: 'site_wide',
          edits: [{ op: 'replace', client_id: added.client_id, markup: read.markup }],
        });
        assert.equal(replace.error, 'no_change', JSON.stringify(replace));
        assertSuccess(
          await caller.edit({
            scope: 'site_wide',
            edits: [{ op: 'remove', client_id: added.client_id }],
          }),
        );
      });

      if (replacement.selected && !replacement.completed) {
        await assertCanContinue(caller, replacement, block.name);
        throw new Error(`Cannot continue after failed Navigation leaf`);
      }

      completed ||= replacement.selected && replacement.completed;
    }

    const variations = await site.evaluate(
      editor,
      "wp.blocks.getBlockVariations('core/navigation-link', 'inserter').slice(0, 3).map(variation => variation.name)",
    );

    for (const variation of variations) {
      const leaf = await t.test('Navigation Link variation ' + variation, async () => {
        const inserted = await caller.edit({
          scope: 'site_wide',
          edits: [
            {
              op: 'insert_variation',
              name: 'core/navigation-link',
              variation,
              attributes: { label: 'Matrix variation', url: 'https://example.test/variation' },
            },
          ],
        });
        assertSuccess(inserted);
        const added = inserted.changed.find((block) => block.name === 'core/navigation-link');
        assertSuccess(
          await caller.edit({
            scope: 'site_wide',
            edits: [{ op: 'remove', client_id: added.client_id }],
          }),
        );
        assert.deepEqual(await caller.save(), { ok: true, persistence: 'unchanged', saved: false });
        assert.equal((await storedDocument(site, navigation)).content, content);
      });

      if (leaf.selected && !leaf.completed) {
        await assertCanContinue(caller, leaf, variation);
        throw new Error(`Cannot continue after failed Navigation leaf`);
      }

      completed ||= leaf.selected && leaf.completed;
    }

    if (completed) {
      assert.deepEqual(await caller.save(), { ok: true, persistence: 'unchanged', saved: false });
      assert.deepEqual(changedPaths(navigationTree, await storedTree(site, navigation)), []);
      assert.equal((await storedDocument(site, navigation)).content, content);
    }
  });
});

test('Query Pagination refuses hiding its only navigation label', async (t) => {
  await withDocument(
    site,
    { content: paragraph('Anchor') },
    async ({ blockwork, id, before, tab }) => {
      const inserted = await blockwork.edit({
        edits: [
          {
            op: 'insert',
            block: await build('core/query-pagination', entries['core/query-pagination'], tab),
          },
        ],
      });
      assertSuccess(inserted);
      const target = inserted.changed.find((block) => block.name === 'core/query-pagination');
      const result = await blockwork.edit({
        edits: [{ op: 'update', client_id: target.client_id, attributes: { showLabel: false } }],
      });
      const actual = await site.evaluate(
        tab,
        `wp.data.select('core/block-editor').getBlock(${JSON.stringify(target.client_id)}).attributes`,
      );
      t.diagnostic(
        JSON.stringify({
          ok: result.ok,
          show_label: actual.showLabel,
          pagination_arrow: actual.paginationArrow,
        }),
      );
      await assertRefused(site, id, before, result);
    },
  );
});

for (const [entityType, name] of [
  ['wp_block', 'core/block'],
  ['wp_template_part', 'core/template-part'],
]) {
  test(name + ' uses reference operations and preserves native seeded bytes', async () => {
    await withDocument(
      site,
      { content: paragraph('Reference generator') },
      async ({ blockwork, tab }) => {
        let targets;

        if (entityType === 'wp_block') {
          targets = [];

          for (const text of ['First shared content', 'Second shared content']) {
            targets.push({
              site_url: site.site,
              user_id: 1,
              post_type: entityType,
              post_id: await seedDocument(site, { type: entityType, content: paragraph(text) }),
            });
          }
        } else {
          const listed = await blockwork.call({
            operation: 'list_entities',
            target: { site_url: site.site, user_id: 1 },
            entity_type: entityType,
          });
          assertSuccess(listed);
          assert.ok(listed.items.length >= 2);
          targets = listed.items.slice(0, 2).map((item) => item.target);
        }

        const first = await blockwork.call({ operation: 'inspect_entity', target: targets[0] });
        assertSuccess(first);
        let attributes = { ref: targets[0].post_id };

        if (entityType === 'wp_template_part') {
          const [theme, slug] = String(targets[0].post_id).split('//');
          attributes = { theme, slug, area: first.area };
        }

        const markup = await site.evaluate(
          tab,
          `wp.blocks.serialize([wp.blocks.createBlock(${JSON.stringify(name)}, ${JSON.stringify(attributes)})])`,
        );
        await withDocument(
          site,
          { content: doc(markup, paragraph('Before')) },
          async ({ blockwork, doc: opened, id, before, tab }) => {
            const original = await storedTree(site, id);
            assertSuccess(
              await blockwork.read({ attribute_guide: { name }, style_guides: [{ name }] }),
            );
            assertSuccess(
              await blockwork.edit({
                edits: [
                  {
                    op: 'update',
                    client_id: opened.blocks.at(-1).client_id,
                    attributes: { content: 'After' },
                  },
                ],
              }),
            );
            await assertSavedCleanly(site, id, before, await blockwork.save());
            assert.equal((await storedDocument(site, id)).content, doc(markup, paragraph('After')));
            const page = await frontEnd(site, id);
            assert.equal(page.status, 200);
            assert.doesNotMatch(
              page.html,
              /(?:PHP (?:Warning|Fatal error)|<b>(?:Warning|Fatal error)<\/b>)/i,
            );
            const current = await blockwork.call({
              operation: 'inspect_entity',
              target: targets[0],
            });
            assertSuccess(current);
            const reference = {
              entity_type: entityType,
              entity_id: targets[0].post_id,
              reference_token: current.reference_token,
            };
            const allowed = await site.evaluate(
              tab,
              `wp.data.select('core/block-editor').canInsertBlockType(${JSON.stringify(name)})`,
            );
            const result = await blockwork.edit({ edits: [{ op: 'insert_reference', reference }] });

            if (!allowed) {
              await assertRefused(site, id, await storedDocument(site, id), result, {
                error: 'insertion_refused',
              });

              return;
            }

            assertSuccess(result);
            let added = result.changed.find((block) => block.name === name);
            const second = await blockwork.call({
              operation: 'inspect_entity',
              target: targets[1],
            });
            assertSuccess(second);
            const updated = await blockwork.edit({
              edits: [
                {
                  op: 'update_reference',
                  client_id: added.client_id,
                  reference: {
                    entity_type: entityType,
                    entity_id: targets[1].post_id,
                    reference_token: second.reference_token,
                  },
                },
              ],
            });
            assertSuccess(updated);
            added = updated.changed.find((block) => block.name === name) ?? added;
            await assertSavedCleanly(site, id, before, await blockwork.save());
            const withCopy = (await storedTree(site, id)).filter((block) => block.blockName);
            const read = await blockwork.read({
              blocks: { client_id: added.client_id, markup: true },
            });
            assertSuccess(read);

            for (const op of ['insert', 'replace']) {
              const edit = { op, markup: read.markup };

              if (op === 'replace') edit.client_id = added.client_id;

              await assertRefused(
                site,
                id,
                await storedDocument(site, id),
                await blockwork.edit({ edits: [edit] }),
                { error: 'reference_operation_required' },
              );
            }

            assertSuccess(
              await blockwork.edit({
                edits: [{ op: 'move', client_id: added.client_id, index: 0 }],
              }),
            );
            await assertSavedCleanly(site, id, before, await blockwork.save());
            assert.deepEqual(
              (await storedTree(site, id)).filter((block) => block.blockName),
              [withCopy[2], withCopy[0], withCopy[1]],
            );
            assertSuccess(
              await blockwork.edit({ edits: [{ op: 'remove', client_id: added.client_id }] }),
            );
            await assertSavedCleanly(site, id, before, await blockwork.save());
            assert.equal((await storedDocument(site, id)).content, doc(markup, paragraph('After')));
            assert.deepEqual(changedPaths(original, await storedTree(site, id)), ['1']);
          },
        );
      },
    );
  });
}

// The reference inserts the registered source through Gutenberg. Its real edit
// components supply the expected attributes, rather than a test dispatch.
test('pattern Spacer conversion matches native insertion and clean persistence', async () => {
  const capture = `(async () => {
    const store = wp.data.select('core/block-editor');
    const flatten = blocks => blocks.flatMap(block => [block, ...flatten(block.innerBlocks)]);
    const spacers = flatten(store.getBlocks()).filter(block => block.name === 'core/spacer');
    for (const spacer of spacers) {
      wp.data.dispatch('core/block-editor').selectBlock(spacer.clientId);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return spacers.map(block => {
      const current = store.getBlock(block.clientId);
      const documents = [document, ...Array.from(document.querySelectorAll('iframe'), frame => frame.contentDocument).filter(Boolean)];
      const element = documents.map(doc => doc.querySelector('[data-block="' + block.clientId + '"]')).find(Boolean);
      return { attributes: current.attributes, serialization: wp.blocks.serialize([current]),
        mounted: Boolean(element), height: element?.getBoundingClientRect().height };
    });
  })()`;
  let native;
  await withDocument(site, { content: paragraph('Spacer oracle') }, async ({ tab }) => {
    await site.evaluate(
      tab,
      `(async () => {
      const patterns = await wp.data.resolveSelect('core').getBlockPatterns();
      const pattern = patterns.find(item => item.name === 'twentytwentyfive/cta-newsletter');
      if (!pattern) throw new Error('Newsletter pattern is required for the Spacer oracle');
      wp.data.dispatch('core/block-editor').insertBlocks(wp.blocks.parse(pattern.content));
    })()`,
    );
    await waitFor(
      site,
      tab,
      `(() => {
      const flatten = blocks => blocks.flatMap(block => [block, ...flatten(block.innerBlocks)]);
      const spacers = flatten(wp.data.select('core/block-editor').getBlocks())
        .filter(block => block.name === 'core/spacer');
      return spacers.length > 0 && spacers.every(block => block.attributes.height === '0px');
    })()`,
    );
    native = await site.evaluate(tab, capture);
    assert.ok(native.length > 0);
    assert.ok(native.every((block) => block.mounted));
  });
  await withDocument(
    site,
    { content: paragraph('Spacer oracle') },
    async ({ blockwork, tab, id, before }) => {
      assertSuccess(
        await blockwork.edit({
          edits: [{ op: 'insert_pattern', pattern: 'twentytwentyfive/cta-newsletter' }],
        }),
      );
      const actual = await site.evaluate(tab, capture);
      assert.deepEqual(actual, native);
      await assertSavedCleanly(site, id, before, await blockwork.save({ save_all_pending: true }));
      const page = await site.openTab(`${site.site}/?page_id=${id}`);

      try {
        await waitFor(site, page, "document.querySelectorAll('.wp-block-post-content .wp-block-spacer').length > 0");
        const heights = await site.evaluate(
          page,
          `Array.from(document.querySelectorAll('.wp-block-post-content .wp-block-spacer'), element => element.getBoundingClientRect().height)`,
        );
        assert.deepEqual(
          heights,
          native.map((block) => block.height),
        );
      } finally {
        await page.close();
      }
    },
    { workflow: 'attached' },
  );
});

run();
