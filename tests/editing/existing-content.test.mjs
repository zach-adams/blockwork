import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';

import { block, doc, group, olderAccordion, paragraph } from './blocks.mjs';
import {
  assertRefused,
  frontEnd,
  assertSavedCleanly,
  startEditingSite,
  storedDocument,
  storedTree,
  withDocument,
  seedDocument,
  waitFor,
  serializeNatively,
  seedImage,
} from './harness.mjs';

let site;
const { after, before, test, run } = editingTests(import.meta.url);

before(async () => {
  site = await startEditingSite();
});
after(() => site?.[Symbol.asyncDispose]());

const anchor = paragraph('Neighbor before');
const updated = paragraph('Neighbor after');
const samples = {
  autop: 'First line\nsecond line\n\nSecond paragraph',
  no_gap: paragraph('First') + paragraph('Second'),
  extra_gap: paragraph('First') + '\n\n\n\n' + paragraph('Second'),
  wrong_class: block('paragraph', undefined, '<p class="wrong">Wrong class</p>'),
  missing_wrapper: block('paragraph', undefined, 'Missing wrapper'),
  picture: block(
    'image',
    undefined,
    '<figure class="wp-block-image"><picture><source srcset="https://example.test/a.webp" type="image/webp"><img src="https://example.test/a.png" alt="Picture"/></picture></figure>',
  ),
  classic: '<p>Classic content<br>with lines</p>',
  mixed_classic: '<p>Classic content</p>\n\n' + paragraph('A block'),
  freeform: block('freeform', undefined, '<p>Classic freeform</p>'),
  word: paragraph('<span style="color:red">Pasted <strong>word</strong></span>'),
  html: block(
    'html',
    undefined,
    '<style>.x{color:red}</style><script>void 0</script><iframe src="https://example.test/"></iframe><svg><path d="M0 0"></path></svg>',
  ),
  shortcodes: doc(
    block('shortcode', undefined, '[gallery ids="1,2"]'),
    paragraph('Text [example]'),
  ),
  breaks: doc('<!--more-->', '<!--nextpage-->', block('more'), block('nextpage')),
  comments_and_text:
    paragraph('First') + '\n<!-- ordinary comment -->\nstray text\n' + paragraph('Second'),
  whitespace: paragraph('Tabs') + '\r\n\t\r\n' + paragraph('Lines') + '  \r\n',
  invalid: block('paragraph', undefined, '<div class="wrong">Wrong wrapper</div>'),
  unknown: doc(
    block('missing/example', { title: 'Unknown' }),
    block('missing/content', undefined, '<div>Unknown</div>'),
  ),
  malformed: '<!-- wp:paragraph {"bad":} -->\n<p>Malformed</p>\n<!-- /wp:paragraph -->',
  unbalanced: '<!-- wp:group -->\n<div>Unclosed',
  entities: paragraph(
    'One&nbsp;two three &amp; four & five &#8217; &amp;amp; smart “quote” &#x1f680; 🚀',
  ),
  rich_text: paragraph(
    '<br><strong><em>Nested</em></strong> <mark style="background-color:rgba(0, 0, 0, 0);color:#c00" class="has-inline-color">Color</mark> <img class="wp-image-1" style="width:20px" src="https://example.test/a.png" alt=""><br>',
  ),
  empty: doc(
    paragraph('&nbsp;'),
    paragraph(''),
    paragraph('<a href="https://example.test/a b?x=1&y=2">Link</a>'),
  ),
  metadata: paragraph('Metadata', {
    metadata: {
      name: 'Named',
      patternName: 'bw/hero',
      categories: ['text'],
      bindings: { content: { source: 'core/post-meta', args: { key: 'bw_existing_note' } } },
      custom: 'retained',
    },
    patternName: 'bw/hero',
    categories: ['text'],
  }),
  json_key_order:
    '<!-- wp:paragraph {"metadata":{"name":"BEM--item < > & quote\\u0022 slash\\\\"},"dropCap":true} -->\n<p class="has-drop-cap">Escaped attributes</p>\n<!-- /wp:paragraph -->',
  json: '<!-- wp:paragraph {"metadata":{"name":"\\u002d\\u002d < > & \\\" \\\\"},"dropCap":true} -->\n<p class="has-drop-cap">JSON</p>\n<!-- /wp:paragraph -->',
  fixture_blocks: doc(
    block('bw/existing-local', undefined, '<div>Local</div>'),
    block('bw/existing-meta', undefined, '<div>Meta</div>'),
    block('bw/existing-pre', { marker: 1 }, '<pre>A  B</pre>'),
    block('bw/existing-shape', { config: {} }),
  ),
};

const ownText = {
  autop: ['First line'],
  no_gap: ['First', 'Second'],
  extra_gap: ['First', 'Second'],
  wrong_class: ['Wrong class'],
  missing_wrapper: ['Missing wrapper'],
  picture: ['Picture'],
  classic: ['Classic content'],
  mixed_classic: ['Classic content', 'A block'],
  freeform: ['Classic freeform'],
  word: ['Pasted word'],
  html: ['void 0'],
  shortcodes: ['[gallery ids="1,2"]', 'Text [example]'],
  breaks: [],
  comments_and_text: ['stray text'],
  whitespace: ['Tabs', 'Lines'],
  invalid: ['Wrong wrapper'],
  unknown: ['Unknown'],
  malformed: ['Malformed'],
  unbalanced: ['Unclosed'],
  entities: ['One two three & four & five'],
  rich_text: ['Nested Color'],
  empty: ['Link'],
  metadata: ['Named'],
  json_key_order: ['Escaped attributes'],
  json: ['JSON'],
  fixture_blocks: ['Local', 'Meta', 'A B'],
};

// Native saves are the comparison for documented formatting normalization.
async function nativeNeighbor(content) {
  const id = await seedDocument(site, { content });
  const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);

  try {
    await waitFor(site, tab, "window.wp?.data?.select('core/editor')?.__unstableIsEditorReady?.()");
    const initial = await site.evaluate(
      tab,
      `wp.blocks.serialize(wp.blocks.parse(${JSON.stringify(content)}))`,
    );
    await site.evaluate(
      tab,
      `(async () => {
      const blocks = wp.data.select('core/block-editor').getBlocks();
      const flatten = (items) => items.flatMap(b => [b,...flatten(b.innerBlocks)]);
      const neighbor = flatten(blocks).find(b => String(b.attributes.content) === 'Neighbor before');
      wp.data.dispatch('core/block-editor').updateBlockAttributes(neighbor.clientId, {content:'Neighbor after'});
      await wp.data.dispatch('core/editor').savePost();
    })()`,
    );
    const stored = await storedDocument(site, id);
    assert.ok(
      stored.content.includes(updated),
      'Native control did not persist the neighboring paragraph edit',
    );

    return { initial, content: stored.content };
  } finally {
    await tab.close();
  }
}

for (const [name, existing] of Object.entries(samples)) {
  test(
    `existing ${name} survives a neighboring edit`,
    async (t) => {
      const content = doc(existing, anchor);
      const compareNative = [
        'autop',
        'no_gap',
        'extra_gap',
        'freeform',
        'whitespace',
        'malformed',
        'entities',
        'empty',
        'metadata',
        'json',
        'json_key_order',
        'fixture_blocks',
      ].includes(name);
      const native = compareNative
        ? await nativeNeighbor(content)
        : { initial: content, content: content.replace(anchor, updated) };
      await withDocument(
        site,
        { content },
        async ({ blockwork, doc: connected, id, before, tab }) => {
          if (!compareNative) {
            const canonical = await site.evaluate(
              tab,
              `wp.blocks.serialize(wp.blocks.parse(${JSON.stringify(content)}))`,
            );
            native.content = canonical.replace(anchor, updated);
          }

          assert.ok([true, false].includes(connected.normalization_required));
          const all = await blockwork.read({ blocks: 'all' });
          assert.equal(all.ok, true, JSON.stringify(all));

          for (const needle of ownText[name]) {
            const ownSearch = await blockwork.read({ blocks: { search: needle } });
            assert.equal(ownSearch.ok, true, JSON.stringify(ownSearch));
            const originalOnly = [
              'html',
              'invalid',
              'missing_wrapper',
              'unknown',
              'unbalanced',
            ].includes(name);
            const templateOnly = name === 'fixture_blocks' && needle === 'A B';

            if (originalOnly || templateOnly) {
              t.diagnostic(
                JSON.stringify({
                  seed: name,
                  search: needle,
                  matches: ownSearch.selection.total,
                  text_source: templateOnly ? 'save_template' : 'unsupported_original',
                }),
              );
              const sourceBlock = templateOnly
                ? all.blocks.find((item) => item.name === 'bw/existing-pre')
                : all.blocks[name === 'unknown' ? 1 : 0];
              const source = await blockwork.read({
                blocks: { client_id: sourceBlock.client_id, markup: true },
              });
              assert.equal(source.ok, true, JSON.stringify(source));
              assert.ok(
                source.markup.replace(/\s+/g, ' ').includes(needle),
                JSON.stringify(source),
              );
            } else {
              assert.ok(ownSearch.selection.total > 0, JSON.stringify(ownSearch));
            }
          }

          if (!ownText[name].length)
            t.diagnostic('Marker-only seed has no authored text to search.');

          const search = await blockwork.read({ blocks: { search: 'Neighbor before' } });
          assert.equal(search.ok, true, JSON.stringify(search));
          assert.ok(search.selection.total >= 1, JSON.stringify(search));
          const target = search.blocks.find((item) => item.name === 'core/paragraph');
          assert.ok(target, JSON.stringify(search));
          const structural = await blockwork.edit({
            edits: [
              {
                op: 'insert',
                block: { name: 'core/paragraph', attributes: { content: 'Inserted' } },
              },
            ],
          });

          if (!structural.ok) {
            await assertRefused(site, id, before, structural);
            assert.equal(structural.editor_result, 'not_applied', JSON.stringify(structural));
          } else {
            const reverted = await blockwork.revert();
            assert.equal(reverted.ok, true, JSON.stringify(reverted));
          }

          const result = await blockwork.edit({
            edits: [
              {
                op: 'update',
                client_id: target.client_id,
                attributes: { content: 'Neighbor after' },
              },
            ],
          });

          if (name === 'json' || name === 'json_key_order')
            assert.equal(result.ok, true, JSON.stringify(result));

          if (!result.ok) {
            await assertRefused(site, id, before, result);
            assert.equal(result.editor_result, 'not_applied', JSON.stringify(result));

            return;
          }

          const saved = await blockwork.save();

          if (name === 'fixture_blocks') {
            assert.equal(saved.error, 'ambiguous_union_attribute', JSON.stringify(saved));
            await assertRefused(site, id, before, saved);

            return;
          }

          const { after } = await assertSavedCleanly(site, id, before, saved);

          assert.equal(after.content, native.content);

          if (after.content !== before.content.replace(anchor, updated)) {
            if (name === 'malformed')
              t.diagnostic(
                `Native also discards malformed JSON attributes; normalization_required=${connected.normalization_required}. Text is unchanged.`,
              );
            else assert.equal(connected.normalization_required, true);
          }
        },
      );
    },
  );
}

for (const [name, content] of Object.entries({
  long_paragraph: paragraph('x'.repeat(200_000)),
  many_blocks: doc(...Array.from({ length: 1500 }, () => paragraph('Small'))),
  deep_nesting: Array.from({ length: 14 }).reduce((inner) => group(inner), paragraph('Deep')),
})) {
  test(`large document ${name} connects and reads`, async (t) => {
    const start = performance.now();
    await withDocument(
      site,
      {
        content: doc(content, anchor),
        title: 'Odd / title & 🚀',
        extra: { post_name: 'odd-é-🚀-日本' },
      },
      async ({ blockwork, doc: connected, id, before }) => {
        const all = await blockwork.read({ blocks: 'all' });
        assert.ok(all.ok || (all.error && all.hint && all.next), JSON.stringify(all));
        const search = await blockwork.read({
          blocks: {
            search: name === 'long_paragraph' ? 'xxxxx' : name === 'many_blocks' ? 'Small' : 'Deep',
          },
        });
        assert.ok(
          search.ok || (search.error && search.hint && search.next),
          JSON.stringify(search),
        );
        assert.equal(connected.ok, true);
        const neighbor = await blockwork.read({ blocks: { search: 'Neighbor before' } });
        assert.equal(neighbor.ok, true, JSON.stringify(neighbor));
        const target = neighbor.blocks[0];
        const structure = await blockwork.edit({
          edits: [
            {
              op: 'insert',
              block: { name: 'core/paragraph', attributes: { content: 'Large insertion' } },
            },
          ],
        });

        if (structure.ok) {
          const inserted = await blockwork.read({ blocks: { search: 'Large insertion' } });
          assert.equal(inserted.ok, true, JSON.stringify(inserted));
          assert.equal(
            (
              await blockwork.edit({
                edits: [{ op: 'remove', client_id: inserted.blocks[0].client_id }],
              })
            ).ok,
            true,
          );
        } else {
          await assertRefused(site, id, before, structure);
        }

        const result = await blockwork.edit({
          edits: [
            {
              op: 'update',
              client_id: target.client_id,
              attributes: { content: 'Neighbor after' },
            },
          ],
        });

        if (!result.ok) {
          await assertRefused(site, id, before, result);
          assert.equal(result.editor_result, 'not_applied', JSON.stringify(result));

          return;
        }

        const saved = await blockwork.save();
        const { after } = await assertSavedCleanly(site, id, before, saved);
        assert.equal(after.content, before.content.replace(anchor, updated));
      },
    );
    t.diagnostic(`${name}: ${Math.round(performance.now() - start)} ms`);
  });
}

for (const [name, markup] of Object.entries({
  deprecated: block('bw/existing-deprecated', { text: 'Old' }, '<p>Old</p>'),
  eligible: block('bw/existing-eligible', { legacyTone: 'blue' }, '<div>Eligible</div>'),
  buttons: block(
    'buttons',
    { contentJustification: 'center' },
    '<div class="wp-block-buttons is-content-justification-center">' +
      block(
        'button',
        undefined,
        '<div class="wp-block-button"><a class="wp-block-button__link wp-element-button">Old button</a></div>',
      ) +
      '</div>',
  ),
})) {
  test(
    `an edit beside deprecated ${name} saves cleanly or refuses`,
    async () => {
      await withDocument(
        site,
        { content: doc(markup, anchor) },
        async ({ blockwork, doc: connected, id, before }) => {
          assert.ok([true, false].includes(connected.normalization_required));
          const update = await blockwork.edit({
            edits: [
              {
                op: 'update',
                client_id: connected.blocks.at(-1).client_id,
                attributes: { content: 'Neighbor after' },
              },
            ],
          });

          if (update.ok) {
            const saved = await blockwork.save();
            const { after } = await assertSavedCleanly(site, id, before, saved);
            assert.equal(after.content, before.content.replace(anchor, updated));
          } else {
            await assertRefused(site, id, before, update);
            assert.equal(update.editor_result, 'not_applied', JSON.stringify(update));
          }
        },
      );
    },
  );
}

// Core's earlier save, without the has-icon classes it now writes on the heading.
test('a prepared older page takes the requested edit once the user clicks Save', async () => {
  await withDocument(
    site,
    { content: olderAccordion },
    async ({ blockwork, doc: connected, id, before, tab }) => {
      const change = {
        op: 'update',
        client_id: connected.blocks.at(-1).client_id,
        attributes: { content: 'Changed' },
      };
      const refused = await blockwork.edit({ edits: [change] });
      assert.equal(refused.error, 'initial_serialization_changed', JSON.stringify(refused));
      assert.deepEqual(await blockwork.prepare_resave(), { ok: true, dirty: true });
      assert.equal((await storedDocument(site, id)).content, before.content);
      await site.evaluate(tab, "document.querySelector('.editor-post-publish-button').click()");
      const waited = await blockwork.wait_for_save();
      assert.equal(waited.dirty, false, JSON.stringify(waited));
      const upgraded = (await storedDocument(site, id)).content;
      assert.ok(upgraded.includes('has-icon'), upgraded);
      assert.equal((await blockwork.edit({ edits: [change] })).ok, true);
      const saved = await blockwork.save({ save_all_pending: true });
      assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
      assert.equal(
        (await storedDocument(site, id)).content,
        upgraded.replace('Neighbor', 'Changed'),
      );
    },
    { workflow: 'attached' },
  );
});

test('a prepared older page saves through Blockwork when the user asks', async () => {
  await withDocument(
    site,
    { content: olderAccordion },
    async ({ blockwork, doc: connected, id }) => {
      assert.equal((await blockwork.prepare_resave()).dirty, true);
      const saved = await blockwork.save({ save_all_pending: true });
      assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
      const { content } = await storedDocument(site, id);
      assert.ok(content.includes('has-icon'), content);
      assert.ok(content.includes('First body') && content.includes('Second body'), content);
      const edited = await blockwork.edit({
        edits: [
          {
            op: 'update',
            client_id: connected.blocks.at(-1).client_id,
            attributes: { content: 'Changed' },
          },
        ],
      });
      assert.equal(edited.ok, true, JSON.stringify(edited));
    },
    { workflow: 'attached' },
  );
});

for (const operation of ['move', 'remove']) {
  test(
    `footnote references survive ${operation}`,
    async () => {
      const first = paragraph(
        'First<sup data-fn="fn_a" class="fn"><a href="#fn_a" id="fn_a-link">1</a></sup>',
      );
      const second = paragraph(
        'Second<sup data-fn="fn_b" class="fn"><a href="#fn_b" id="fn_b-link">2</a></sup>',
      );
      const content = doc(first, second, block('footnotes'));
      const meta = {
        footnotes: JSON.stringify([
          { id: 'fn_a', content: 'Alpha note' },
          { id: 'fn_b', content: 'Beta note' },
        ]),
      };
      await withDocument(
        site,
        { content, meta },
        async ({ blockwork, doc: connected, id, before }) => {
          const target = connected.blocks[operation === 'move' ? 1 : 0].client_id;
          const edit =
            operation === 'move'
              ? { op: 'move', client_id: target, index: 0 }
              : { op: 'remove', client_id: target };
          const result = await blockwork.edit({ edits: [edit] });
          assert.equal(result.editor_result, 'applied', JSON.stringify(result));

          const saved = await blockwork.save();
          const { after } = await assertSavedCleanly(site, id, before, saved, { allow: ['meta'] });
          const secondNumbered = second.replace('>2</a>', '>1</a>');
          const expected =
            operation === 'move'
              ? doc(secondNumbered, first.replace('>1</a>', '>2</a>'), block('footnotes'))
              : doc(secondNumbered, block('footnotes'));
          assert.equal(after.content, expected);
          assert.deepEqual(
            JSON.parse(after.meta.footnotes[0]),
            operation === 'move'
              ? [
                  { id: 'fn_b', content: 'Beta note' },
                  { id: 'fn_a', content: 'Alpha note' },
                ]
              : [{ id: 'fn_b', content: 'Beta note' }],
          );
        },
      );
    },
  );
}

test('a lower privilege save reports filtered existing HTML', async (t) => {
  await site.php("get_role('editor')->remove_cap('unfiltered_html');");
  await site.signIn('editor');

  try {
    const existing = block(
      'html',
      undefined,
      '<iframe src="https://example.test/"></iframe><script>void 0</script>',
    );
    await withDocument(
      site,
      { content: doc(existing, anchor) },
      async ({ blockwork, doc: connected, id, before }) => {
        const result = await blockwork.edit({
          edits: [
            {
              op: 'update',
              client_id: connected.blocks.at(-1).client_id,
              attributes: { content: 'Neighbor after' },
            },
          ],
        });

        if (!result.ok) {
          await assertRefused(site, id, before, result);
          assert.equal(result.editor_result, 'not_applied', JSON.stringify(result));
          t.diagnostic(JSON.stringify({ path: 'refused_before_write', error: result.error }));

          return;
        }

        const saved = await blockwork.save();
        const after = await storedDocument(site, id);

        if (after.content !== before.content.replace(anchor, updated)) {
          assert.notEqual(saved.persistence, 'verified', JSON.stringify(saved));
          assert.equal(saved.ok, false, JSON.stringify(saved));
          assert.ok(saved.error && saved.hint && saved.next, JSON.stringify(saved));
          const revisions = await site.php(
            `echo wp_json_encode(array_values(array_map(fn($revision) => $revision->post_content, wp_get_post_revisions(${id}))));`,
          );
          assert.ok(Array.isArray(revisions));
          const retainsOriginal = revisions.some(
            (content) => content.includes('<iframe') && content.includes('<script'),
          );
          t.diagnostic(
            JSON.stringify({
              path: 'detected_after_write',
              error: saved.error,
              persistence: saved.persistence,
              revision_retains_original: retainsOriginal,
            }),
          );
        } else {
          await assertSavedCleanly(site, id, before, saved);
        }
      },
    );
  } finally {
    await site.signIn('admin');
    await site.php("get_role('editor')->add_cap('unfiltered_html');");
  }
});

for (const [mode, existing] of Object.entries({
  pre: block('bw/existing-pre', { marker: 1 }, '<pre>A  B</pre>'),
})) {
  test(
    `server filter changing ${mode} is not verified as unchanged`,

    async () => {
      try {
        await withDocument(
          site,
          { content: doc(existing, anchor) },
          async ({ blockwork, doc: connected, id, before }) => {
            const result = await blockwork.edit({
              edits: [
                {
                  op: 'update',
                  client_id: connected.blocks.at(-1).client_id,
                  attributes: { content: 'Neighbor after' },
                },
              ],
            });
            assert.equal(result.ok, true, JSON.stringify(result));
            await site.php(`update_option('bw_existing_filter', '${mode}');`);
            const saved = await blockwork.save();
            const after = await storedDocument(site, id);
            assert.equal(
              after.content,
              before.content.replace(anchor, updated).replace('<pre>A  B</pre>', '<pre>A B</pre>'),
            );
            assert.notEqual(saved.persistence, 'verified', JSON.stringify(saved));
            assert.ok(saved.error && saved.hint && saved.next, JSON.stringify(saved));
          },
        );
      } finally {
        await site.php("delete_option('bw_existing_filter');");
      }
    },
  );
}

test('search finds existing table cell text', async () => {
  const table = block(
    'table',
    undefined,
    '<figure class="wp-block-table"><table><tbody><tr><td>Findable cell</td></tr></tbody></table></figure>',
  );
  await withDocument(site, { content: doc(table, anchor) }, async ({ blockwork }) => {
    const all = await blockwork.read({ blocks: 'all' });
    assert.equal(all.ok, true, JSON.stringify(all));
    const search = await blockwork.read({ blocks: { search: 'Findable cell' } });
    assert.equal(search.ok, true, JSON.stringify(search));
    assert.ok(search.selection.total >= 1, JSON.stringify(search));
  });
});

test('local editor attributes do not block a neighboring edit', async () => {
  const existing = block('bw/existing-local', undefined, '<div>Local</div>');
  await withDocument(
    site,
    { content: doc(existing, anchor) },
    async ({ blockwork, doc: connected, tab, id, before }) => {
      const local = connected.blocks[0].client_id;
      await site.evaluate(
        tab,
        `wp.data.dispatch('core/block-editor').updateBlockAttributes(${JSON.stringify(local)}, {previewIndex: 1})`,
      );
      await blockwork.read({ blocks: 'all' });
      const edit = await blockwork.edit({
        edits: [
          {
            op: 'update',
            client_id: connected.blocks.at(-1).client_id,
            attributes: { content: 'Neighbor after' },
          },
        ],
      });
      assert.equal(edit.ok, true, JSON.stringify(edit));
      const saved = await blockwork.save({ save_all_pending: true });
      const { after } = await assertSavedCleanly(site, id, before, saved);
      assert.equal(after.content, before.content.replace(anchor, updated));
    },
    { workflow: 'attached' },
  );
});

for (const name of [
  'button',
  'image',
  'group',
  'columns',
  'cover',
  'quote',
  'pullquote',
  'gallery',
]) {
  test(
    `an edit beside native deprecated ${name} saves cleanly or refuses`,
    async (t) => {
      let old;
      const media = [];

      if (name === 'image' || name === 'gallery') {
        for (let index = 0; index < (name === 'gallery' ? 2 : 1); index++)
          media.push(
            await seedImage(site, {
              name: `legacy-${name}-${index}`,
              width: 320,
              height: 240,
              alt: 'Legacy image',
            }),
          );
      }

      await withDocument(site, { content: anchor }, async ({ tab }) => {
        old = await site.evaluate(
          tab,
          String.raw`(() => {
        const name = ${JSON.stringify('core/' + name)};
        const type = wp.blocks.getBlockType(name);
        const attributes = {text:'Legacy button', content:'Legacy text', value:'Legacy quote', citation:'Legacy citation', url:'https://example.test/a.png', alt:'Legacy image', ids:[1,2], images:[{id:1,url:'https://example.test/a.png',alt:'Legacy image',caption:''},{id:2,url:'https://example.test/b.png',alt:'Second image',caption:''}], dimRatio:50, caption:'', align:'wide'};
        const media = ${JSON.stringify(media)};
        if (media.length) {
          Object.assign(attributes,{url:media[0].url,id:media[0].id,alt:media[0].alt,sizeSlug:'full'});
          attributes.images=media.map(image=>({id:image.id,url:image.url,alt:image.alt,caption:''}));
          attributes.ids=media.map(image=>image.id);
        }
        if (name === 'core/pullquote') attributes.textAlign='center';
        if (name === 'core/button') delete attributes.align;
        if (name === 'core/image') Object.assign(attributes,{width:320,height:240});
        for (let i = type.deprecated.length - 1; i >= 0; i--) {
          const d = type.deprecated[i];
          try {
            const original = {...type};
            const keys = ['attributes','supports','save','migrate','isEligible','apiVersion'];
            let markup;
            try {
              for (const key of keys) delete type[key];
              Object.assign(type,d);
              const candidate = wp.blocks.createBlock(name);
              Object.assign(candidate.attributes,attributes);
              markup = wp.blocks.serialize([candidate]);
            } finally {
              for (const key of keys) delete type[key];
              Object.assign(type,original);
            }
            const parsed = wp.blocks.parse(markup)[0];
            if (parsed?.isValid && wp.blocks.serialize([parsed]) !== markup) return {markup,index:i};
          } catch {}
        }
        return null;
      })()`,
        );
      });
      assert.ok(old, `No runnable native deprecation for ${name}`);
      t.diagnostic(`deprecated index ${old.index}`);
      await withDocument(
        site,
        { content: doc(old.markup, anchor) },
        async ({ blockwork, doc: connected, id, before }) => {
          if (!connected.ok) {
            await assertRefused(site, id, before, connected, { error: 'editor_not_clean' });
            t.diagnostic(
              'Native initialization left pending content; the background path correctly refused before mutation.',
            );

            return;
          }

          assert.ok([true, false].includes(connected.normalization_required));
          const edit = await blockwork.edit({
            edits: [
              {
                op: 'update',
                client_id: connected.blocks.at(-1).client_id,
                attributes: { content: 'Neighbor after' },
              },
            ],
          });

          if (!edit.ok) {
            await assertRefused(site, id, before, edit);
            assert.equal(edit.editor_result, 'not_applied', JSON.stringify(edit));
          } else {
            const saved = await blockwork.save();
            await assertSavedCleanly(site, id, before, saved);
          }
        },
        { connected: false },
      );
    },
  );
}

for (const [name, expression, needle] of [
  [
    'quote',
    "wp.blocks.createBlock('core/quote',{citation:'Citation needle'},[wp.blocks.createBlock('core/paragraph',{content:'Quote body'})])",
    'Citation needle',
  ],
  [
    'pullquote',
    "wp.blocks.createBlock('core/pullquote',{value:'Pullquote body',citation:'Citation needle'})",
    'Citation needle',
  ],
  [
    'details',
    "wp.blocks.createBlock('core/details',{summary:'Summary needle'},[wp.blocks.createBlock('core/paragraph',{content:''})])",
    'Summary needle',
  ],
  [
    'button',
    "wp.blocks.createBlock('core/buttons',{},[wp.blocks.createBlock('core/button',{text:'Button needle',url:'https://example.test/'})])",
    'Button needle',
  ],
  [
    'navigation',
    "wp.blocks.createBlock('core/navigation',{},[wp.blocks.createBlock('core/navigation-link',{label:'Navigation needle',url:'https://example.test/',kind:'custom'})])",
    'Navigation needle',
  ],
  [
    'table',
    "wp.blocks.createBlock('core/table',{head:[{cells:[{content:'Header needle',tag:'th'}]}],body:[{cells:[{content:'Body needle',tag:'td'}]}],foot:[{cells:[{content:'Footer needle',tag:'td'}]}]})",
    'Body needle',
  ],
]) {
  test(`read searches ${name} own text`, async () => {
    const markup = await serializeNatively(site, `[${expression}]`);
    await withDocument(site, { content: doc(markup, anchor) }, async ({ blockwork }) => {
      const all = await blockwork.read({ blocks: 'all' });
      assert.equal(all.ok, true, JSON.stringify(all));
      const result = await blockwork.read({ blocks: { search: needle } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(result.selection.total > 0, JSON.stringify(result));
    });
  });
}

for (const action of ['update_neighbor', 'copy']) {
  test(
    `footnote ${action} retains note bodies or refuses before mutation`,
    async () => {
      const reference = paragraph(
        'Noted<sup data-fn="fn_a" class="fn"><a href="#fn_a" id="fn_a-link">1</a></sup>',
      );
      const meta = { footnotes: JSON.stringify([{ id: 'fn_a', content: 'Alpha note' }]) };
      await withDocument(
        site,
        { content: doc(reference, anchor, block('footnotes')), meta },
        async ({ blockwork, doc: connected, id, before }) => {
          const edit =
            action === 'copy'
              ? { op: 'insert', markup: reference }
              : {
                  op: 'update',
                  client_id: connected.blocks[1].client_id,
                  attributes: { content: 'Neighbor after' },
                };
          const result = await blockwork.edit({ edits: [edit] });

          if (action === 'copy') {
            assert.equal(result.editor_result, 'applied', JSON.stringify(result));
          }

          if (!result.ok) {
            await assertRefused(site, id, before, result);
            assert.equal(result.editor_result, 'not_applied', JSON.stringify(result));

            return;
          }

          const saved = await blockwork.save();
          const { after } = await assertSavedCleanly(site, id, before, saved, { allow: ['meta'] });
          assert.ok(JSON.stringify(after.meta).includes('Alpha note'));

          if (action === 'copy') {
            assert.deepEqual(JSON.parse(after.meta.footnotes[0]), [
              { id: 'fn_a', content: 'Alpha note' },
              { id: 'fn_a', content: 'Alpha note' },
            ]);
            assert.equal(after.content, doc(reference, anchor, block('footnotes'), reference));
          }
        },
      );
    },
  );
}

test(
  'legacy meta attribute guide describes a usable write boundary',
  async () => {
    await withDocument(
      site,
      {
        content: doc(block('bw/existing-meta', undefined, '<div>Meta</div>'), anchor),
        meta: { bw_existing_note: 'Original note' },
      },
      async ({ blockwork, doc: connected, id, before }) => {
        const guide = await blockwork.read({
          attribute_guide: { client_id: connected.blocks[0].client_id },
        });
        assert.equal(guide.ok, true, JSON.stringify(guide));
        const result = await blockwork.edit({
          edits: [
            {
              op: 'update',
              client_id: connected.blocks[0].client_id,
              attributes: { note: 'Revised note' },
            },
          ],
        });

        assert.equal(result.ok, false, JSON.stringify(result));
        await assertRefused(site, id, before, result);
        assert.equal(result.editor_result, 'not_applied', JSON.stringify(result));
        const attribute = guide.attribute_guide.attributes.find((a) => a.name === 'note');
        assert.equal(attribute.editable, false);
        assert.equal(attribute.meta_key, 'bw_existing_note');
        const settings = await blockwork.read({ settings: true });
        assert.equal(settings.ok, true, JSON.stringify(settings));
        const update = await blockwork.edit({
          settings: { meta: { bw_existing_note: 'Revised note' } },
        });
        assert.equal(update.ok, true, JSON.stringify(update));

        const saved = await blockwork.save();
        const { after } = await assertSavedCleanly(site, id, before, saved, { allow: ['meta'] });
        assert.deepEqual(after.meta.bw_existing_note, ['Revised note']);
      },
    );
  },
);

for (const initialized of [false, true]) {
  test(`a 500 image gallery initialized ${initialized} has truthful save results`, async (t) => {
    const gallery = await serializeNatively(
      site,
      "[wp.blocks.createBlock('core/gallery',{},Array.from({length:500},(_,i)=>wp.blocks.createBlock('core/image',{url:'https://example.test/image-'+i+'.png',alt:'Image '+i}))) ]",
    );
    let content = doc(gallery, anchor);

    if (initialized) {
      const native = await nativeNeighbor(content);
      content = native.content.replace(updated, anchor);
    }

    const start = performance.now();
    await withDocument(
      site,
      { content },
      async ({ blockwork, doc: connected, id, before, tab }) => {
        if (!connected.ok) {
          await assertRefused(site, id, before, connected, { error: 'editor_not_clean' });
          t.diagnostic(
            'Native gallery initialization changed the document; background connect refused before editing or saving.',
          );

          return;
        }

        const structural = await blockwork.edit({
          edits: [
            {
              op: 'insert',
              block: {
                name: 'core/paragraph',
                attributes: { content: 'Gallery structural probe' },
              },
            },
          ],
        });

        if (structural.ok) assert.equal((await blockwork.revert()).ok, true);
        else {
          await assertRefused(site, id, before, structural);
          assert.equal(structural.editor_result, 'not_applied', JSON.stringify(structural));
        }

        const baseline = await site.evaluate(
          tab,
          "wp.blocks.serialize(wp.data.select('core/block-editor').getBlocks())",
        );
        const expected = baseline.replace(anchor, updated);
        const result = await blockwork.edit({
          edits: [
            {
              op: 'update',
              client_id: connected.blocks.at(-1).client_id,
              attributes: { content: 'Neighbor after' },
            },
          ],
        });

        if (!result.ok) {
          await assertRefused(site, id, before, result);
          assert.equal(result.editor_result, 'not_applied', JSON.stringify(result));

          return;
        }

        const saved = await blockwork.save(initialized ? { save_all_pending: true } : {});

        if (saved.ok) {
          const { after } = await assertSavedCleanly(site, id, before, saved);
          assert.equal(after.content, expected);
        } else {
          assert.ok(saved.error && saved.hint && saved.next, JSON.stringify(saved));
          const after = await storedDocument(site, id);
          t.diagnostic(
            JSON.stringify({
              error: saved.error,
              persistence: saved.persistence,
              content_matches_expected: after.content === before.content.replace(anchor, updated),
            }),
          );
        }
      },
      { workflow: initialized ? 'attached' : 'background', connected: false },
    );
    t.diagnostic(`500 images: ${Math.round(performance.now() - start)} ms`);
  });
}

for (const registered of [true, false]) {
  test(`plugin attribute with registration ${registered} follows announced native normalization`, async () => {
    await site.php(`update_option('bw_existing_plugin_active', ${registered ? 'true' : 'false'});`);

    try {
      const content = doc(block('bw/existing-plugin', { meaning: 'Plugin-owned value' }), anchor);
      const native = await nativeNeighbor(content);
      await withDocument(site, { content }, async ({ blockwork, doc: connected, id, before }) => {
        assert.equal(connected.normalization_required, native.initial !== before.content);
        const result = await blockwork.edit({
          edits: [
            {
              op: 'update',
              client_id: connected.blocks.at(-1).client_id,
              attributes: { content: 'Neighbor after' },
            },
          ],
        });

        if (!result.ok) {
          await assertRefused(site, id, before, result);

          return;
        }

        const { after } = await assertSavedCleanly(site, id, before, await blockwork.save());
        assert.equal(after.content, native.content);
        assert.ok(after.content.includes('Plugin-owned value'));
      });
    } finally {
      await site.php("delete_option('bw_existing_plugin_active');");
    }
  });
}

test(
  'union attribute server type change prevents verified persistence',

  async () => {
    try {
      await withDocument(
        site,
        { content: doc(block('bw/existing-shape', { config: { keep: true } }), anchor) },
        async ({ blockwork, doc: connected, id }) => {
          const edit = await blockwork.edit({
            edits: [
              { op: 'replace', client_id: connected.blocks[0].client_id, block: { name: 'bw/existing-shape', attributes: { config: {} } } },
              {
                op: 'update',
                client_id: connected.blocks.at(-1).client_id,
                attributes: { content: 'Neighbor after' },
              },
            ],
          });
          assert.equal(edit.ok, true, JSON.stringify(edit));
          await site.php("update_option('bw_existing_filter','union');");
          const saved = await blockwork.save();
          const after = await storedDocument(site, id);
          assert.ok(after.content.includes('"config":[]'), after.content);
          assert.notEqual(saved.persistence, 'verified', JSON.stringify(saved));
          assert.ok(saved.error && saved.hint && saved.next, JSON.stringify(saved));
        },
      );
    } finally {
      await site.php("delete_option('bw_existing_filter');");
    }
  },
);

test('read metadata markup can replace its original block without dropping metadata', async () => {
  const metadata = { name: 'Named', patternName: 'bw/example', categories: ['text'] };
  const markup = paragraph('Metadata body résumé 🚀', { metadata });
  await withDocument(
    site,
    { content: doc(markup, anchor) },
    async ({ blockwork, doc: connected, id, before }) => {
      const read = await blockwork.read({
        blocks: { client_id: connected.blocks[0].client_id, markup: true },
      });
      assert.equal(read.ok, true, JSON.stringify(read));
      const result = await blockwork.edit({
        edits: [
          {
            op: 'replace',
            client_id: connected.blocks[0].client_id,
            markup: read.markup.replace('Metadata body', 'Replaced body'),
          },
        ],
      });

      assert.equal(result.ok, true, JSON.stringify(result));

      const { after } = await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal(after.content, before.content.replace('Metadata body', 'Replaced body'));
    },
  );
});

for (const registered of [true, false]) {
  test(`plugin extension attribute with registration ${registered} reports native loss`, async (t) => {
    await site.php(`update_option('bw_existing_plugin_active', ${registered ? 'true' : 'false'});`);

    try {
      const content = doc(
        paragraph('Plugin paragraph', { pluginMeaning: 'Plugin-owned value' }),
        anchor,
      );
      const native = await nativeNeighbor(content);
      await withDocument(site, { content }, async ({ blockwork, doc: connected, id, before }) => {
        assert.equal(connected.normalization_required, native.initial !== before.content);
        const result = await blockwork.edit({
          edits: [
            {
              op: 'update',
              client_id: connected.blocks.at(-1).client_id,
              attributes: { content: 'Neighbor after' },
            },
          ],
        });

        if (!result.ok) {
          await assertRefused(site, id, before, result);

          return;
        }

        const { after } = await assertSavedCleanly(site, id, before, await blockwork.save());
        assert.equal(after.content, native.content);
        assert.equal(after.content.includes('Plugin-owned value'), registered);

        if (!registered) {
          assert.equal(connected.normalization_required, true);
          t.diagnostic(
            'Native save also drops the inactive extension attribute; Blockwork announces normalization_required.',
          );
        }
      });
    } finally {
      await site.php("delete_option('bw_existing_plugin_active');");
    }
  });
}

test('script string entity spelling is verified exactly', async () => {
  const existing = block(
    'html',
    undefined,
    '<script type="application/ld+json">{"name":"literal&nbsp;value"}</script>',
  );

  try {
    await withDocument(
      site,
      { content: doc(existing, anchor) },
      async ({ blockwork, doc: connected, id, before }) => {
        const edit = await blockwork.edit({
          edits: [
            {
              op: 'update',
              client_id: connected.blocks.at(-1).client_id,
              attributes: { content: 'Neighbor after' },
            },
          ],
        });

        if (!edit.ok) {
          await assertRefused(site, id, before, edit);

          return;
        }

        await site.php("update_option('bw_existing_filter','script_entity');");
        const saved = await blockwork.save();
        const after = await storedDocument(site, id);
        assert.ok(after.content.includes('literal value'));
        assert.notEqual(saved.persistence, 'verified', JSON.stringify(saved));
        assert.ok(saved.error && saved.hint && saved.next, JSON.stringify(saved));
      },
    );
  } finally {
    await site.php("delete_option('bw_existing_filter');");
  }
});

test('table rich text retains spans, entities and Unicode beside a paragraph edit', async () => {
  const content = await serializeNatively(
    site,
    "[wp.blocks.createBlock('core/table',{head:[{cells:[{content:'Header',tag:'th'}]}],body:[{cells:[{content:'<strong>RTL العربية é 🚀</strong> <a href=\"https://example.test/\">A&nbsp;B &amp; C</a>',tag:'td',colspan:'2',rowspan:'2'}]}],foot:[{cells:[{content:'Footer',tag:'td'}]}]})]",
  );
  await withDocument(
    site,
    { content: doc(content, anchor) },
    async ({ blockwork, doc: connected, id, before }) => {
      const read = await blockwork.read({ blocks: { client_id: connected.blocks[0].client_id } });
      assert.equal(read.ok, true, JSON.stringify(read));
      const body = structuredClone(read.blocks[0].attributes.body);
      body[0].cells[0].content = String(body[0].cells[0].content).replace(
        'RTL العربية',
        'Updated العربية',
      );
      const edit = await blockwork.edit({
        edits: [
          { op: 'update', client_id: connected.blocks[0].client_id, attributes: { body } },
          {
            op: 'update',
            client_id: connected.blocks.at(-1).client_id,
            attributes: { content: 'Neighbor after' },
          },
        ],
      });
      assert.equal(edit.ok, true, JSON.stringify(edit));
      const { after } = await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal(
        after.content,
        before.content.replace(anchor, updated).replace('RTL العربية', 'Updated العربية'),
      );
    },
  );
});

test(
  'copying footnote markup to another document retains its body or refuses before mutation',
  async () => {
    const reference = paragraph(
      'Copied note<sup data-fn="fn_a" class="fn"><a href="#fn_a" id="fn_a-link">1</a></sup>',
    );
    const meta = { footnotes: JSON.stringify([{ id: 'fn_a', content: 'Alpha note' }]) };
    let markup;
    await withDocument(
      site,
      { content: doc(reference, block('footnotes')), meta },
      async ({ blockwork, doc: connected }) => {
        const read = await blockwork.read({
          blocks: { client_id: connected.blocks[0].client_id, markup: true },
        });
        assert.equal(read.ok, true, JSON.stringify(read));
        markup = read.markup;
      },
    );
    await withDocument(site, { content: anchor }, async ({ blockwork, id, before }) => {
      const result = await blockwork.edit({ edits: [{ op: 'insert', markup }] });

      if (!result.ok) {
        await assertRefused(site, id, before, result);
        assert.equal(result.editor_result, 'not_applied', JSON.stringify(result));
        assert.equal(result.diagnostics.constraint, 'footnote_body_required');
        assert.match(result.hint, /source.*settings/);

        return;
      }

      const saved = await blockwork.save();
      const { after } = await assertSavedCleanly(site, id, before, saved, { allow: ['meta'] });
      assert.ok(JSON.stringify(after.meta).includes('Alpha note'), JSON.stringify(after.meta));
    });
  },
);

test('format normalization beside raw HTML preserves its exact script region', async () => {
  const raw = block(
    'html',
    undefined,
    '<script type="application/ld+json">{"name":"A&nbsp;B"}</script>',
  );
  const content = raw + '\n\n\n\n' + anchor;
  const native = await nativeNeighbor(content);
  await withDocument(site, { content }, async ({ blockwork, doc: connected, id, before }) => {
    assert.equal(connected.normalization_required, true, JSON.stringify(connected));
    const result = await blockwork.edit({
      edits: [
        {
          op: 'update',
          client_id: connected.blocks.at(-1).client_id,
          attributes: { content: 'Neighbor after' },
        },
      ],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const { after } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(after.content, native.content);
    assert.ok(after.content.includes(raw));
  });
});

test('visible text search decodes entities in an existing Unicode heading', async () => {
  const content = block(
    'heading',
    undefined,
    '<h2 class="wp-block-heading">R&amp;D&nbsp;Résumé &lt;tag&gt; 🚀</h2>',
  );
  await withDocument(site, { content: doc(content, anchor) }, async ({ blockwork }) => {
    const all = await blockwork.read({ blocks: 'all' });
    assert.equal(all.ok, true, JSON.stringify(all));
    const found = await blockwork.read({
      blocks: { search: 'R&D Résumé <tag> 🚀', attributes: true },
    });
    assert.equal(found.ok, true, JSON.stringify(found));
    assert.equal(found.selection.total, 1, JSON.stringify(found));
    assert.equal(found.blocks[0].name, 'core/heading');
  });
});

test('read metadata markup with protected unknown members refuses replacement', async () => {
  const metadata = {
    name: 'Named',
    patternName: 'bw/example',
    categories: ['text'],
    overrides: { content: 'Example' },
    custom: 'Retained',
  };
  await withDocument(
    site,
    { content: doc(paragraph('Metadata body', { metadata }), anchor) },
    async ({ blockwork, doc: connected, id, before }) => {
      const updatedNeighbor = await blockwork.edit({
        edits: [
          {
            op: 'update',
            client_id: connected.blocks.at(-1).client_id,
            attributes: { content: 'Neighbor after' },
          },
        ],
      });
      assert.equal(updatedNeighbor.ok, true, JSON.stringify(updatedNeighbor));
      const { after } = await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal(after.content, before.content.replace(anchor, updated));
      const read = await blockwork.read({
        blocks: { client_id: connected.blocks[0].client_id, markup: true },
      });
      assert.equal(read.ok, true, JSON.stringify(read));
      assert.ok(read.markup.includes('Retained'));
      const result = await blockwork.edit({
        edits: [{ op: 'replace', client_id: connected.blocks[0].client_id, markup: read.markup }],
      });
      await assertRefused(site, id, after, result, { error: 'unsupported_attribute' });
      assert.ok(result.diagnostics.attribute.startsWith('metadata.'), JSON.stringify(result));
    },
  );
});

// Agents gave up on this refusal when it named no block.
test('an older stored block that blocks every edit is named in the refusal', async () => {
  await withDocument(site, { content: olderAccordion }, async ({ blockwork, doc: opened }) => {
    const result = await blockwork.edit({
      edits: [
        {
          op: 'update',
          client_id: opened.blocks.at(-1).client_id,
          attributes: { content: 'Changed' },
        },
      ],
    });
    const { rewritten_blocks: named, rewritten_block_count: count } = result.diagnostics;

    assert.equal(result.error, 'initial_serialization_changed', JSON.stringify(result));
    assert.ok(named.length > 0 && named.every((item) => item.name.startsWith('core/accordion')));
    assert.equal(count, named.length);
    assert.match(result.hint, /re-saving/);
  });
});

// A save drops this character because it sits outside the parsed block HTML.
test('older delimiters beside a character the save would drop stay refused', async () => {
  await withDocument(
    site,
    {
      content: doc(
        paragraph('Keep'),
        '<!-- wp:paragraph {"align":"center"} -->\n\u00a0<p class="has-text-align-center">Older</p>\n<!-- /wp:paragraph -->',
      ),
    },
    async ({ blockwork, doc: opened }) => {
      const edited = await blockwork.edit({
        edits: [
          {
            op: 'update',
            client_id: opened.blocks[0].client_id,
            attributes: { content: 'Changed' },
          },
        ],
      });

      assert.equal(edited.error, 'initial_serialization_changed', JSON.stringify(edited));
    },
  );
});

// The user can't review a change to block delimiters in the editor.
test('older delimiters with unchanged HTML save without the hand-off', async () => {
  const html = '<p class="has-text-align-center">Older</p>';

  await withDocument(
    site,
    {
      content: doc(
        paragraph('Keep'),
        `<!-- wp:paragraph {"align":"center"} -->\n${html}\n<!-- /wp:paragraph -->`,
      ),
    },
    async ({ blockwork, doc: opened, id, before }) => {
      const edited = await blockwork.edit({
        edits: [
          {
            op: 'update',
            client_id: opened.blocks[0].client_id,
            attributes: { content: 'Changed' },
          },
        ],
      });

      assert.equal(edited.ok, true, JSON.stringify(edited));
      assert.deepEqual(edited.rewritten_blocks, [
        { path: [1], name: 'core/paragraph', client_id: opened.blocks[1].client_id },
      ]);
      assert.equal(edited.rewritten_block_count, 1);

      const saved = await blockwork.save();
      assert.equal(saved.persistence, 'verified', JSON.stringify(saved));

      const stored = (await storedDocument(site, id)).content;
      assert.notEqual(stored, before.content.replace('Keep', 'Changed'));
      assert.ok(stored.includes('Changed') && stored.includes(html), stored);
    },
  );
});

for (const existing of [false, true]) {
  test(
    `copying a footnote with explicit source bodies into a document with existing notes ${existing}`,
    async () => {
      const reference = paragraph(
        'Copied<sup data-fn="fn_source" class="fn"><a href="#fn_source" id="fn_source-link">1</a></sup>',
      );
      const sourceBody = { id: 'fn_source', content: 'Source note' };
      let sourceRead;
      await withDocument(
        site,
        {
          content: doc(reference, block('footnotes')),
          meta: { footnotes: JSON.stringify([sourceBody]) },
        },
        async ({ blockwork, doc: connected }) => {
          sourceRead = await blockwork.read({
            blocks: { client_id: connected.blocks[0].client_id, markup: true },
            settings: true,
          });
          assert.equal(sourceRead.ok, true, JSON.stringify(sourceRead));
        },
      );
      const destinationReference = paragraph(
        'Destination<sup data-fn="fn_destination" class="fn"><a href="#fn_destination" id="fn_destination-link">1</a></sup>',
      );
      const destinationBody = { id: 'fn_destination', content: 'Destination note' };
      const destinationContent = existing ? doc(destinationReference, block('footnotes')) : anchor;
      const destinationMeta = existing ? { footnotes: JSON.stringify([destinationBody]) } : {};
      await withDocument(
        site,
        { content: destinationContent, meta: destinationMeta },
        async ({ blockwork, id, before }) => {
          const destinationRead = await blockwork.read({ settings: true });
          assert.equal(destinationRead.ok, true, JSON.stringify(destinationRead));
          const bodies = [
            ...JSON.parse(destinationRead.settings.values.meta.footnotes || '[]'),
            ...JSON.parse(sourceRead.settings.values.meta.footnotes),
          ];
          const edits = [{ op: 'insert', markup: sourceRead.markup }];

          if (!existing) {
            edits.push({ op: 'insert', block: { name: 'core/footnotes' } });
          }

          const result = await blockwork.edit({
            edits,
            settings: { meta: { footnotes: JSON.stringify(bodies) } },
          });
          assert.equal(result.editor_result, 'applied', JSON.stringify(result));
          assert.equal(result.footnote_writes.source, 'settings');
          const { after } = await assertSavedCleanly(site, id, before, await blockwork.save(), {
            allow: ['meta'],
          });
          assert.deepEqual(JSON.parse(after.meta.footnotes[0]), bodies);
          assert.equal(
            after.content,
            existing
              ? doc(destinationContent, reference.replace('>1</a>', '>2</a>'))
              : doc(anchor, reference, block('footnotes')),
          );
        },
      );
    },
  );
}


test('plain root insertion and sequential path movement preserve existing Footnotes', async () => {
  const reference = paragraph('Noted<sup data-fn="fn_plain" class="fn"><a href="#fn_plain" id="fn_plain-link">1</a></sup>');
  await withDocument(site, {
    content: doc(reference, anchor, block('footnotes')),
    meta: { footnotes: JSON.stringify([{ id: 'fn_plain', content: 'Unchanged note' }]) },
  }, async ({ blockwork, id, before }) => {
    const result = await blockwork.edit({ edits: [
      { op: 'insert', index: 0, block: { name: 'core/paragraph', attributes: { content: 'New plain paragraph' } } },
      { op: 'move', path: [0], index: 2 },
    ] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.footnote_writes, undefined);
    const { after } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.deepEqual(after.meta.footnotes, before.meta.footnotes);
    const tree = (await storedTree(site, id)).filter(item => item.blockName);
    assert.match(tree[2].innerHTML, /New plain paragraph/);
  });
});

const noteA = { id: 'note_a', content: 'Original note' };
const noteB = { id: 'note_b', content: 'New footnote body' };
const ref = (id, number) =>
  `<sup data-fn="${id}" class="fn"><a href="#${id}" id="${id}-link">${number}</a></sup>`;
const footnoteSettings = (bodies) => ({ meta: { footnotes: JSON.stringify(bodies) } });
const footnoteInsert = { op: 'insert', block: { name: 'core/footnotes' } };
const footnoteUpdate = (path, content) => ({ op: 'update', path, attributes: { content } });
const paired = (path, content, bodies = [noteB]) => ({
  edits: [footnoteUpdate(path, content), footnoteInsert],
  settings: footnoteSettings(bodies),
});
const draftSnapshot = (tab) =>
  site.evaluate(
    tab,
    `(() => {
  const editor = wp.data.select('core/editor');
  const store = wp.data.select('core/block-editor');
  return JSON.parse(JSON.stringify({ blocks: store.getBlocks(),
    meta: editor.getEditedPostAttribute('meta'), dirty: editor.isEditedPostDirty(),
    pending_keys: Object.keys(wp.data.select('core').getEntityRecordNonTransientEdits('postType', editor.getCurrentPostType(), editor.getCurrentPostId())).sort(),
    selection: [store.getSelectionStart(), store.getSelectionEnd(), store.getSelectedBlocksInitialCaretPosition()] }));
})()`,
  );
const clientAt = (tab, path) =>
  site.evaluate(
    tab,
    `(() => {
  let blocks = wp.data.select('core/block-editor').getBlocks(); let block;
  for (const index of ${JSON.stringify(path)}) { block = blocks[index]; blocks = block.innerBlocks; }
  return block.clientId;
})()`,
  );
const nativeContent = (expression) => serializeNatively(site, expression);
const nestedContent = () =>
  nativeContent(`[
  wp.blocks.createBlock('core/group', {}, [
    wp.blocks.createBlock('core/paragraph', {content:'Neighbor'}),
    wp.blocks.createBlock('core/columns', {}, [wp.blocks.createBlock('core/column', {}, [
      wp.blocks.createBlock('core/group', {}, [
        wp.blocks.createBlock('core/paragraph', {content:'Other'}),
        wp.blocks.createBlock('core/group', {}, [wp.blocks.createBlock('core/paragraph', {content:'Claim.'})])
      ])
    ])])
  ])
]`);
const deepPath = [0, 1, 0, 0, 1, 0];
const expectApplied = (result) => assert.equal(result.ok, true, JSON.stringify(result));

async function refusedUnchanged({ blockwork, tab, id, before }, request, constraint) {
  const snapshot = await draftSnapshot(tab);
  const result = await blockwork.edit(request);
  await assertRefused(site, id, before, result);
  assert.equal(result.editor_result, 'not_applied', JSON.stringify(result));

  if (
    ['footnote_body_order', 'footnote_reference_number', 'footnote_list_missing', 'footnote_request_incomplete'].includes(
      result.diagnostics?.constraint,
    )
  ) {
    assert.equal(result.next, 'correct_request', JSON.stringify(result));
  }

  if (constraint) assert.equal(result.diagnostics?.constraint, constraint, JSON.stringify(result));
  assert.deepEqual(await draftSnapshot(tab), snapshot);

  return result;
}

async function checkNeighborAfterReopen({ blockwork, id, target }, after, path) {
  await blockwork.release();
  const reopened = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);
  const caller = await site.createCaller(reopened);

  try {
    expectApplied(await caller.connect({ target, workflow: 'attached' }));
    expectApplied(await caller.edit({ edits: [footnoteUpdate(path, 'Neighbor changed')] }));
    await assertSavedCleanly(site, id, after, await caller.save({ save_all_pending: true }));
    assert.equal((await storedDocument(site, id)).meta.footnotes[0], after.meta.footnotes[0]);
  } finally {
    await caller.release();
    await reopened.close();
  }
}

for (const workflow of ['background', 'attached']) {
  test(
    `footnote pairing: deep insertion saves and survives neighbor edit in ${workflow}`,
    async () => {
      const content = await nestedContent();
      await withDocument(
        site,
        { content },
        async (context) => {
          const { blockwork, tab, id, before } = context;
          const client_id = await clientAt(tab, deepPath);
          const request = paired(deepPath, `Claim.${ref('note_b', 1)}`);
          request.edits[0] = { op: 'update', client_id, attributes: request.edits[0].attributes };
          expectApplied(await blockwork.edit(request));
          const { after } = await assertSavedCleanly(
            site,
            id,
            before,
            await blockwork.save(workflow === 'attached' ? { save_all_pending: true } : {}),
            { allow: ['meta'] },
          );
          assert.equal(after.meta.footnotes[0], JSON.stringify([noteB]));
          const tree = await storedTree(site, id);
          assert.equal(tree.at(-1).blockName, 'core/footnotes');
          assert.match((await frontEnd(site, id)).html, /New footnote body/);
          await checkNeighborAfterReopen(context, after, [0, 0]);
        },
        { workflow },
      );
    },
  );
}

for (const [label, expression, path, useClient] of [
  [
    'depth 2 by path',
    "[wp.blocks.createBlock('core/group',{},[wp.blocks.createBlock('core/paragraph',{content:'Claim.'})])]",
    [0, 0],
    false,
  ],
  [
    'depth 3 by client id',
    "[wp.blocks.createBlock('core/group',{},[wp.blocks.createBlock('core/group',{},[wp.blocks.createBlock('core/paragraph',{content:'Claim.'})])])]",
    [0, 0, 0],
    true,
  ],
  [
    'collapsed accordion panel',
    "[wp.blocks.createBlock('core/accordion',{},[wp.blocks.createBlock('core/accordion-item',{},[wp.blocks.createBlock('core/accordion-heading',{title:'More'}),wp.blocks.createBlock('core/accordion-panel',{},[wp.blocks.createBlock('core/paragraph',{content:'Claim.'})])])])]",
    [0, 0, 1, 0],
    false,
  ],
]) {
  test(
    `footnote pairing: ${label}`,
    async () => {
      const content = await nativeContent(expression);
      await withDocument(site, { content }, async ({ blockwork, tab, id, before }) => {
        if (label === 'collapsed accordion panel') {
          const paragraphId = await clientAt(tab, path);
          const accordionId = await clientAt(tab, [0]);
          const hidden = await site.evaluate(
            tab,
            `(() => {
          const docs = [document, ...Array.from(document.querySelectorAll('iframe'), frame => frame.contentDocument).filter(Boolean)];
          const node = docs.map(doc => doc.querySelector('[data-block="${paragraphId}"]')).find(Boolean);
          return { accordion: docs.some(doc => doc.querySelector('[data-block="${accordionId}"]')), visible: !!node?.getClientRects().length };
        })()`,
          );
          assert.deepEqual(hidden, { accordion: true, visible: false });
        }

        const request = paired(path, `Claim.${ref('note_b', 1)}`);

        if (useClient)
          request.edits[0] = {
            op: 'update',
            client_id: await clientAt(tab, path),
            attributes: request.edits[0].attributes,
          };
        expectApplied(await blockwork.edit(request));
        const { after } = await assertSavedCleanly(site, id, before, await blockwork.save(), {
          allow: ['meta'],
        });
        assert.equal(after.meta.footnotes[0], JSON.stringify([noteB]));
      });
    },
  );
}

for (const location of ['root paragraph', 'nested paragraph', 'nested Footnotes block']) {
  test(
    `footnote pairing: second note with existing block and ${location}`,
    async () => {
      const first = paragraph(`First${ref('note_a', 1)}`);
      const second =
        location === 'nested paragraph' ? group(paragraph('Second')) : paragraph('Second');
      const list =
        location === 'nested Footnotes block' ? group(block('footnotes')) : block('footnotes');
      await withDocument(
        site,
        { content: doc(first, second, list), meta: { footnotes: JSON.stringify([noteA]) } },
        async ({ blockwork, id, before }) => {
          const result = await blockwork.edit({
            edits: [
              footnoteUpdate(
                location === 'nested paragraph' ? [1, 0] : [1],
                `Second${ref('note_b', 2)}`,
              ),
            ],
            settings: footnoteSettings([noteA, noteB]),
          });
          expectApplied(result);
          const { after } = await assertSavedCleanly(site, id, before, await blockwork.save(), {
            allow: ['meta'],
          });
          assert.equal(after.meta.footnotes[0], JSON.stringify([noteA, noteB]));
          assert.match(after.content, new RegExp(ref('note_b', 2)));
        },
      );
    },
  );
}

for (const both of [true, false]) {
  test(
    `footnote pairing: insert before existing reference ${both ? 'with renumbering' : 'without renumbering'}`,
    async () => {
      await withDocument(
        site,
        {
          content: doc(
            paragraph('First'),
            paragraph(`Second${ref('note_a', 1)}`),
            block('footnotes'),
          ),
          meta: { footnotes: JSON.stringify([noteA]) },
        },
        async (context) => {
          const edits = [footnoteUpdate([0], `First${ref('note_b', 1)}`)];

          if (both) edits.push(footnoteUpdate([1], `Second${ref('note_a', 2)}`));
          const request = { edits, settings: footnoteSettings([noteB, noteA]) };

          if (!both) {
            const result = await refusedUnchanged(context, request);
            assert.match(JSON.stringify(result.diagnostics), /note_a/);

            return;
          }

          expectApplied(await context.blockwork.edit(request));
          const { after } = await assertSavedCleanly(
            site,
            context.id,
            context.before,
            await context.blockwork.save(),
            { allow: ['meta'] },
          );
          assert.equal(after.meta.footnotes[0], JSON.stringify([noteB, noteA]));
          assert.ok(after.content.includes(ref('note_a', 2)));
        },
      );
    },
  );
}

for (const [label, bodies, number] of [
  ['wrong body order', [noteB, noteA], 2],
  ['wrong reference number', [noteA, noteB], 1],
  ['missing body', [noteA], 2],
  ['extra body', [noteA, noteB, { id: 'extra', content: 'Extra' }], 2],
]) {
  test(
    `footnote pairing: refuses ${label} before mutation`,
    async () => {
      await withDocument(
        site,
        {
          content: doc(
            paragraph(`First${ref('note_a', 1)}`),
            paragraph('Second'),
            block('footnotes'),
          ),
          meta: { footnotes: JSON.stringify([noteA]) },
        },
        async (context) => {
          await refusedUnchanged(context, {
            edits: [footnoteUpdate([1], `Second${ref('note_b', number)}`)],
            settings: footnoteSettings(bodies),
          });
        },
      );
    },
  );
}

for (const workflow of ['background', 'attached']) {
  for (const pending of [false, true]) {
    test(
      `footnote pairing: revert nested insertion in ${workflow} with pending ${pending}`,
      async () => {
        const content = await nestedContent();
        await withDocument(
          site,
          { content },
          async ({ blockwork, tab }) => {
            if (pending) {
              await site.evaluate(
                tab,
                "wp.data.dispatch('core/block-editor').updateBlockAttributes(wp.data.select('core/block-editor').getBlocks()[0].innerBlocks[0].clientId,{content:'Pending neighbor'})",
              );
              expectApplied(await blockwork.read({ blocks: 'all', settings: true }));
            }

            const before = await draftSnapshot(tab);
            expectApplied(await blockwork.edit(paired(deepPath, `Claim.${ref('note_b', 1)}`)));
            expectApplied(await blockwork.revert());
            assert.deepEqual(await draftSnapshot(tab), before);
          },
          { workflow },
        );
      },
    );
  }
}

for (const [label, attributes] of [
  ['template lock all', { templateLock: 'all' }],
  [
    'content-only pattern section',
    { metadata: { patternName: 'bw/section', name: 'Section' }, templateLock: 'contentOnly' },
  ],
]) {
  test(
    `footnote pairing: ${label} permits paragraph content`,
    async () => {
      const content = await nativeContent(
        `[wp.blocks.createBlock('core/group',${JSON.stringify(attributes)},[wp.blocks.createBlock('core/paragraph',{content:'Claim.'})])]`,
      );
      await withDocument(site, { content }, async ({ blockwork, id, before }) => {
        expectApplied(await blockwork.edit(paired([0, 0], `Claim.${ref('note_b', 1)}`)));
        const { after } = await assertSavedCleanly(site, id, before, await blockwork.save(), {
          allow: ['meta'],
        });
        assert.equal(after.meta.footnotes[0], JSON.stringify([noteB]));
        const tree = await storedTree(site, id);

        for (const [key, value] of Object.entries(attributes))
          assert.deepEqual(tree[0].attrs[key], value);
      });
    },
  );
}

const unsupported = [
  [
    'unrelated title setting',
    {
      edits: [footnoteUpdate([0], `Claim.${ref('note_b', 1)}`), footnoteInsert],
      settings: footnoteSettings([noteB]),
      post: { title: 'Changed' },
    },
  ],
  [
    'additional paragraph attribute',
    {
      edits: [
        {
          ...footnoteUpdate([0], `Claim.${ref('note_b', 1)}`),
          attributes: { content: `Claim.${ref('note_b', 1)}`, dropCap: true },
        },
        footnoteInsert,
      ],
      settings: footnoteSettings([noteB]),
    },
  ],
  [
    'missing Footnotes insert',
    {
      edits: [footnoteUpdate([0], `Claim.${ref('note_b', 1)}`)],
      settings: footnoteSettings([noteB]),
    },
  ],
  [
    'Footnotes insert with parent',
    {
      edits: [
        footnoteUpdate([0, 0], `Claim.${ref('note_b', 1)}`),
        { ...footnoteInsert, parent: [0] },
      ],
      settings: footnoteSettings([noteB]),
    },
    group(paragraph('Claim.')),
  ],
  [
    'heading update with meta',
    {
      edits: [footnoteUpdate([0], `Claim.${ref('note_b', 1)}`)],
      settings: footnoteSettings([noteB]),
    },
    block('heading', undefined, '<h2 class="wp-block-heading">Claim.</h2>'),
  ],
  [
    'heading update without meta',
    { edits: [footnoteUpdate([0], `Claim.${ref('note_b', 1)}`)] },
    block('heading', undefined, '<h2 class="wp-block-heading">Claim.</h2>'),
  ],
  [
    'heading insert with reference',
    {
      edits: [
        {
          op: 'insert',
          block: { name: 'core/heading', attributes: { content: `Claim.${ref('note_b', 1)}` } },
        },
      ],
    },
  ],
  [
    'paragraph update without settings',
    { edits: [footnoteUpdate([0], `Claim.${ref('note_b', 1)}`)] },
  ],
];

for (const [label, request, content = paragraph('Claim.')] of unsupported) {
  test(
    `footnote pairing: refuses unsupported ${label}`,
    async () => {
      await withDocument(site, { content }, async (context) => {
        const result = await refusedUnchanged(context, request);
        assert.notEqual(result.next, 'read_changed_blocks_do_not_replay');
        assert.ok(
          result.issues?.some((issue) => issue.path) ||
            result.diagnostics?.field ||
            result.diagnostics?.path ||
            result.diagnostics?.target_path ||
            Number.isInteger(result.diagnostics?.edit_index),
          JSON.stringify(result),
        );
      });
    },
  );
}

for (const action of ['neighbor update', 'footnoted text update', 'nested move', 'nested remove']) {
  test(`footnote pairing: existing references allow or refuse ${action}`, async () => {
    const text = `Noted${ref('note_a', 1)}`;
    await withDocument(
      site,
      {
        content: doc(group(paragraph(text)), paragraph('Neighbor'), block('footnotes')),
        meta: { footnotes: JSON.stringify([noteA]) },
      },
      async (context) => {
        const { blockwork, id, before } = context;
        const edit =
          action === 'neighbor update'
            ? footnoteUpdate([1], 'Neighbor changed')
            : action === 'footnoted text update'
              ? footnoteUpdate([0, 0], `Changed${ref('note_a', 1)}`)
              : action === 'nested move'
                ? { op: 'move', client_id: await clientAt(context.tab, [0, 0]), index: 1 }
                : { op: 'remove', client_id: await clientAt(context.tab, [0, 0]) };

        if (action.startsWith('nested')) {
          await refusedUnchanged(context, { edits: [edit] }, 'footnote_root_operations');

          return;
        }

        expectApplied(await blockwork.edit({ edits: [edit] }));
        const { after } = await assertSavedCleanly(site, id, before, await blockwork.save());
        assert.deepEqual(after.meta.footnotes, before.meta.footnotes);
      },
    );
  });
}

test(
  'footnote pairing: repeated IDs follow depth-first order and first occurrence numbering',
  async () => {
    await withDocument(
      site,
      {
        content: doc(
          group(paragraph(`First${ref('note_a', 1)}`)),
          paragraph('Second'),
          paragraph('Neighbor'),
          block('footnotes'),
        ),
        meta: { footnotes: JSON.stringify([noteA]) },
      },
      async (context) => {
        const { blockwork, id, before } = context;
        const request = {
          edits: [footnoteUpdate([1], `Second${ref('note_b', 2)} again${ref('note_a', 1)}`)],
          settings: footnoteSettings([noteA, noteB, noteA]),
        };
        expectApplied(await blockwork.edit(request));
        const { after } = await assertSavedCleanly(site, id, before, await blockwork.save(), {
          allow: ['meta'],
        });
        assert.equal(after.meta.footnotes[0], JSON.stringify([noteA, noteB, noteA]));
        assert.ok(after.content.includes(`Second${ref('note_b', 2)} again${ref('note_a', 1)}`));
        await checkNeighborAfterReopen(context, after, [2]);
      },
    );
  },
);

for (const [action, initial, updated, bodies, expected] of [
  ['removes a reference', `Claim.${ref('note_a', 1)}`, 'Claim.', [noteA], []],
  [
    'swaps two references',
    `Claim.${ref('note_a', 1)}${ref('note_b', 2)}`,
    `Claim.${ref('note_b', 1)}${ref('note_a', 2)}`,
    [noteA, noteB],
    [noteB, noteA],
  ],
]) {
  test(
    `footnote pairing: ${action} with the complete list`,
    async () => {
      await withDocument(
        site,
        {
          content: doc(paragraph(initial), block('footnotes')),
          meta: { footnotes: JSON.stringify(bodies) },
        },
        async ({ blockwork, id, before }) => {
          expectApplied(
            await blockwork.edit({
              edits: [footnoteUpdate([0], updated)],
              settings: footnoteSettings(expected),
            }),
          );
          const { after } = await assertSavedCleanly(site, id, before, await blockwork.save(), {
            allow: ['meta'],
          });
          assert.equal(after.meta.footnotes[0], JSON.stringify(expected));
          assert.equal(after.content, doc(paragraph(updated), block('footnotes')));
        },
      );
    },
  );
}

for (const [action, initial, updated, bodies] of [
  ['removal', `Claim.${ref('note_a', 1)}`, 'Claim.', [noteA]],
  [
    'swap',
    `Claim.${ref('note_a', 1)}${ref('note_b', 2)}`,
    `Claim.${ref('note_b', 1)}${ref('note_a', 2)}`,
    [noteA, noteB],
  ],
]) {
  test(
    `footnote pairing: refuses unsupported reference ${action} without settings`,
    async () => {
      await withDocument(
        site,
        {
          content: doc(paragraph(initial), block('footnotes')),
          meta: { footnotes: JSON.stringify(bodies) },
        },
        async (context) => {
          await refusedUnchanged(context, { edits: [footnoteUpdate([0], updated)] });
        },
      );
    },
  );
}

test('footnote pairing: a reference moved between paragraphs needs the complete list', async () => {
  await withDocument(
    site,
    {
      content: doc(paragraph(`First${ref('note_a', 1)}`), paragraph('Second'), block('footnotes')),
      meta: { footnotes: JSON.stringify([noteA]) },
    },
    async (context) => {
      const edits = [footnoteUpdate([0], 'First'), footnoteUpdate([1], `Second${ref('note_a', 1)}`)];
      const refused = await refusedUnchanged(context, { edits });
      assert.equal(refused.diagnostics.edit_index, 0, JSON.stringify(refused));
      expectApplied(
        await context.blockwork.edit({ edits, settings: footnoteSettings([noteA]) }),
      );
      const { after } = await assertSavedCleanly(
        site,
        context.id,
        context.before,
        await context.blockwork.save(),
        { allow: ['meta'] },
      );
      assert.equal(after.meta.footnotes[0], JSON.stringify([noteA]));
      assert.ok(after.content.includes(`Second${ref('note_a', 1)}`));
    },
  );
});

test(
  'footnote pairing: refuses a Footnotes insert when the block exists',
  async () => {
    await withDocument(
      site,
      {
        content: doc(
          paragraph(`First${ref('note_a', 1)}`),
          paragraph('Second'),
          block('footnotes'),
        ),
        meta: { footnotes: JSON.stringify([noteA]) },
      },
      async (context) => {
        const result = await refusedUnchanged(context, {
          edits: [footnoteUpdate([1], `Second${ref('note_b', 2)}`), footnoteInsert],
          settings: footnoteSettings([noteA, noteB]),
        });
        assert.equal(result.error, 'insertion_refused', JSON.stringify(result));
      },
    );
  },
);

test(
  'footnote pairing: a heading reference counts in the order',
  async () => {
    const heading = block(
      'heading',
      undefined,
      `<h2 class="wp-block-heading">First${ref('note_a', 1)}</h2>`,
    );
    await withDocument(
      site,
      {
        content: doc(heading, paragraph('Second'), paragraph('Neighbor'), block('footnotes')),
        meta: { footnotes: JSON.stringify([noteA]) },
      },
      async (context) => {
        const edits = [footnoteUpdate([1], `Second${ref('note_b', 2)}`)];
        await refusedUnchanged(context, { edits, settings: footnoteSettings([noteB, noteA]) });
        expectApplied(
          await context.blockwork.edit({ edits, settings: footnoteSettings([noteA, noteB]) }),
        );
        const { after } = await assertSavedCleanly(
          site,
          context.id,
          context.before,
          await context.blockwork.save(),
          { allow: ['meta'] },
        );
        assert.equal(after.meta.footnotes[0], JSON.stringify([noteA, noteB]));
        assert.ok(after.content.includes(ref('note_a', 1)));
        assert.ok(after.content.includes(ref('note_b', 2)));
        await checkNeighborAfterReopen(context, after, [2]);
      },
    );
  },
);

run();
