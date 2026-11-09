import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';

const { after, before, generated, test, run } = editingTests(import.meta.url);
import { doc, group, paragraph } from './blocks.mjs';
import {
  assertRefused,
  assertSavedCleanly,
  frontEnd,
  startEditingSite,
  storedDocument,
  storedTree,
  waitFor,
  withDocument,
} from './harness.mjs';

let site;
before(async () => {
  site = await startEditingSite();
});
after(() => site?.[Symbol.asyncDispose]());

const ok = (result) => assert.equal(result.ok, true, JSON.stringify(result));

test('nested style updates preserve siblings and children across a save', async () => {
  const seed = doc(group(paragraph('Child')), paragraph('Other'));
  await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
    const roots = await blockwork.read({ blocks: 'roots' });
    const groupId = roots.blocks[0].client_id;
    const initial = await storedTree(site, id);
    ok(
      await blockwork.edit({
        edits: [
          {
            op: 'update',
            client_id: groupId,
            attributes: {
              style: {
                spacing: { padding: { top: '12px', bottom: '20px' } },
                color: { text: '#123456' },
              },
              className: 'example-class',
              anchor: 'example-anchor',
              metadata: { name: 'Styled group' },
            },
          },
        ],
      }),
    );
    ok(
      await blockwork.edit({
        edits: [
          {
            op: 'update',
            client_id: groupId,
            attributes: { style: { spacing: { padding: { top: '24px' } } } },
          },
        ],
      }),
    );
    const saved = await blockwork.save();
    await assertSavedCleanly(site, id, before, saved);
    const tree = (await storedTree(site, id)).filter((block) => block.blockName);
    assert.deepEqual(tree[0].innerBlocks, initial[0].innerBlocks);
    assert.deepEqual(tree[0].attrs.style.spacing.padding, { top: '24px', bottom: '20px' });
    assert.equal(tree[0].attrs.style.color.text, '#123456');
    assert.equal(tree[0].attrs.className, 'example-class');
    assert.equal(tree[0].attrs.anchor, 'example-anchor');
    assert.equal(tree[0].attrs.metadata.name, 'Styled group');
    const page = await frontEnd(site, id);
    assert.match(page.html, /padding-top:24px/);
    assert.match(page.html, /id="example-anchor"/);
  });
});

for (const op of ['update', 'update_style']) {
  test(`${op} unset removes nested overrides and prunes empty parents`, async () => {
    await withDocument(
      site,
      { content: paragraph('Styled') },
      async ({ blockwork, id, before }) => {
        const blockId = (await blockwork.read({ blocks: 'roots' })).blocks[0].client_id;
        ok(
          await blockwork.edit({
            edits: [
              {
                op: 'update',
                client_id: blockId,
                attributes: {
                  style: {
                    spacing: { margin: { top: '10px', bottom: '20px' } },
                    color: { text: '#123456' },
                  },
                },
              },
            ],
          }),
        );
        ok(
          await blockwork.edit({
            edits: [
              {
                op,
                client_id: blockId,
                unset: [
                  ['style', 'spacing', 'margin', 'top'],
                  ['style', 'color', 'text'],
                ],
              },
            ],
          }),
        );
        const saved = await blockwork.save();
        await assertSavedCleanly(site, id, before, saved);
        const tree = await storedTree(site, id);
        assert.deepEqual(tree[0].attrs.style, { spacing: { margin: { bottom: '20px' } } });
      },
    );
  });
}

test('responsive values survive base updates, markup replacement and moves', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('Responsive'), paragraph('Other')) },
    async ({ blockwork, id, before }) => {
      const blockId = (await blockwork.read({ blocks: 'roots' })).blocks[0].client_id;
      const original = {
        spacing: { padding: { top: '10px', bottom: '20px' } },
        '@mobile': { spacing: { padding: { top: '4px', bottom: '5px' } } },
        '@tablet': { spacing: { padding: { top: '7px' } } },
      };
      ok(
        await blockwork.edit({
          edits: [{ op: 'update', client_id: blockId, attributes: { style: original } }],
        }),
      );
      ok(
        await blockwork.edit({
          edits: [
            {
              op: 'update',
              client_id: blockId,
              attributes: { style: { spacing: { padding: { top: '30px' } } } },
              unset: [['style', '@mobile', 'spacing', 'padding', 'bottom']],
            },
          ],
        }),
      );
      const read = await blockwork.read({ blocks: { client_id: blockId, markup: true } });
      ok(read);
      const markup = read.markup.replace('Responsive', 'Responsive changed');
      ok(await blockwork.edit({ edits: [{ op: 'replace', client_id: blockId, markup }] }));
      const replacement = (await blockwork.read({ blocks: 'roots' })).blocks[0].client_id;
      ok(await blockwork.edit({ edits: [{ op: 'move', client_id: replacement, index: 1 }] }));
      const saved = await blockwork.save();
      await assertSavedCleanly(site, id, before, saved);
      const tree = (await storedTree(site, id)).filter((block) => block.blockName);
      assert.deepEqual(tree[1].attrs.style, {
        spacing: { padding: { top: '30px', bottom: '20px' } },
        '@mobile': { spacing: { padding: { top: '4px' } } },
        '@tablet': { spacing: { padding: { top: '7px' } } },
      });
    },
  );
});

generated('invalid style properties and values refuse without saving', async (t) => {
  await withDocument(
    site,
    { content: paragraph('Unchanged') },
    async ({ blockwork, id, before }) => {
      const blockId = (await blockwork.read({ blocks: 'roots' })).blocks[0].client_id;

      for (const [name, property, value] of [
        ['unknown property', ['style', 'unknown', 'value'], '1px'],
        ['unknown preset', ['textColor'], 'does-not-exist'],
        ['wrong type', ['style', 'color', 'text'], { value: 'red' }],
        [
          'unsupported control',
          ['style', 'background', 'backgroundImage'],
          { url: 'https://example.test/image.png' },
        ],
        ['unsupported edge', ['style', 'spacing', 'padding', 'diagonal'], '1px'],
      ]) {
        await t.test(name, async () => {
          const result = await blockwork.edit({
            edits: [{ op: 'update_style', client_id: blockId, set: [{ property, value }] }],
          });
          await assertRefused(site, id, before, result);
          assert.deepEqual(result.diagnostics.property, property);
          assert.ok(
            result.hint.includes(property.join('.')) ||
              result.hint.includes('diagnostics.property'),
            JSON.stringify(result),
          );
        });
      }
    },
  );
});

const styleCases = [
  ['text color', 'paragraph', ['style', 'color', 'text'], '#123456'],
  ['background color', 'heading', ['style', 'color', 'background'], '#fedcba'],
  ['gradient', 'group', ['style', 'color', 'gradient'], 'linear-gradient(90deg,#123456,#fedcba)'],
  ['font size', 'paragraph', ['style', 'typography', 'fontSize'], '12px'],
  ['font family', 'heading', ['style', 'typography', 'fontFamily'], 'serif'],
  ['font weight', 'button', ['style', 'typography', 'fontWeight'], '700'],
  ['line height', 'paragraph', ['style', 'typography', 'lineHeight'], '1.7'],
  ['letter spacing', 'heading', ['style', 'typography', 'letterSpacing'], '2px'],
  ['text transform', 'button', ['style', 'typography', 'textTransform'], 'uppercase'],
  ['decoration', 'paragraph', ['style', 'typography', 'textDecoration'], 'underline'],
  ...['top', 'right', 'bottom', 'left'].flatMap((side) => [
    [`padding ${side}`, 'column', ['style', 'spacing', 'padding', side], '17px'],
    [`margin ${side}`, 'group', ['style', 'spacing', 'margin', side], '13px'],
    [`border ${side}`, 'group', ['style', 'border', side, 'width'], '3px'],
    [`border color ${side}`, 'group', ['style', 'border', side, 'color'], '#654321'],
  ]),
  ['block gap', 'group', ['style', 'spacing', 'blockGap'], '19px'],
  ['border color', 'image', ['style', 'border', 'color'], '#123456'],
  ['border width', 'button', ['style', 'border', 'width'], '3px'],
  ['border radius', 'button', ['style', 'border', 'radius'], '7px'],
  ...['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].map((corner) => [
    `radius ${corner}`,
    'image',
    ['style', 'border', 'radius', corner],
    '11px',
  ]),
  ['minimum height', 'group', ['style', 'dimensions', 'minHeight'], '250px'],
  ['aspect ratio', 'group', ['style', 'dimensions', 'aspectRatio'], '16/9'],
  [
    'background image',
    'group',
    ['style', 'background', 'backgroundImage'],
    { url: 'https://example.test/background.png', source: 'file' },
  ],
  ['background size', 'group', ['style', 'background', 'backgroundSize'], 'contain'],
  ['background position', 'group', ['style', 'background', 'backgroundPosition'], '25% 75%'],
  ['background repeat', 'group', ['style', 'background', 'backgroundRepeat'], 'no-repeat'],
  ['link color', 'group', ['style', 'elements', 'link', 'color', 'text'], '#123456'],
  ['link hover', 'group', ['style', 'elements', 'link', ':hover', 'color', 'text'], '#654321'],
];
const atPath = (value, path) => path.reduce((current, key) => current?.[key], value);
const nested = (path, value) => path.reduceRight((child, key) => ({ [key]: child }), value);
const renderedChecks = [
  [0, 'color', 'rgb(18, 52, 86)'],
  [3, 'font-size', '12px'],
  [4, 'font-family', 'serif'],
  [5, 'font-weight', '700'],
  [7, 'letter-spacing', '2px'],
  [8, 'text-transform', 'uppercase'],
  [9, 'text-decoration-line', 'underline'],
];

let styleSeed;

async function assertCanContinue(blockwork, leaf, name) {
  if (leaf.completed) return;
  const status = await blockwork.status();
  ok(status);

  if (
    status.busy ||
    status.persistence === 'uncertain' ||
    ['partial', 'uncertain', 'running'].includes(status.last_request?.outcome)
  ) {
    throw new Error(`Cannot continue after ${name}: ${JSON.stringify(status)}`);
  }
}

for (const op of ['update', 'update_style']) {
  generated(`${op} native style matrix persists exact values`, async (t) => {
    const values = styleCases.flatMap((item, index) =>
      t.selected(item[0]) ? [{ item, index }] : [],
    );
    const renders = renderedChecks.flatMap((item, index) =>
      t.selected('rendered ' + item[1]) ? [{ item, index }] : [],
    );

    if (!values.length && !renders.length) return;

    if (!styleSeed) {
      await withDocument(site, { content: paragraph('Oracle') }, async ({ tab }) => {
        const cases = [...styleCases, ...renderedChecks.map(([index]) => styleCases[index])];
        styleSeed = await site.evaluate(
          tab,
          `wp.blocks.serialize(${JSON.stringify(cases)}.map(([, name]) => wp.blocks.createBlock('core/' + name, name === 'image' ? {url:'https://example.test/image.png',alt:''} : name === 'paragraph' || name === 'heading' ? {content:'Style example'} : name === 'button' ? {text:'Go'} : {})))`,
        );
      });
    }

    await withDocument(site, { content: styleSeed }, async ({ blockwork, tab, id, before }) => {
      const accepted = [];
      let changed = false;

      for (const {
        item: [label, name, property, value],
        index,
      } of values) {
        const leaf = await t.test(label, async () => {
          const guide = await blockwork.read({ style_guides: [{ name: `core/${name}` }] });
          ok(guide);
          const enabled = guide.style_guides[0].controls.some((control) => {
            if (!control.property.every((key, i) => property[i] === key)) return false;
            const edge = property.slice(control.property.length);

            return edge.length === 0
              ? !control.requires_edge
              : edge.length === 1 && control.edges?.includes(edge[0]);
          });
          const result = await blockwork.edit({
            edits: [
              op === 'update'
                ? { op, path: [index], attributes: nested(property, value) }
                : { op, path: [index], set: [{ property, value }] },
            ],
          });

          if (op === 'update_style' && !enabled) {
            await assertRefused(site, id, before, result);
            assert.ok(JSON.stringify(result).includes(property.at(-1)), JSON.stringify(result));

            return;
          }

          if (result.ok) changed = true;
          ok(result);
          const attributes = await site.evaluate(
            tab,
            `wp.data.select('core/block-editor').getBlocks()[${index}].attributes`,
          );
          assert.deepEqual(atPath(attributes, property), value);
          accepted.push([index, property, value]);
        });
        await assertCanContinue(blockwork, leaf, label);
      }

      for (const {
        item: [caseIndex, cssProperty, expected],
        index,
      } of renders) {
        const name = 'rendered ' + cssProperty;
        const leaf = await t.test(name, async () => {
          const [, , property, value] = styleCases[caseIndex];
          const path = [styleCases.length + index];
          const result = await blockwork.edit({
            edits: [
              op === 'update'
                ? { op, path, attributes: nested(property, value) }
                : { op, path, set: [{ property, value }] },
            ],
          });

          if (result.ok) changed = true;
          ok(result);
          const roots = (await blockwork.read({ blocks: 'roots' })).blocks;
          const measured = await blockwork.measure({
            blocks: [roots[path[0]].client_id],
            properties: [cssProperty],
          });
          ok(measured);
          assert.ok(
            measured.blocks[0].elements.some((element) => element.styles[cssProperty] === expected),
            JSON.stringify(measured.blocks[0]),
          );
        });
        await assertCanContinue(blockwork, leaf, name);
      }

      if (changed) {
        const { after: stored } = await assertSavedCleanly(
          site,
          id,
          before,
          await blockwork.save(),
        );
        const parsed = await site.evaluate(
          tab,
          `wp.blocks.parse(${JSON.stringify(stored.content)}).map(b => b.attributes)`,
        );

        for (const [index, property, value] of accepted)
          assert.deepEqual(atPath(parsed[index], property), value);

        if (accepted.some(([index]) => index === 0 || index === 1)) {
          const page = await frontEnd(site, id);
          assert.equal(page.status, 200);
          assert.match(page.html, /#123456|#fedcba/);
        }
      }
    });
  });
}

test('textAlign migration refuses with the replacement path', async () => {
  await withDocument(site, { content: paragraph('Aligned') }, async ({ blockwork, id, before }) => {
    const result = await blockwork.edit({
      edits: [{ op: 'update', path: [0], attributes: { textAlign: 'center' } }],
    });
    await assertRefused(site, id, before, result);
    assert.deepEqual(result.diagnostics.use_instead, ['style', 'typography', 'textAlign']);
  });
});

for (const op of ['update', 'update_style']) {
  test(`${op} base and responsive changes preserve other states and custom CSS`, async () => {
    await withDocument(
      site,
      { content: group(paragraph('Responsive child'), paragraph('Sibling')) },
      async ({ blockwork, id, before }) => {
        const initial = {
          spacing: { padding: { top: '20px' } },
          '@mobile': { spacing: { padding: { top: '4px', bottom: '5px' } } },
          '@tablet': { spacing: { padding: { top: '8px' } } },
          css: '& { outline: 1px solid red; }',
        };
        ok(
          await blockwork.edit({
            edits: [{ op: 'update', path: [0, 0], attributes: { style: initial } }],
          }),
        );
        const set = [
          ['style', 'spacing', 'padding', 'top'],
          ['style', '@mobile', 'spacing', 'padding', 'top'],
        ];

        for (const [index, property] of set.entries()) {
          ok(
            await blockwork.edit({
              edits: [
                op === 'update'
                  ? { op, path: [0, 0], attributes: nested(property, index ? '6px' : '30px') }
                  : { op, path: [0, 0], set: [{ property, value: index ? '6px' : '30px' }] },
              ],
            }),
          );
        }

        ok(
          await blockwork.edit({
            edits: [
              { op, path: [0, 0], unset: [['style', '@mobile', 'spacing', 'padding', 'bottom']] },
            ],
          }),
        );
        const child = (await blockwork.read({ blocks: 'all' })).blocks.find(
          (row) => row.path.join('.') === '0.0',
        );
        const selected = await blockwork.read({
          blocks: { client_id: child.client_id, markup: true },
        });
        ok(selected);
        ok(
          await blockwork.edit({
            edits: [
              {
                op: 'replace',
                path: [0, 0],
                markup: selected.markup.replace('Responsive child', 'Responsive changed'),
              },
            ],
          }),
        );
        ok(await blockwork.edit({ edits: [{ op: 'move', path: [0, 0], parent: [0], index: 1 }] }));
        ok(
          await blockwork.edit({
            edits: [
              {
                op: 'update',
                path: [0],
                attributes: { style: { spacing: { padding: { top: '40px' } } } },
              },
            ],
          }),
        );
        await assertSavedCleanly(site, id, before, await blockwork.save());
        const tree = await storedTree(site, id);
        assert.deepEqual(tree[0].innerBlocks[1].attrs.style, {
          ...initial,
          spacing: { padding: { top: '30px' } },
          '@mobile': { spacing: { padding: { top: '6px' } } },
        });
      },
    );
  });
}

for (const op of ['update', 'update_style']) {
  generated(`${op} presets clear competing custom values`, async (t) => {
    const cases = [
      ['textColor', ['style', 'color', 'text']],
      ['backgroundColor', ['style', 'color', 'background']],
      ['fontSize', ['style', 'typography', 'fontSize']],
      ['fontFamily', ['style', 'typography', 'fontFamily']],
      ['gradient', ['style', 'color', 'gradient']],
      ['borderColor', ['style', 'border', 'color']],
    ].filter(([attribute]) => t.selected(attribute));

    if (!cases.length) return;

    await withDocument(
      site,
      { content: doc(...cases.map(() => group(paragraph('Preset')))) },
      async ({ blockwork, id, before, tab }) => {
        let changed = false;

        for (const [index, [attribute, custom]] of cases.entries()) {
          const leaf = await t.test(attribute, async (subtest) => {
            const read = await blockwork.read({ style_guides: [{ name: 'core/group' }] });
            const control = read.style_guides[0].controls.find(
              (item) => item.preset_attribute === attribute,
            );
            const preset = read.style_catalogs?.[control?.preset_catalog]?.items[0];

            if (!preset) {
              subtest.skip('This theme and block expose no preset for this control.');

              return;
            }

            const customValue =
              attribute === 'fontSize'
                ? '23px'
                : attribute === 'fontFamily'
                  ? 'serif'
                  : attribute === 'gradient'
                    ? 'linear-gradient(red, blue)'
                    : '#123456';
            const setup = await blockwork.edit({
              edits: [{ op: 'update', path: [index], attributes: nested(custom, customValue) }],
            });

            if (setup.ok) changed = true;
            ok(setup);
            ok(
              await blockwork.edit({
                edits: [
                  op === 'update'
                    ? {
                        op,
                        path: [index],
                        attributes: { [attribute]: preset.slug },
                        unset: [custom],
                      }
                    : { op, path: [index], set: [{ property: [attribute], value: preset.slug }] },
                ],
              }),
            );
            const attrs = await site.evaluate(
              tab,
              `wp.data.select('core/block-editor').getBlocks()[${index}].attributes`,
            );
            assert.equal(attrs[attribute], preset.slug);
            assert.equal(atPath(attrs, custom), undefined);
            ok(
              await blockwork.edit({
                edits: [
                  op === 'update'
                    ? {
                        op,
                        path: [index],
                        attributes: nested(custom, customValue),
                        unset: [[attribute]],
                      }
                    : { op, path: [index], set: [{ property: custom, value: customValue }] },
                ],
              }),
            );
            const updated = await site.evaluate(
              tab,
              `wp.data.select('core/block-editor').getBlocks()[${index}].attributes`,
            );
            assert.equal(updated[attribute], undefined);
            assert.equal(atPath(updated, custom), customValue);
          });
          await assertCanContinue(blockwork, leaf, attribute);
        }

        if (changed) await assertSavedCleanly(site, id, before, await blockwork.save());
      },
    );
  });
}

generated('layout changes preserve nested content and child sizing', async (t) => {
  const cases = [];

  for (const op of ['update', 'update_style']) {
    for (const layout of [
      { type: 'constrained', contentSize: '640px', wideSize: '1000px' },
      {
        type: 'flex',
        orientation: 'vertical',
        justifyContent: 'center',
        verticalAlignment: 'center',
      },
      { type: 'grid', columnCount: 2 },
    ])
      cases.push({ name: op + ' ' + layout.type, op, layout });

    for (const align of ['wide', 'full'])
      cases.push({ name: op + ' alignment ' + align, op, align });
  }

  cases.push({ name: 'child sizing' });
  const selected = cases.filter((item) => t.selected(item.name));

  if (!selected.length) return;
  await withDocument(
    site,
    { content: doc(...selected.map(() => group(paragraph('One'), paragraph('Two')))) },
    async ({ blockwork, tab, id, before }) => {
      let changed = false;

      for (const [index, item] of selected.entries()) {
        const leaf = await t.test(item.name, async () => {
          const path = [index];
          const children = await site.evaluate(
            tab,
            'wp.blocks.serialize(wp.data.select("core/block-editor").getBlocks()[' +
              index +
              '].innerBlocks)',
          );
          const initial = await blockwork.edit({
            edits: [
              {
                op: 'update',
                path,
                attributes: {
                  layout: item.layout
                    ? { type: 'constrained', contentSize: '500px', wideSize: '900px' }
                    : { type: 'grid', columnCount: 2 },
                },
              },
            ],
          });

          if (initial.ok) changed = true;
          ok(initial);

          if (item.layout) {
            const unset = [
              'contentSize',
              'wideSize',
              'orientation',
              'justifyContent',
              'verticalAlignment',
              'columnCount',
            ].flatMap((key) => (key in item.layout ? [] : [['layout', key]]));
            ok(
              await blockwork.edit({
                edits: [
                  item.op === 'update'
                    ? { op: item.op, path, attributes: { layout: item.layout }, unset }
                    : {
                        op: item.op,
                        path,
                        set: Object.entries(item.layout).map(([key, value]) => ({
                          property: ['layout', key],
                          value,
                        })),
                        unset,
                      },
                ],
              }),
            );
            assert.deepEqual(
              await site.evaluate(
                tab,
                'wp.data.select("core/block-editor").getBlocks()[' + index + '].attributes.layout',
              ),
              item.layout,
            );
            assert.equal(
              await site.evaluate(
                tab,
                'wp.blocks.serialize(wp.data.select("core/block-editor").getBlocks()[' +
                  index +
                  '].innerBlocks)',
              ),
              children,
            );
          } else if (item.align) {
            ok(
              await blockwork.edit({
                edits: [
                  item.op === 'update'
                    ? { op: item.op, path, attributes: { align: item.align } }
                    : { op: item.op, path, set: [{ property: ['align'], value: item.align }] },
                ],
              }),
            );
            assert.equal(
              await site.evaluate(
                tab,
                'wp.data.select("core/block-editor").getBlocks()[' + index + '].attributes.align',
              ),
              item.align,
            );
          } else {
            ok(
              await blockwork.edit({
                edits: [
                  {
                    op: 'update',
                    path,
                    attributes: { layout: { type: 'flex', orientation: 'horizontal' } },
                    unset: [['layout', 'columnCount']],
                  },
                  {
                    op: 'update',
                    path: [index, 0],
                    attributes: { style: { layout: { flexSize: '200px', selfStretch: 'fixed' } } },
                  },
                ],
              }),
            );
            const child = (await blockwork.read({ blocks: 'all' })).blocks.find(
              (row) => row.path.join('.') === index + '.0',
            );
            const sized = await blockwork.measure({
              blocks: [child.client_id],
              properties: ['flex-basis'],
            });
            ok(sized);
            assert.equal(sized.blocks[0].elements[0].styles['flex-basis'], '200px');
          }
        });
        await assertCanContinue(blockwork, leaf, item.name);
      }

      if (changed) {
        await assertSavedCleanly(site, id, before, await blockwork.save());
        const tree = (await storedTree(site, id)).filter((item) => item.blockName);

        for (const [index, item] of selected.entries()) {
          if (item.align) assert.equal(tree[index].attrs.align, item.align);

          if (item.name === 'child sizing')
            assert.deepEqual(tree[index].innerBlocks[0].attrs.style.layout, {
              flexSize: '200px',
              selfStretch: 'fixed',
            });
        }
      }
    },
  );
});

generated(
  'explicit zero margin suppresses parent block gap on the front end',
  async (t) => {
    const selected = [
      ['update', '0'],
      ['update_style', '0'],
      ['update', 0],
      ['update_style', 0],
    ].filter(([op, value]) => t.selected(op + ' ' + JSON.stringify(value))); 

    if (!selected.length) return;
    await withDocument(
      site,
      { content: doc(...selected.map(() => group(paragraph('First'), paragraph('Second')))) },
      async ({ blockwork, id, before }) => {
        const renderedTab = await site.openTab('about:blank');

        try {
          for (const [index, [op, value]] of selected.entries()) {
            const leaf = await t.test(
              op + ' ' + JSON.stringify(value),
              {},
              async () => {
                ok(
                  await blockwork.edit({
                    edits: [
                      {
                        op: 'update',
                        path: [index],
                        attributes: { style: { spacing: { blockGap: '40px' } } },
                      },
                      op === 'update'
                        ? {
                            op,
                            path: [index, 1],
                            attributes: { style: { spacing: { margin: { top: value } } } },
                          }
                        : {
                            op,
                            path: [index, 1],
                            set: [{ property: ['style', 'spacing', 'margin', 'top'], value }],
                          },
                    ],
                  }),
                );
                await assertSavedCleanly(site, id, before, await blockwork.save());
                const tree = (await storedTree(site, id)).filter((item) => item.blockName);

                assert.match(tree[index].innerBlocks[1].innerHTML, /margin-top:0/);
                await renderedTab.goto(site.site + '/?page_id=' + id);
                await waitFor(
                  site,
                  renderedTab,
                  "document.querySelectorAll('.wp-block-post-content > .wp-block-group > p:nth-child(2)').length===" +
                    selected.length,
                );
                const rendered = await site.evaluate(
                  renderedTab,
                  "Array.from(document.querySelectorAll('.wp-block-post-content > .wp-block-group > p:nth-child(2)'),second=>({margin:getComputedStyle(second).marginTop,gap:second.getBoundingClientRect().top-second.previousElementSibling.getBoundingClientRect().bottom}))[" +
                    index +
                    ']',
                );
                assert.equal(rendered.margin, '0px');
                assert.ok(Math.abs(rendered.gap) < 0.1, JSON.stringify(rendered));
              },
            );
            await assertCanContinue(blockwork, leaf, op + ' ' + JSON.stringify(value));
          }
        } finally {
          await renderedTab.close();
        }
      },
    );
  },
);

test('Button hover and focus states reach saved CSS and capture_page', async () => {
  await withDocument(
    site,
    {
      content:
        '<!-- wp:buttons --><div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link wp-element-button">Go</a></div><!-- /wp:button --></div><!-- /wp:buttons -->',
    },
    async ({ blockwork, id, before, doc: opened }) => {
      ok(
        await blockwork.edit({
          edits: [
            {
              op: 'update',
              path: [0, 0],
              attributes: {
                className: 'is-style-bw-hover',
                style: {
                  color: { background: '#ff0000' },
                  ':hover': { color: { text: '#abcdef' } },
                  ':focus': { color: { text: '#fedcba' } },
                },
              },
            },
          ],
        }),
      );
      ok(
        await blockwork.edit({
          edits: [
            {
              op: 'update_style',
              path: [0, 0],
              set: [
                { property: ['style', ':hover', 'color', 'text'], value: '#123456' },
                { property: ['style', ':focus', 'color', 'text'], value: '#654321' },
              ],
            },
          ],
        }),
      );
      await assertSavedCleanly(site, id, before, await blockwork.save());
      const page = await frontEnd(site, id);
      assert.match(page.html, /background-color:#ff0000/);
      assert.match(page.html, /#123456/);
      assert.match(page.html, /#654321/);
      assert.match(page.html, /rgb\(0,\s*128,\s*0\)/);
      const tab = await site.openTab(opened.link);

      try {
        await waitFor(site, tab, "document.querySelector('.wp-block-button__link')");
        const front = await site.createCaller(tab);

        for (const pseudo of ['hover', 'focus']) {
          const captured = await front.capture_page({
            widths: ['desktop'],
            states: { selector: '.wp-block-button__link', pseudo: [pseudo] },
            measure: { selectors: ['.wp-block-button__link'] },
          });
          ok(captured);
          assert.equal(captured.shots.length, 1);
          assert.equal(captured.shots[0].elements[0].found, true);
          assert.equal(captured.shots[0].elements[0].styles['background-color'], 'rgb(255, 0, 0)');
          assert.equal(
            captured.shots[0].elements[0].styles.color,
            pseudo === 'hover' ? 'rgb(18, 52, 86)' : 'rgb(101, 67, 33)',
          );
        }
      } finally {
        await tab.close();
      }
    },
  );
});

test('an account without edit_css cannot silently strip existing instance CSS', async () => {
  let seed;
  await withDocument(site, { content: paragraph('CSS owner') }, async ({ tab }) => {
    seed = await site.evaluate(
      tab,
      "wp.blocks.serialize(wp.blocks.createBlock('core/paragraph',{content:'CSS owner',style:{css:'& { color: red; }'}}))",
    );
  });
  const encoded = Buffer.from(seed).toString('base64');
  const id = await site.php(`
    $previous = get_current_user_id();
    $admin = get_user_by('login','admin');
    wp_set_current_user($admin->ID);
    kses_remove_filters();
    $id = wp_insert_post(wp_slash(['post_type'=>'page','post_status'=>'publish','post_title'=>'CSS owner','post_author'=>$admin->ID,'post_content'=>base64_decode('${encoded}')]),true);
    wp_set_current_user($previous);
    if (is_wp_error($id)) {throw new Exception('Unable to seed CSS test document');}
    echo wp_json_encode($id);
  `);
  const before = await storedDocument(site, id);
  assert.equal(
    (await storedTree(site, id))[0].attrs.style?.css,
    '& { color: red; }',
    'The filtered account must start with persisted CSS.',
  );
  await site.php("update_option('bw_style_filtered_account',true);");
  await site.signIn('editor');
  const tab = await site.openTab(site.site + '/wp-admin/post.php?post=' + id + '&action=edit');
  const blockwork = await site.createCaller(tab);

  try {
    ok(
      await blockwork.connect({
        target: { site_url: site.site, post_id: id, post_type: 'page' },
        workflow: 'background',
      }),
    );
    const read = await blockwork.read({ style_guides: [{ name: 'core/paragraph' }] });
    ok(read);
    assert.equal(read.style_rules.custom_css.can_edit_css, false);
    assert.equal(read.style_rules.custom_css.document_has_custom_css, true);

    for (const op of ['update', 'update_style']) {
      const property = ['style', 'color', 'text'];
      const edit =
        op === 'update'
          ? { op, path: [0], attributes: nested(property, '#123456') }
          : { op, path: [0], set: [{ property, value: '#123456' }] };
      await assertRefused(site, id, before, await blockwork.edit({ edits: [edit] }), {
        error: 'custom_css_permission_required',
      });
    }

    const saved = await blockwork.save();
    ok(saved);
    assert.equal(saved.persistence, 'unchanged');
    assert.equal((await storedDocument(site, id)).content, before.content);
  } finally {
    await blockwork.release().catch(() => undefined);
    await tab.close();
    await site.signIn('admin');
    await site.php("delete_option('bw_style_filtered_account');");
  }
});

styleCases.push(
  ['cover padding', 'cover', ['style', 'spacing', 'padding', 'top'], '23px'],
  ['spacing preset', 'group', ['style', 'spacing', 'padding', 'bottom'], 'var:preset|spacing|40'],
  ['horizontal gap', 'group', ['style', 'spacing', 'blockGap', 'left'], '12px'],
  ['vertical gap', 'group', ['style', 'spacing', 'blockGap', 'top'], '14px'],
  ['shadow', 'group', ['style', 'shadow'], 'var:preset|shadow|natural'],
  ['width', 'group', ['style', 'dimensions', 'width'], '300px'],
  ['height', 'group', ['style', 'dimensions', 'height'], '200px'],
);

test('odd classes, duplicate anchors and one-key resets survive native serialization', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('First'), paragraph('Second')) },
    async ({ blockwork, id, before }) => {
      ok(
        await blockwork.edit({
          edits: [0, 1].map((index) => ({
            op: 'update',
            path: [index],
            attributes: {
              className: 'one:two slash/name dotted.name',
              anchor: 'duplicate',
              metadata: { name: 'Named example' },
              fontSize: 'large',
            },
          })),
        }),
      );
      ok(
        await blockwork.edit({
          edits: [
            { op: 'update', path: [0], unset: [['fontSize']] },
            { op: 'update_style', path: [1], unset: [['fontSize']] },
          ],
        }),
      );
      await assertSavedCleanly(site, id, before, await blockwork.save());
      const tree = (await storedTree(site, id)).filter((item) => item.blockName);
      assert.equal(tree[0].attrs.fontSize, undefined);

      for (const item of tree) {
        assert.equal(item.attrs.fontSize, undefined);
        assert.equal(item.attrs.className, 'one:two slash/name dotted.name');
        assert.equal(item.attrs.anchor, 'duplicate');
        assert.equal(item.attrs.metadata.name, 'Named example');
      }
    },
  );
});

test('Group, Columns and Cover parent styles preserve children byte for byte', async () => {
  let seed;
  await withDocument(site, { content: paragraph('Oracle') }, async ({ tab }) => {
    seed = await site.evaluate(
      tab,
      `(() => {
      const p = () => wp.blocks.createBlock('core/paragraph', {content:'Nested',style:{'@mobile':{color:{text:'#123456'}},'@tablet':{color:{text:'#654321'}}}});
      return wp.blocks.serialize([
        wp.blocks.createBlock('core/group', {}, [p()]),
        wp.blocks.createBlock('core/columns', {}, [wp.blocks.createBlock('core/column', {}, [p()])]),
        wp.blocks.createBlock('core/cover', {customOverlayColor:'#000000',isUserOverlayColor:true}, [p()])
      ]);
    })()`,
    );
  });
  await withDocument(site, { content: seed }, async ({ blockwork, id, before, tab }) => {
    const snapshot = await site.evaluate(
      tab,
      "wp.data.select('core/block-editor').getBlocks().map(b => wp.blocks.serialize(b.innerBlocks))",
    );

    for (const op of ['update', 'update_style']) {
      const property = ['style', 'spacing', 'padding', 'top'];
      ok(
        await blockwork.edit({
          edits: [0, 1, 2].map((index) =>
            op === 'update'
              ? { op, path: [index], attributes: nested(property, '21px') }
              : { op, path: [index], set: [{ property, value: '31px' }] },
          ),
        }),
      );
      assert.deepEqual(
        await site.evaluate(
          tab,
          "wp.data.select('core/block-editor').getBlocks().map(b => wp.blocks.serialize(b.innerBlocks))",
        ),
        snapshot,
      );
    }

    await assertSavedCleanly(site, id, before, await blockwork.save());
  });
});

// Core's Hide control writes metadata.blockVisibility, and the front end adds a
// class that hides the block at that width.
for (const [name, blockVisibility] of [
  ['one width', { viewport: { mobile: false } }],
  ['every width', false],
]) {
  test(`block visibility hides a block at ${name}`, async () => {
    await withDocument(
      site,
      { content: doc(paragraph('Keep'), paragraph('Hide me')) },
      async ({ blockwork, doc: opened, id, before }) => {
        const result = await blockwork.edit({
          edits: [
            {
              op: 'update',
              client_id: opened.blocks[1].client_id,
              attributes: { metadata: { blockVisibility } },
            },
          ],
        });

        ok(result);
        await assertSavedCleanly(site, id, before, await blockwork.save());
        const stored = await storedDocument(site, id);

        assert.ok(stored.content.includes('blockVisibility'), stored.content);
      },
    );
  });
}

run();
