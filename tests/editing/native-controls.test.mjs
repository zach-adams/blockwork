import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';

const { after, before, test, generated, run } = editingTests(import.meta.url);
import { block, column, columns, doc, paragraph } from './blocks.mjs';
import {
  assertSavedCleanly,
  assertRefused,
  frontEnd,
  changedPaths,
  serializeNatively,
  seedImage,
  startEditingSite,
  storedTree,
  withDocument,
} from './harness.mjs';

let site;
before(async () => {
  site = await startEditingSite();
  await addMediaCases();
});
after(() => site?.[Symbol.asyncDispose]());

const ok = (result) => assert.equal(result.ok, true, JSON.stringify(result));

async function assertCanContinue(blockwork, leaf, name) {
  if (leaf.completed) return;
  const status = await blockwork.status();
  ok(status);

  assert.ok(
    !status.busy &&
      status.persistence !== 'uncertain' &&
      !['partial', 'uncertain', 'running'].includes(status.last_request?.outcome),
    `Cannot continue after ${name}: ${JSON.stringify(status)}`,
  );
}

// An outline stops at 60 rows, and a save refuses blocks no read has returned.
async function readEveryBlock(blockwork, tab) {
  const roots = await site.evaluate(tab, "wp.data.select('core/block-editor').getBlockOrder()");

  for (const client_id of roots) {
    ok(await blockwork.read({ blocks: { client_id, depth: 8 } }));
  }
}

async function nativeMarkup(tab, body, ready = 'true') {
  return site.evaluate(
    tab,
    `(async () => {
    const store = wp.data.select('core/block-editor');
    const dispatch = wp.data.dispatch('core/block-editor');
    const original = store.getBlocks();
    let stop = () => {};
    let timer;
    try {
      ${body}
      if (!(${ready})) await new Promise((resolve,reject) => {
        stop = wp.data.subscribe(() => {if (${ready}) resolve();});
        timer = setTimeout(() => reject(new Error('Native child initialization did not finish')),30000);
      });
      return wp.blocks.serialize(wp.blocks.parse(wp.blocks.serialize(store.getBlocks())));
    } finally {
      stop();clearTimeout(timer);dispatch.resetBlocks(original);
    }
  })()`,
  );
}

// Each patch lists the writes in the corresponding core handler. Native store
// dispatch supplies the serialization oracle, independently of Blockwork's merge.
const image = (attributes = {}) => ({
  name: 'core/image',
  attributes: {
    url: 'https://example.test/old.png',
    alt: 'Old description',
    sizeSlug: 'large',
    ...attributes,
  },
});
const gallery = () => ({
  name: 'core/gallery',
  attributes: { linkTo: 'media', sizeSlug: 'large' },
  inner_blocks: [
    image({
      href: 'https://example.test/old.png',
      linkDestination: 'media',
      width: '200px',
      height: '100px',
    }),
    image({
      url: 'https://example.test/second.png',
      href: 'https://example.test/second.png',
      linkDestination: 'media',
    }),
  ],
});
const patch = (path, attributes, unset = []) => ({ path, attributes, unset });
const controlCases = [
  [
    'video autoplay',
    { name: 'core/video', attributes: { src: 'https://example.test/video.mp4' } },
    [patch([], { autoplay: true, muted: true, playsInline: true })],
    { autoplay: true },
  ],
  [
    'button unlink',
    {
      name: 'core/button',
      attributes: {
        text: 'Go',
        url: 'https://example.test/',
        linkTarget: '_blank',
        rel: 'nofollow',
      },
    },
    [patch([], {}, ['url', 'linkTarget', 'rel'])],
    {},
    ['url'],
  ],
  [
    'columns alignment',
    { name: 'core/columns', inner_blocks: [{ name: 'core/column' }, { name: 'core/column' }] },
    [
      patch([], { verticalAlignment: 'center' }),
      patch([0], { verticalAlignment: 'center' }),
      patch([1], { verticalAlignment: 'center' }),
    ],
  ],
  [
    'column alignment clears parent',
    {
      name: 'core/columns',
      attributes: { verticalAlignment: 'center' },
      inner_blocks: [
        { name: 'core/column', attributes: { verticalAlignment: 'center' } },
        { name: 'core/column', attributes: { verticalAlignment: 'center' } },
      ],
    },
    [patch([0], { verticalAlignment: 'bottom' }), patch([], {}, ['verticalAlignment'])],
  ],
  [
    'accordion heading level',
    {
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
    [patch([], { headingLevel: 4 }), patch([0, 0], { level: 4 })],
  ],
  [
    'gallery link',
    gallery(),
    [
      patch([], { linkTo: 'none' }),
      patch([0], { linkDestination: 'none' }, ['href', 'lightbox']),
      patch([1], { linkDestination: 'none' }, ['href', 'lightbox']),
    ],
  ],
  [
    'gallery new tab',
    {
      ...gallery(),
      inner_blocks: [
        image({
          href: 'https://example.test/old.png',
          linkDestination: 'media',
          rel: 'nofollow noopener noreferrer',
        }),
        image({
          url: 'https://example.test/second.png',
          href: 'https://example.test/second.png',
          linkDestination: 'media',
          rel: 'sponsored noreferrer',
        }),
      ],
    },
    [
      patch([], { linkTarget: '_blank' }),
      patch([0], { linkTarget: '_blank', rel: 'nofollow  noreferrer' }),
      patch([1], { linkTarget: '_blank', rel: 'sponsored noreferrer' }),
    ],
  ],
  [
    'gallery aspect ratio',
    gallery(),
    [
      patch([], { aspectRatio: '1' }),
      patch([0], { aspectRatio: '1' }),
      patch([1], { aspectRatio: '1' }),
    ],
  ],
  [
    'image URL',
    image({ id: 123 }),
    [patch([], { url: 'https://example.test/new.png', sizeSlug: 'large' }, ['id', 'blob'])],
    { url: 'https://example.test/new.png' },
  ],
  [
    'image decorative',
    image({
      caption: 'Caption',
      href: 'https://example.test/',
      linkDestination: 'custom',
      linkTarget: '_blank',
      rel: 'nofollow',
    }),
    [
      patch([], { isDecorative: true, alt: '' }, [
        'caption',
        'href',
        'linkDestination',
        'linkTarget',
        'rel',
      ]),
    ],
    { isDecorative: true },
  ],
  [
    'image lightbox',
    image({ isDecorative: true }),
    [patch([], { lightbox: { enabled: true }, isDecorative: false })],
    { lightbox: { enabled: true } },
  ],
  [
    'image URL from full size',
    image({ id: 123, sizeSlug: 'full' }),
    [patch([], { url: 'https://example.test/new.png', sizeSlug: 'large' }, ['id'])],
    { url: 'https://example.test/new.png' },
  ],
  [
    'image link replaces media link',
    image({ href: 'https://example.test/old.png', linkDestination: 'media' }),
    [patch([], { href: 'https://example.test/elsewhere/', linkDestination: 'custom' })],
    { href: 'https://example.test/elsewhere/' },
  ],
  [
    'image link to its own file',
    image(),
    [patch([], { href: 'https://example.test/old.png', linkDestination: 'media' })],
    { href: 'https://example.test/old.png' },
  ],
  [
    'cover opacity without a color',
    { name: 'core/cover', attributes: { dimRatio: 100, isDark: true } },
    [patch([], { dimRatio: 0, isDark: false })],
    { dimRatio: 0 },
  ],
  [
    'image aspect ratio',
    image(),
    [patch([], { aspectRatio: '1', scale: 'cover' })],
    { aspectRatio: '1' },
  ],
  [
    'image dimensions',
    image({ aspectRatio: '1', scale: 'contain' }),
    [patch([], { width: '200px', height: '100px', scale: 'contain' }, ['aspectRatio'])],
    { width: '200px', height: '100px' },
  ],
  [
    'image link',
    image(),
    [patch([], { href: 'https://example.test/', linkDestination: 'custom' })],
    { href: 'https://example.test/' },
  ],
  [
    'image new tab',
    image({ href: 'https://example.test/', linkDestination: 'custom', rel: 'nofollow' }),
    [patch([], { linkTarget: '_blank', rel: 'nofollow noopener' })],
    { linkTarget: '_blank' },
  ],
  [
    'button new tab',
    {
      name: 'core/button',
      attributes: { text: 'Go', url: 'https://example.test/', rel: 'nofollow' },
    },
    [patch([], { linkTarget: '_blank', rel: 'nofollow noopener' })],
    { linkTarget: '_blank' },
  ],
  [
    'file replace',
    {
      name: 'core/file',
      attributes: {
        id: 123,
        href: 'https://example.test/old.pdf',
        textLinkHref: 'https://example.test/old.pdf',
        fileName: 'Report',
      },
    },
    [
      patch(
        [],
        { href: 'https://example.test/new.pdf', textLinkHref: 'https://example.test/new.pdf' },
        ['id'],
      ),
    ],
    { href: 'https://example.test/new.pdf' },
  ],
  [
    'cover clear',
    {
      name: 'core/cover',
      attributes: {
        url: 'https://example.test/old.png',
        id: 123,
        backgroundType: 'image',
        focalPoint: { x: 0.2, y: 0.3 },
        hasParallax: true,
        isRepeated: true,
        isUserOverlayColor: true,
        customOverlayColor: '#000000',
        dimRatio: 50,
        isDark: true,
      },
    },
    [
      patch([], { isDark: false }, [
        'url',
        'id',
        'backgroundType',
        'focalPoint',
        'hasParallax',
        'isRepeated',
        'useFeaturedImage',
      ]),
    ],
    {},
    ['url'],
  ],
  [
    'cover overlay',
    {
      name: 'core/cover',
      attributes: {
        customOverlayColor: '#000000',
        isDark: true,
        dimRatio: 100,
        isUserOverlayColor: true,
      },
    },
    [patch([], { customOverlayColor: '#ffffff', isUserOverlayColor: true, isDark: false })],
    { customOverlayColor: '#ffffff' },
  ],
  [
    'cover opacity',
    {
      name: 'core/cover',
      attributes: {
        customOverlayColor: '#000000',
        isDark: true,
        dimRatio: 100,
        isUserOverlayColor: true,
      },
    },
    [patch([], { dimRatio: 0, isDark: false })],
    { dimRatio: 0 },
  ],
  [
    'media text featured',
    {
      name: 'core/media-text',
      attributes: {
        mediaUrl: 'https://example.test/old.png',
        mediaId: 123,
        mediaType: 'image',
        mediaAlt: 'Old',
        href: 'https://example.test/',
        imageFill: true,
      },
    },
    [
      patch([], { useFeaturedImage: true, imageFill: false, mediaType: 'image' }, [
        'mediaId',
        'mediaUrl',
        'mediaAlt',
        'mediaLink',
        'linkDestination',
        'linkTarget',
        'linkClass',
        'rel',
        'href',
      ]),
    ],
    { useFeaturedImage: true },
  ],
  [
    'cover featured image',
    {
      name: 'core/cover',
      attributes: {
        url: 'https://example.test/old.png',
        id: 123,
        backgroundType: 'image',
        isDark: true,
        isUserOverlayColor: true,
        customOverlayColor: '#000000',
      },
    },
    [patch([], { useFeaturedImage: true }, ['id', 'url', 'backgroundType'])],
    { useFeaturedImage: true },
  ],
  [
    'cover minimum height',
    {
      name: 'core/cover',
      attributes: {
        customOverlayColor: '#000000',
        isUserOverlayColor: true,
        isDark: true,
        style: { dimensions: { aspectRatio: '16/9' } },
      },
    },
    [patch([], { minHeight: 400 }, ['style'])],
    { minHeight: 400 },
  ],
  [
    'media text remove',
    {
      name: 'core/media-text',
      attributes: {
        mediaUrl: 'https://example.test/old.png',
        mediaId: 123,
        mediaType: 'image',
        mediaAlt: 'Old',
        focalPoint: { x: 0.2, y: 0.3 },
      },
    },
    [
      patch([], { useFeaturedImage: false }, [
        'mediaUrl',
        'mediaId',
        'mediaType',
        'mediaAlt',
        'mediaLink',
        'href',
        'focalPoint',
      ]),
    ],
    {},
    ['mediaUrl'],
  ],
  [
    'navigation link URL',
    {
      name: 'core/navigation',
      inner_blocks: [
        {
          name: 'core/navigation-link',
          attributes: {
            label: 'About',
            url: 'https://example.test/about/',
            id: 123,
            kind: 'post-type',
            type: 'page',
          },
        },
      ],
    },
    [patch([0], { url: 'https://example.test/new/', kind: 'custom', type: 'custom' }, ['id'])],
    { url: 'https://example.test/new/' },
  ],
  [
    'button nested anchor',
    { name: 'core/button', attributes: { text: 'Old' } },
    [patch([], { text: 'New label' })],
    { text: '<a href="https://example.test/">New label</a>' },
  ],
];

let controlSeeds;
let controlNative;

for (const mode of ['full', 'partial']) {
  generated(`${mode} patches match core handler output`, async (t) => {
    const selected = controlCases.flatMap((value, sourceIndex) =>
      t.selected(value[0]) ? [{ value, sourceIndex }] : [],
    );

    if (!selected.length) return;

    if (!controlSeeds)
      await withDocument(site, { content: paragraph('Oracle') }, async ({ tab }) => {
        controlSeeds = await site.evaluate(
          tab,
          `(() => {
        const build = b => wp.blocks.createBlock(b.name, b.attributes, (b.inner_blocks || []).map(build));
        return ${JSON.stringify(controlCases)}.map(([, b]) => wp.blocks.serialize(build(b)));
      })()`,
        );
        controlNative = [];

        for (const [index, [label, , patches]] of controlCases.entries()) {
          await site.evaluate(
            tab,
            `wp.data.dispatch('core/block-editor').resetBlocks(wp.blocks.parse(${JSON.stringify(controlSeeds[index])}))`,
          );
          controlNative[index] = await site.evaluate(
            tab,
            `(() => {
            const store = wp.data.select('core/block-editor');
            const dispatch = wp.data.dispatch('core/block-editor');
            const original = store.getBlocks();
            const root = original[0];
            for (const p of ${JSON.stringify(patches)}) {
              let b = root;
              for (const i of p.path) b = b.innerBlocks[i];
              const attributes = {...p.attributes};
              for (const key of p.unset) attributes[key] = undefined;
              if (${JSON.stringify(label === 'column alignment clears parent')} && p.path.length === 0) attributes.verticalAlignment = null;
              if (${JSON.stringify(label === 'image replace')}) attributes.link = ${JSON.stringify(site.site)} + '/?attachment_id=' + attributes.id;
              dispatch.updateBlockAttributes(b.clientId, attributes);
            }
            if (${JSON.stringify(label === 'accordion heading level')}) dispatch.updateBlockAttributes(root.innerBlocks[0].innerBlocks[1].clientId,{level:4});
            const output = wp.blocks.serialize(wp.blocks.parse(wp.blocks.serialize(store.getBlocks()[0])));
            dispatch.resetBlocks(original);
            return output;
          })()`,
          );
        }
      });
    await withDocument(
      site,
      { content: selected.map(({ sourceIndex }) => controlSeeds[sourceIndex]).join('\n\n') },
      async ({ blockwork, tab, id, before }) => {
        const expected = [];
        await readEveryBlock(blockwork, tab);

        for (const [
          index,
          {
            value: [label, , patches, partial, partialUnset],
            sourceIndex,
          },
        ] of selected.entries()) {
          const leaf = await t.test(label, async () => {
            const native = controlNative[sourceIndex];
            expected[index] = await site.evaluate(
              tab,
              `wp.blocks.serialize(wp.data.select('core/block-editor').getBlocks()[${index}])`,
            );
            const writes = mode === 'full' ? patches : [patches[0]];
            const edits = writes.map((p, i) => ({
              op: 'update',
              path: [index, ...p.path],
              attributes: mode === 'partial' && i === 0 && partial ? partial : p.attributes,
              unset: (mode === 'full' ? p.unset : (partialUnset ?? [])).map((key) => [key]),
            }));
            const result = await blockwork.edit({ edits });

            if (mode === 'partial' && !result.ok) {
              await assertRefused(site, id, before, result);

              return true;
            }

            ok(result);

            // A partial patch reaches core's output by sending what the notes list,
            // and that finishes the coordination: no note asks for anything more. An
            // incomplete note leaves the rest to the agent, which here knows core's writes.
            if (mode === 'partial' && result.notes) {
              const followUp = await blockwork.edit({
                edits: result.notes.some((note) => note.incomplete)
                  ? patches.map((p) => ({
                      op: 'update',
                      path: [index, ...p.path],
                      attributes: p.attributes,
                      unset: p.unset.map((key) => [key]),
                    }))
                  : result.notes.flatMap((note) => note.edits),
              });
              ok(followUp);
              assert.equal(followUp.notes, undefined, JSON.stringify(followUp.notes));
            }

            if (mode === 'full') {
              assert.equal(result.notes, undefined, JSON.stringify(result.notes));
            }

            expected[index] = native;
            const actual = await site.evaluate(
              tab,
              `wp.blocks.serialize(wp.data.select('core/block-editor').getBlocks()[${index}])`,
            );
            assert.equal(actual, native);

            return true;
          });

          await assertCanContinue(blockwork, leaf, label);
        }

        await readEveryBlock(blockwork, tab);
        const saved = await blockwork.save();
        let stored;

        if (saved.persistence === 'unchanged') {
          assert.deepEqual(saved, { ok: true, persistence: 'unchanged', saved: false });
          stored = await storedDocument(site, id);
        } else {
          stored = (await assertSavedCleanly(site, id, before, saved)).after;
        }

        assert.equal(stored.content, expected.join('\n\n'));
      },
    );
  });
}

const cell = (content) => ({ content, tag: 'td' });
const tableSeed = {
  name: 'core/table',
  attributes: {
    head: [
      {
        cells: [
          { ...cell('H1'), tag: 'th' },
          { ...cell('H2'), tag: 'th' },
        ],
      },
    ],
    body: [{ cells: [cell('A'), cell('B')] }, { cells: [cell('C'), cell('D')] }],
    foot: [{ cells: [cell('F1'), cell('F2')] }],
  },
};
const tableCases = [
  [
    'alignment',
    Object.fromEntries(
      ['head', 'body', 'foot'].map((section) => [
        section,
        tableSeed.attributes[section].map((row) => ({
          cells: row.cells.map((item, index) => (index ? item : { ...item, align: 'center' })),
        })),
      ]),
    ),
  ],
  ['remove header', { head: [] }],
  ['remove footer', { foot: [] }],
  ['insert row', { body: [...tableSeed.attributes.body, { cells: [cell(''), cell('')] }] }],
  ['delete row', { body: tableSeed.attributes.body.slice(1) }],
  [
    'insert column',
    Object.fromEntries(
      ['head', 'body', 'foot'].map((section) => [
        section,
        tableSeed.attributes[section].map((row) => ({
          cells: [{ content: '', tag: section === 'head' ? 'th' : 'td' }, ...row.cells],
        })),
      ]),
    ),
  ],
  [
    'delete column',
    Object.fromEntries(
      ['head', 'body', 'foot'].map((section) => [
        section,
        tableSeed.attributes[section].map((row) => ({ cells: row.cells.slice(1) })),
      ]),
    ),
  ],
  [
    'add header',
    {
      head: [
        {
          cells: [
            { content: '', tag: 'th' },
            { content: '', tag: 'th' },
          ],
        },
      ],
    },
  ],
  ['add footer', { foot: [{ cells: [cell(''), cell('')] }] }],
];

for (const [label, attributes] of tableCases) {
  const partial = { [Object.keys(attributes)[0]]: Object.values(attributes)[0] };
  const seed = structuredClone(tableSeed);

  if (label === 'add header') seed.attributes.head = [];

  if (label === 'add footer') seed.attributes.foot = [];
  controlCases.push(['table ' + label, seed, [patch([], attributes)], partial]);
}

generated('native registration availability is explicit', async (t) => {
  await withDocument(site, { content: paragraph('Availability') }, async ({ tab }) => {
    for (const name of [
      'core/tabs',
      'core/tab-panel',
      'core/tab-panels',
      'core/tab-list',
      'core/footnotes',
    ]) {
      await t.test(name, async (subtest) => {
        const registered = await site.evaluate(
          tab,
          `!!wp.blocks.getBlockType(${JSON.stringify(name)})`,
        );

        if (!registered) subtest.skip('Native block is not registered in this WordPress fixture.');
        else assert.equal(registered, true);
      });
    }
  });
});

async function addMediaCases() {
  const media = await seedImage(site, {
    name: 'native-control-image',
    alt: 'Replacement description',
    caption: 'Replacement caption',
  });
  const large = `${media.url.slice(0, media.url.lastIndexOf('/') + 1)}${media.sizes.large.file}`;
  const cover = controlCases.find(([label]) => label === 'cover replace');
  cover[1].attributes.sizeSlug = 'full';
  cover[2] = [
    patch(
      [],
      {
        id: media.id,
        url: media.url,
        alt: media.alt,
        backgroundType: 'image',
        sizeSlug: 'full',
        dimRatio: 100,
        isDark: true,
        isUserOverlayColor: true,
      },
      ['focalPoint', 'useFeaturedImage'],
    ),
  ];
  cover[3] = { id: media.id, url: media.url };
  const thumb = `${media.url.slice(0, media.url.lastIndexOf('/') + 1)}${media.sizes.thumbnail.file}`;
  controlCases.push(
    [
      'image replace',
      image({
        id: 123,
        sizeSlug: 'full',
        href: 'https://example.test/old.png',
        linkDestination: 'media',
      }),
      [
        patch(
          [],
          {
            id: media.id,
            url: media.url,
            alt: media.alt,
            caption: 'Replacement caption',
            sizeSlug: 'full',
            linkDestination: 'media',
            href: media.url,
          },
          ['blob'],
        ),
      ],
      { id: media.id, url: media.url },
    ],
    [
      'image resolution',
      image({ id: media.id, url: media.url, sizeSlug: 'full' }),
      [patch([], { url: thumb, sizeSlug: 'thumbnail' })],
      { sizeSlug: 'thumbnail' },
    ],
    [
      'gallery resolution',
      {
        ...gallery(),
        attributes: { linkTo: 'media', sizeSlug: 'full' },
        inner_blocks: [
          image({
            id: media.id,
            url: media.url,
            sizeSlug: 'full',
            width: '200px',
            height: '100px',
          }),
          image({ id: media.id, url: media.url }),
        ],
      },
      [
        patch([], { sizeSlug: 'thumbnail' }),
        patch([0], { url: thumb, sizeSlug: 'thumbnail' }, ['width', 'height']),
        patch([1], { url: thumb, sizeSlug: 'thumbnail' }, ['width', 'height']),
      ],
    ],
    [
      'media text replace',
      {
        name: 'core/media-text',
        attributes: {
          mediaUrl: 'https://example.test/old.png',
          mediaType: 'image',
          mediaId: 123,
          linkDestination: 'media',
          href: 'https://example.test/old.png',
          focalPoint: { x: 0.2, y: 0.3 },
        },
      },
      [
        patch(
          [],
          {
            mediaId: media.id,
            mediaUrl: large,
            mediaAlt: media.alt,
            mediaType: 'image',
            mediaLink: `${site.site}/?attachment_id=${media.id}`,
            href: media.url,
            linkDestination: 'media',
            useFeaturedImage: false,
          },
          ['focalPoint'],
        ),
      ],
      { mediaId: media.id, mediaUrl: media.url },
    ],
    [
      'media text resolution',
      {
        name: 'core/media-text',
        attributes: {
          mediaId: media.id,
          mediaUrl: media.url,
          mediaSizeSlug: 'full',
          mediaType: 'image',
        },
      },
      [patch([], { mediaUrl: thumb, mediaSizeSlug: 'thumbnail' })],
      { mediaSizeSlug: 'thumbnail' },
    ],
  );
}

generated('Cover insert attribute combinations preserve native serialization', async (t) => {
  const selected = [
    {},
    { customOverlayColor: '#123456' },
    { customOverlayColor: '#123456', isUserOverlayColor: true },
    { allowedVideoProviders: ['youtube'] },
  ]
    .filter((attributes) => t.selected(JSON.stringify(attributes)))
    .sort(
      (a, b) =>
        Number(Boolean(a.customOverlayColor && a.isUserOverlayColor === undefined)) -
        Number(Boolean(b.customOverlayColor && b.isUserOverlayColor === undefined)),
    );

  if (!selected.length) return;
  await withDocument(
    site,
    { content: paragraph('Anchor') },
    async ({ blockwork, tab, id, before }) => {
      let changed = false;

      for (const attributes of selected) {
        if (
          changed &&
          attributes.customOverlayColor &&
          attributes.isUserOverlayColor === undefined
        ) {
          await readEveryBlock(blockwork, tab);
          await assertSavedCleanly(site, id, before, await blockwork.save());
        }

        const leaf = await t.test(JSON.stringify(attributes), async () => {
          const result = await blockwork.edit({
            edits: [
              {
                op: 'insert',
                block: {
                  name: 'core/cover',
                  attributes,
                  inner_blocks: [
                    { name: 'core/paragraph', attributes: { content: 'Cover child' } },
                  ],
                },
              },
            ],
          });

          // The native control writes isUserOverlayColor with a color, so a color alone refuses, naming it.
          if (attributes.customOverlayColor && attributes.isUserOverlayColor === undefined) {
            assert.equal(result.error, 'serialization_mismatch', JSON.stringify(result));
            assert.match(JSON.stringify(result.diagnostics), /isUserOverlayColor/);

            return false;
          } else {
            ok(result);

            return true;
          }
        });

        if (!leaf.completed || !leaf.value) return;
        changed = true;
      }

      await readEveryBlock(blockwork, tab);
      await assertSavedCleanly(site, id, before, await blockwork.save());
    },
  );
});

test('Query inherited settings use the native posts-per-page value', async () => {
  await withDocument(
    site,
    { content: paragraph('Anchor') },
    async ({ blockwork, tab, id, before }) => {
      const perPage = await site.php("echo wp_json_encode((int) get_option('posts_per_page'));");
      ok(
        await blockwork.edit({
          edits: [
            {
              op: 'insert',
              block: {
                name: 'core/query',
                attributes: {
                  queryId: 42,
                  query: { inherit: true, perPage, excludeCurrent: null },
                },
                inner_blocks: [
                  { name: 'core/post-template', inner_blocks: [{ name: 'core/post-title' }] },
                ],
              },
            },
          ],
        }),
      );
      const { after: persisted } = await assertSavedCleanly(
        site,
        id,
        before,
        await blockwork.save(),
      );
      const tree = (await storedTree(site, id)).filter((item) => item.blockName);
      assert.equal(tree[1].attrs.query.perPage, perPage);
      assert.equal(tree[1].attrs.query.excludeCurrent, null);
      assert.equal(Number.isFinite(tree[1].attrs.queryId), true);
      const native = await nativeMarkup(
        tab,
        `const root=original[1];dispatch.updateBlockAttributes(root.clientId,{query:{...root.attributes.query,inherit:true,perPage:7,excludeCurrent:true}});`,
        `store.getBlock(original[1].clientId).attributes.query.perPage===${perPage} && store.getBlock(original[1].clientId).attributes.query.excludeCurrent===null`,
      );
      assert.equal(native, persisted.content);
      ok(await blockwork.read({ blocks: 'all' }));
    },
  );
});

test(
  'Query partial inherited settings normalize safely',
  { todo: 'finding: query-inherited-normalization' },
  async () => {
    const perPage = await site.php("echo wp_json_encode((int) get_option('posts_per_page')); ");
    let seed;
    await withDocument(site, { content: paragraph('Oracle') }, async ({ tab }) => {
      seed = await nativeMarkup(
        tab,
        "dispatch.resetBlocks([wp.blocks.createBlock('core/query',{queryId:42,query:{inherit:true,perPage:" +
          perPage +
          ",excludeCurrent:null}},[wp.blocks.createBlock('core/post-template',{},[wp.blocks.createBlock('core/post-title')])])]);",
        'store.getBlocks()[0].attributes.query.perPage===' +
          perPage +
          ' && store.getBlocks()[0].attributes.query.excludeCurrent===null',
      );
    });
    await withDocument(site, { content: seed }, async ({ blockwork, tab, id, before }) => {
      const native = await nativeMarkup(
        tab,
        'const root=original[0];dispatch.updateBlockAttributes(root.clientId,{query:{...root.attributes.query,inherit:true,perPage:7,excludeCurrent:true}});',
        'store.getBlock(original[0].clientId).attributes.query.perPage===' +
          perPage +
          ' && store.getBlock(original[0].clientId).attributes.query.excludeCurrent===null',
      );
      assert.equal(native, before.content);
      ok(await blockwork.read({ blocks: 'all' }));
      const result = await blockwork.edit({
        edits: [
          {
            op: 'update',
            path: [0],
            attributes: { query: { inherit: true, perPage: 7, excludeCurrent: true } },
          },
        ],
      });

      ok(result);
      const { after: stored } = await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal(stored.content, native);
      const current = (await storedTree(site, id)).filter((item) => item.blockName);
      assert.equal(current[0].attrs.query.perPage, perPage);
      assert.equal(current[0].attrs.query.excludeCurrent, null);
    });
  },
);

for (const mode of ['full', 'partial']) {
  generated(`Columns count ${mode} redistributes explicit widths`, async (t) => {
    const selected = ['add', 'remove'].filter((action) => t.selected(action));

    if (!selected.length) return;
    const seeds = selected.map((action) => {
      const widths = action === 'add' ? ['50%', '50%'] : ['33.34%', '33.34%', '33.33%'];
      const seed = columns(
        ...widths.map((width, index) =>
          block(
            'column',
            { width },
            `<div class="wp-block-column" style="flex-basis:${width}">${paragraph(['One', 'Two', 'Three'][index])}</div>`,
          ),
        ),
      );

      return seed;
    });
    await withDocument(
      site,
      { content: seeds.join('\n\n') },
      async ({ blockwork, tab, id, before }) => {
        for (const [index, action] of selected.entries()) {
          const leaf = await t.test(action, async () => {
            const editWithNotes = async (edits) => {
              const result = await blockwork.edit({ edits });
              ok(result);

              if (mode === 'full') {
                assert.equal(result.notes, undefined, JSON.stringify(result.notes));
              } else {
                ok(await blockwork.edit({ edits: result.notes.flatMap((note) => note.edits) }));
              }
            };

            if (action === 'add') {
              const nativeAdd = await nativeMarkup(
                tab,
                `const parent=original[${index}];dispatch.replaceInnerBlocks(parent.clientId,[...parent.innerBlocks.map(b=>({...b,attributes:{...b.attributes,width:'33.34%'}})),wp.blocks.createBlock('core/column',{width:'33.33%'})],false);`,
              );
              {
                const edits = [
                  {
                    op: 'insert',
                    parent: [index],
                    block: { name: 'core/column', attributes: { width: '33.33%' } },
                  },
                ];

                if (mode === 'full')
                  edits.push(
                    { op: 'update', path: [index, 0], attributes: { width: '33.34%' } },
                    { op: 'update', path: [index, 1], attributes: { width: '33.34%' } },
                  );
                await editWithNotes(edits);
                const widths = await site.evaluate(
                  tab,
                  `wp.data.select('core/block-editor').getBlocks()[${index}].innerBlocks.map(b => b.attributes.width)`,
                );
                assert.deepEqual(widths, ['33.34%', '33.34%', '33.33%']);
                assert.equal(
                  await site.evaluate(
                    tab,
                    "wp.blocks.serialize(wp.data.select('core/block-editor').getBlocks())",
                  ),
                  nativeAdd,
                );
              }
            } else {
              const nativeRemove = await nativeMarkup(
                tab,
                `const parent=original[${index}];dispatch.replaceInnerBlocks(parent.clientId,parent.innerBlocks.slice(0,2).map(b=>({...b,attributes:{...b.attributes,width:'50%'}})),false);`,
              );
              {
                const edits = [{ op: 'remove', path: [index, 2] }];

                if (mode === 'full')
                  edits.push(
                    { op: 'update', path: [index, 0], attributes: { width: '50%' } },
                    { op: 'update', path: [index, 1], attributes: { width: '50%' } },
                  );
                await editWithNotes(edits);
                const widths = await site.evaluate(
                  tab,
                  `wp.data.select('core/block-editor').getBlocks()[${index}].innerBlocks.map(b => b.attributes.width)`,
                );
                assert.deepEqual(widths, ['50%', '50%']);
                assert.equal(
                  await site.evaluate(
                    tab,
                    "wp.blocks.serialize(wp.data.select('core/block-editor').getBlocks())",
                  ),
                  nativeRemove,
                );
              }
            }

            return true;
          });

          if (!leaf.completed || !leaf.value) return;
        }

        await assertSavedCleanly(site, id, before, await blockwork.save());
      },
    );
  });
}

test('Accordion add item creates a heading at the parent level and a panel', async () => {
  await withDocument(
    site,
    { content: paragraph('Anchor') },
    async ({ blockwork, tab, id, before }) => {
      ok(
        await blockwork.edit({
          edits: [
            {
              op: 'insert',
              block: {
                name: 'core/accordion',
                attributes: { headingLevel: 4 },
                inner_blocks: [
                  {
                    name: 'core/accordion-item',
                    inner_blocks: [
                      { name: 'core/accordion-heading', attributes: { level: 4, title: 'First' } },
                      { name: 'core/accordion-panel' },
                    ],
                  },
                ],
              },
            },
          ],
        }),
      );
      const native = await nativeMarkup(
        tab,
        "const panel=wp.blocks.createBlock('core/accordion-panel');const item=wp.blocks.createBlock('core/accordion-item',{},[wp.blocks.createBlock('core/accordion-heading',{level:4}),panel]);dispatch.insertBlock(item,undefined,original[1].clientId);",
        'store.getBlock(panel.clientId).innerBlocks.length>0',
      );
      ok(await blockwork.read({ blocks: 'all' }));
      ok(
        await blockwork.edit({
          edits: [
            {
              op: 'insert',
              parent: [1],
              block: {
                name: 'core/accordion-item',
                inner_blocks: [
                  { name: 'core/accordion-heading', attributes: { level: 4 } },
                  { name: 'core/accordion-panel' },
                ],
              },
            },
          ],
        }),
      );
      await assertSavedCleanly(site, id, before, await blockwork.save());
      const tree = (await storedTree(site, id)).filter((item) => item.blockName);
      assert.equal(
        await site.evaluate(
          tab,
          "wp.blocks.serialize(wp.data.select('core/block-editor').getBlocks())",
        ),
        native,
      );
      assert.equal(tree[1].innerBlocks.length, 2);
      assert.equal(tree[1].innerBlocks[1].innerBlocks[0].attrs.level, 4);
      assert.equal(tree[1].innerBlocks[1].innerBlocks[1].blockName, 'core/accordion-panel');
    },
  );
});

test('Accordion partial add inherits the chosen heading level', async () => {
  let seed;
  await withDocument(site, { content: paragraph('Oracle') }, async ({ tab }) => {
    seed = await nativeMarkup(
      tab,
      "dispatch.resetBlocks([wp.blocks.createBlock('core/paragraph',{content:'Anchor'}),wp.blocks.createBlock('core/accordion',{headingLevel:4},['First','Second'].map(title=>wp.blocks.createBlock('core/accordion-item',{},[wp.blocks.createBlock('core/accordion-heading',{level:4,title}),wp.blocks.createBlock('core/accordion-panel')])))]);",
      'store.getBlocks()[1].innerBlocks.every(item=>item.innerBlocks[1].innerBlocks.length>0)',
    );
  });
  await withDocument(site, { content: seed }, async ({ blockwork, tab, id, before }) => {
    const native = await nativeMarkup(
      tab,
      "const panel=wp.blocks.createBlock('core/accordion-panel');dispatch.insertBlock(wp.blocks.createBlock('core/accordion-item',{},[wp.blocks.createBlock('core/accordion-heading',{level:4}),panel]),undefined,original[1].clientId);",
      'store.getBlock(panel.clientId).innerBlocks.length>0',
    );
    ok(await blockwork.read({ blocks: 'all' }));
    const added = await blockwork.edit({
      edits: [{ op: 'insert', parent: [1], block: { name: 'core/accordion-item' } }],
    });
    ok(added);
    ok(await blockwork.edit({ edits: added.notes.flatMap((note) => note.edits) }));
    const { after: stored } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(stored.content, native);
    const current = (await storedTree(site, id)).filter((item) => item.blockName);
    assert.equal(current[1].innerBlocks[2].innerBlocks[0].attrs.level, 4);
    assert.equal(
      await site.evaluate(
        tab,
        "wp.blocks.serialize(wp.data.select('core/block-editor').getBlocks())",
      ),
      native,
    );
  });
});

controlCases.push(
  [
    'cover replace',
    {
      name: 'core/cover',
      attributes: {
        url: 'https://example.test/old.png',
        id: 123,
        backgroundType: 'image',
        dimRatio: 100,
        isDark: true,
        isUserOverlayColor: true,
        customOverlayColor: '#000000',
        focalPoint: { x: 0.2, y: 0.3 },
      },
    },
    [
      patch(
        [],
        {
          url: 'https://example.test/new.png',
          backgroundType: 'image',
          sizeSlug: 'full',
          dimRatio: 100,
          isDark: true,
          isUserOverlayColor: true,
        },
        ['id', 'focalPoint', 'useFeaturedImage'],
      ),
    ],
    { url: 'https://example.test/new.png', sizeSlug: 'full' },
  ],
  [
    'cover embedded video',
    {
      name: 'core/cover',
      attributes: {
        url: 'https://example.test/old.png',
        id: 123,
        backgroundType: 'image',
        dimRatio: 100,
        isDark: true,
        isUserOverlayColor: true,
        customOverlayColor: '#000000',
        focalPoint: { x: 0.2, y: 0.3 },
        hasParallax: true,
        isRepeated: true,
      },
    },
    [
      patch(
        [],
        {
          url: 'https://www.youtube.com/watch?v=example',
          backgroundType: 'embed-video',
          dimRatio: 100,
        },
        ['id', 'focalPoint', 'hasParallax', 'isRepeated', 'useFeaturedImage'],
      ),
    ],
    { url: 'https://www.youtube.com/watch?v=example', backgroundType: 'embed-video' },
  ],
);

test('notes change nothing and only follow the edit that changes a control', async () => {
  const seed = block(
    'video',
    undefined,
    '<figure class="wp-block-video"><video autoplay src="https://example.test/video.mp4"></video></figure>',
  );
  await withDocument(site, { content: seed }, async ({ blockwork, tab }) => {
    const update = async (attributes) => {
      const result = await blockwork.edit({ edits: [{ op: 'update', path: [0], attributes }] });
      ok(result);

      return result;
    };

    assert.equal((await update({ caption: 'Unrelated' })).notes, undefined);
    assert.equal((await update({ autoplay: false })).notes, undefined);
    const { notes } = await update({ autoplay: true });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].control, 'video_autoplay');
    assert.deepEqual(notes[0].edits[0].attributes, { muted: true, playsInline: true });
    assert.doesNotMatch(
      await site.evaluate(
        tab,
        "wp.blocks.serialize(wp.data.select('core/block-editor').getBlocks())",
      ),
      /muted/,
    );
  });
});

test('a copied block keeps its choices and a locked block is only reported', async () => {
  const seed = columns(
    column(paragraph('One')),
    block('column', { lock: { edit: true } }, '<div class="wp-block-column"></div>'),
  );
  await withDocument(site, { content: seed }, async ({ blockwork }) => {
    const copied = await blockwork.edit({
      edits: [
        {
          op: 'insert',
          markup:
            '<!-- wp:gallery {"linkTo":"none"} --><figure class="wp-block-gallery has-nested-images columns-default is-cropped"><!-- wp:image {"linkDestination":"custom"} --><figure class="wp-block-image"><a href="https://example.test/"><img src="https://example.test/a.png" alt=""/></a></figure><!-- /wp:image --></figure><!-- /wp:gallery -->',
        },
      ],
    });
    ok(copied);
    assert.equal(copied.notes, undefined, JSON.stringify(copied.notes));
    const aligned = await blockwork.edit({
      edits: [{ op: 'update', path: [0], attributes: { verticalAlignment: 'center' } }],
    });
    ok(aligned);
    const [note] = aligned.notes;
    assert.equal(note.incomplete, true);
    assert.equal(note.edits.length, 1);
    assert.equal(note.restricted.length, 1);
    assert.equal(note.restricted[0].reason, 'block_locked');
  });
});

test('a content-only block still gets the writes its mode allows', async () => {
  const seed = block(
    'group',
    { templateLock: 'contentOnly' },
    '<div class="wp-block-group"><!-- wp:buttons --><div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="https://example.test/">Go</a></div><!-- /wp:button --></div><!-- /wp:buttons --></div>',
  );
  await withDocument(site, { content: seed }, async ({ blockwork }) => {
    ok(await blockwork.read({ blocks: 'all' }));
    const opened = await blockwork.edit({
      edits: [{ op: 'update', path: [0, 0, 0], attributes: { linkTarget: '_blank' } }],
    });
    ok(opened);
    const [note] = opened.notes;
    assert.equal(note.control, 'button_new_tab');
    assert.equal(note.restricted, undefined);
    assert.equal(note.edits[0].attributes.rel, 'noopener');
    ok(await blockwork.edit({ edits: note.edits }));
  });
});

test('Footnote body changes write registered post meta', async () => {
  const seed = doc(
    paragraph(
      'Reference <sup data-fn="note_a" class="fn"><a href="#note_a" id="note_a-link">1</a></sup>',
    ),
    block('footnotes'),
  );
  const notes = [{ id: 'note_a', content: 'Original note' }];
  await withDocument(
    site,
    { type: 'post', content: seed, meta: { footnotes: JSON.stringify(notes) } },
    async ({ blockwork, tab, id, before }) => {
      const native = await site.evaluate(
        tab,
        `(async()=>{
      const store=wp.data.select('core/editor');const core=wp.data.dispatch('core');
      const meta=store.getEditedPostAttribute('meta');const type=store.getCurrentPostType();const id=store.getCurrentPostId();
      try {
        await core.editEntityRecord('postType',type,id,{meta:{...meta,footnotes:JSON.stringify(JSON.parse(meta.footnotes).map(note=>note.id==='note_a'?{content:'Changed note',id:note.id}:note))}});
        return JSON.parse(store.getEditedPostAttribute('meta').footnotes);
      } finally {await core.editEntityRecord('postType',type,id,{meta});}
    })()`,
      );
      ok(await blockwork.read({ blocks: 'all' }));
      ok(
        await blockwork.edit({
          settings: {
            meta: { footnotes: JSON.stringify([{ id: 'note_a', content: 'Changed note' }]) },
          },
        }),
      );
      const { after: stored } = await assertSavedCleanly(site, id, before, await blockwork.save(), {
        allow: ['meta'],
      });
      assert.equal(stored.content, seed);
      assert.deepEqual(JSON.parse(stored.meta.footnotes[0]), native);
      assert.match((await frontEnd(site, id)).html, /Changed note/);
    },
  );
});

generated(
  'Tabs full and partial writes coordinate panels, labels and local state',
  { findings: ['tabs-label-sync-outside-plan'] },
  async (t) => {
    const optionsFor = (mode) => ({
      todo: mode === 'full' ? undefined : 'finding: tabs-label-sync-outside-plan',
    });
    const actions = ['label', 'add', 'remove', 'move'].filter((action) =>
      ['full', 'partial'].some((mode) => t.selected(mode + ' ' + action, optionsFor(mode))),
    );
    const pairs = ['full', 'partial'].flatMap((mode) =>
      actions.flatMap((action) =>
        t.selected(mode + ' ' + action, optionsFor(mode)) ? [{ mode, action }] : [],
      ),
    );

    if (!actions.length) return;
    let seed;
    await withDocument(site, { content: paragraph('Oracle') }, async ({ tab }) => {
      seed = await site.evaluate(
        tab,
        `(() => {
      if (!wp.blocks.getBlockType('core/tabs')) return null;
      return wp.blocks.serialize(wp.blocks.createBlock('core/tabs',{},[
        wp.blocks.createBlock('core/tab-list',{tabs:[{label:'First'},{label:'Second'},{label:'Third'},{label:'Fourth'}]}),
        wp.blocks.createBlock('core/tab-panels',{},['First','Second','Third','Fourth'].map(label=>wp.blocks.createBlock('core/tab-panel',{label},[wp.blocks.createBlock('core/paragraph',{content:label})])))
      ]));
    })()`,
      );
    });

    if (!seed) {
      for (const mode of ['full', 'partial'])
        for (const action of actions)
          await t.test(mode + ' ' + action, optionsFor(mode), (subtest) =>
            subtest.skip('Tabs are not registered in this WordPress fixture.'),
          );

      return;
    }

    // These finding cases can leave partial state, so each owns its editor.
    for (const { mode, action } of pairs) {
      await t.test(mode + ' ' + action, optionsFor(mode), async (subtest) => {
        await withDocument(site, { content: seed }, async ({ blockwork, tab, id, before }) => {
          const index = 0;
          const savedBefore = before;

          if (!seed) {
            subtest.skip('Tabs are not registered in this WordPress fixture.');

            return;
          }

          ok(await blockwork.read({ blocks: 'all' }));
          const labels = await site.evaluate(
            tab,
            `wp.data.select('core/block-editor').getBlocks()[${index}].innerBlocks[1].innerBlocks.map(b=>b.attributes.label)`,
          );
          const expected = [...labels];
          let edits;

          if (action === 'label') {
            expected[0] = mode + ' renamed';
            edits = [{ op: 'update', path: [index, 1, 0], attributes: { label: expected[0] } }];
          } else if (action === 'add') {
            expected.push('');
            edits = [
              { op: 'insert', parent: [index, 1], block: mode === 'full' ? { name: 'core/tab-panel', attributes: { label: '' }, inner_blocks: [{ name: 'core/paragraph' }] } : { name: 'core/tab-panel' } },
              {
                op: 'update',
                path: [index],
                attributes: { editorActiveTabIndex: expected.length - 1 },
              },
            ];
          } else if (action === 'remove') {
            expected.pop();
            edits = [
              { op: 'remove', path: [index, 1, labels.length - 1] },
              {
                op: 'update',
                path: [index],
                attributes: { editorActiveTabIndex: expected.length - 1 },
              },
            ];
          } else {
            expected.splice(1, 0, expected.shift());
            edits = [
              { op: 'move', path: [index, 1, 0], parent: [index, 1], index: 1 },
              { op: 'update', path: [index], attributes: { editorActiveTabIndex: 1 } },
            ];
          }

          const nativeAction =
            action === 'label'
              ? `dispatch.updateBlockAttributes(panels.innerBlocks[0].clientId,{label:${JSON.stringify(expected[0])}});`
              : action === 'add'
                ? `dispatch.insertBlock(wp.blocks.createBlock('core/tab-panel'),panels.innerBlocks.length,panels.clientId,false);dispatch.__unstableMarkNextChangeAsNotPersistent();dispatch.updateBlockAttributes(root.clientId,{editorActiveTabIndex:${expected.length - 1}});`
                : action === 'remove'
                  ? `dispatch.__unstableMarkNextChangeAsNotPersistent();dispatch.updateBlockAttributes(root.clientId,{editorActiveTabIndex:${expected.length - 1}});dispatch.removeBlock(panels.innerBlocks.at(-1).clientId,false);`
                  : 'dispatch.__unstableMarkNextChangeAsNotPersistent();dispatch.updateBlockAttributes(root.clientId,{editorActiveTabIndex:1});dispatch.moveBlocksToPosition([panels.innerBlocks[0].clientId],panels.clientId,panels.clientId,1);';
          const native = await nativeMarkup(
            tab,
            `const root=original[${index}];const panels=root.innerBlocks[1];${nativeAction}`,
            `JSON.stringify(store.getBlock(original[${index}].innerBlocks[0].clientId).attributes.tabs)===${JSON.stringify(JSON.stringify(expected.map((label) => ({ label }))))} && store.getBlock(original[${index}].innerBlocks[1].clientId).innerBlocks.every(b=>b.innerBlocks.length>0)`,
          );
          ok(await blockwork.read({ blocks: 'all' }));

          if (mode === 'full')
            edits.push({
              op: 'update',
              path: [index, 0],
              attributes: { tabs: expected.map((label) => ({ label })) },
            });
          const result = await blockwork.edit({ edits });

          if (!result.ok) await assertRefused(site, id, savedBefore, result);
          ok(result);
          const actual = await site.evaluate(
            tab,
            `(() => {const root=wp.data.select('core/block-editor').getBlocks()[${index}];return {labels:root.innerBlocks[1].innerBlocks.map(b=>b.attributes.label),tabs:root.innerBlocks[0].attributes.tabs};})()`,
          );
          assert.deepEqual(actual.labels, expected);
          assert.deepEqual(
            actual.tabs,
            expected.map((label) => ({ label })),
          );
          assert.equal(
            await site.evaluate(
              tab,
              "wp.blocks.serialize(wp.data.select('core/block-editor').getBlocks())",
            ),
            native,
          );

          await readEveryBlock(blockwork, tab);
          const { after: stored } = await assertSavedCleanly(
            site,
            id,
            before,
            await blockwork.save(),
          );
          assert.equal(stored.content, native);
        });
      });
    }
  },
);
test(
  'Footnote insertion coordinates rich text, Footnotes block and body meta',
  async () => {
    await withDocument(
      site,
      { type: 'post', content: paragraph('Reference') },
      async ({ blockwork, tab, id, before }) => {
        const reference =
          'Reference <sup data-fn="note_a" class="fn"><a href="#note_a" id="note_a-link">1</a></sup>';
        const meta = await site.evaluate(
          tab,
          "wp.data.select('core/editor').getEditedPostAttribute('meta')",
        );
        let native;

        try {
          native = await nativeMarkup(
            tab,
            `
        dispatch.updateBlockAttributes(original[0].clientId,{content:${JSON.stringify(reference)}});
        dispatch.insertBlock(wp.blocks.createBlock('core/footnotes'),undefined,undefined);
        await wp.data.dispatch('core').editEntityRecord('postType','post',${id},{meta:{...wp.data.select('core/editor').getEditedPostAttribute('meta'),footnotes:JSON.stringify([{id:'note_a',content:'Inserted note'}])}});
      `,
            "JSON.parse(wp.data.select('core/editor').getEditedPostAttribute('meta').footnotes || '[]').some(note=>note.id==='note_a' && note.content==='Inserted note')",
          );
        } finally {
          await site.evaluate(
            tab,
            `wp.data.dispatch('core').editEntityRecord('postType','post',${id},{meta:${JSON.stringify(meta)}})`,
          );
        }

        ok(await blockwork.read({ blocks: 'all', settings: true }));
        const snapshot = () => site.evaluate(tab, `(() => {
          const editor = wp.data.select('core/editor');
          const store = wp.data.select('core/block-editor');
          return JSON.parse(JSON.stringify({ blocks: store.getBlocks(),
            meta: editor.getEditedPostAttribute('meta'), dirty: editor.isEditedPostDirty(),
            pending_keys: Object.keys(wp.data.select('core').getEntityRecordNonTransientEdits('postType', editor.getCurrentPostType(), editor.getCurrentPostId())).sort(),
            selection: [store.getSelectionStart(), store.getSelectionEnd(), store.getSelectedBlocksInitialCaretPosition()] }));
        })()`);
        const initial = await snapshot();
        const request = {
          edits: [
            { op: 'update', path: [0], attributes: { content: reference } },
            { op: 'insert', block: { name: 'core/footnotes' } },
          ],
          settings: { meta: { footnotes: JSON.stringify([{ id: 'note_a', content: 'Inserted note' }]) } },
        };
        ok(await blockwork.edit(request));
        const applied = await snapshot();
        assert.equal(applied.blocks[0].clientId, initial.blocks[0].clientId);
        assert.equal(applied.blocks[0].attributes.content, reference);
        assert.deepEqual(applied.meta, { ...initial.meta, ...request.settings.meta });
        assert.deepEqual(applied.selection, initial.selection);
        ok(await blockwork.revert());
        assert.deepEqual(await snapshot(), initial);
        ok(
          await blockwork.edit({
            edits: [
              { op: 'update', path: [0], attributes: { content: reference } },
              { op: 'insert', block: { name: 'core/footnotes' } },
            ],
            settings: {
              meta: { footnotes: JSON.stringify([{ id: 'note_a', content: 'Inserted note' }]) },
            },
          }),
        );
        const { after: stored } = await assertSavedCleanly(
          site,
          id,
          before,
          await blockwork.save(),
          { allow: ['meta'] },
        );
        assert.equal(stored.content, native);
        const page = await frontEnd(site, id);
        assert.match(page.html, /Inserted note/);
        assert.match(page.html, /note_a-link/);
      },
    );
  },
);

test(
  'Footnote insertion preserves a heading, nested content and selection',
  async () => {
    const content = await serializeNatively(site, `[wp.blocks.createBlock('core/heading', {content:'Unchanged heading'}), wp.blocks.createBlock('core/paragraph', {content:'Reference'}), wp.blocks.createBlock('core/group', {}, [wp.blocks.createBlock('core/paragraph', {content:'Unchanged nested text'})])]`);
    await withDocument(site, { type: 'post', content }, async ({ blockwork, tab, id, before }) => {
      const selection = await site.evaluate(tab, `(() => {
        const store = wp.data.select('core/block-editor');
        const clientId = store.getBlocks()[2].innerBlocks[0].clientId;
        const range = {clientId, attributeKey:'content', offset:3};
        wp.data.dispatch('core/block-editor').resetSelection(range, range, 0);
        return {start:store.getSelectionStart(), end:store.getSelectionEnd(), position:store.getSelectedBlocksInitialCaretPosition()};
      })()`);
      const tree = await storedTree(site, id);
      ok(await blockwork.read({ blocks: 'all', settings: true }));
      const result = await blockwork.edit({
        edits: [
          { op: 'update', path: [1], attributes: { content: 'Reference <sup data-fn="note_context" class="fn"><a href="#note_context" id="note_context-link">1</a></sup>' } },
          { op: 'insert', block: { name: 'core/footnotes' } },
        ],
        settings: { meta: { footnotes: JSON.stringify([{ id: 'note_context', content: 'Inserted note' }]) } },
      });
      ok(result);
      const current = await site.evaluate(tab, `(() => {
        const store = wp.data.select('core/block-editor');
        return {start:store.getSelectionStart(), end:store.getSelectionEnd(), position:store.getSelectedBlocksInitialCaretPosition()};
      })()`);
      assert.deepEqual(current, selection);
      await assertSavedCleanly(site, id, before, await blockwork.save({ save_all_pending: true }), { allow: ['meta'] });
      assert.deepEqual(changedPaths(tree, await storedTree(site, id)), ['1', '3']);
    }, { workflow: 'attached' });
  },
);

run();
