import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';

import { doc, heading, paragraph } from './blocks.mjs';
import { assertSavedCleanly, startEditingSite, withDocument } from './harness.mjs';

let site;
const { after, before, describe, generated, run, test } = editingTests(import.meta.url);
before(async () => {
  site = await startEditingSite();
});
after(() => site?.[Symbol.asyncDispose]());

// Text a person types, which has to reach the page whatever block holds it.
const typed = {
  plain: ['Plain words', 'Plain words'],
  ampersand: ['Black & Decker', 'Black & Decker'],
  less_than: ['Costs < $50', 'Costs < $50'],
  greater_than: ['Over > $50', 'Over > $50'],
  both_angles: ['1 < 2 > 0', '1 < 2 > 0'],
  double_quotes: ['say "hi"', 'say "hi"'],
  single_quotes: ["it's Bob's", "it's Bob's"],
  smart_quotes: ['“smart” ‘quotes’', '“smart” ‘quotes’'],
  accents: ['Crème brûlée à la carte', 'Crème brûlée à la carte'],
  cjk: ['日本語のテキスト', '日本語のテキスト'],
  arabic: ['نص عربي', 'نص عربي'],
  emoji: ['Launch 🚀 now', 'Launch 🚀 now'],
  family_emoji: ['Family 👨‍👩‍👧‍👦', 'Family 👨‍👩‍👧‍👦'],
  dashes: ['2020–2026 — done -- ok', '2020–2026 — done -- ok'],
  money: ['$1,000 & 50% off', '$1,000 & 50% off'],
  backslash: ['C:\\temp\\new', 'C:\\temp\\new'],
  dollars: ['Replace $1 and \\1', 'Replace $1 and \\1'],
  shortcode: ['[gallery ids="1,2"]', '[gallery ids="1,2"]'],
  curly_braces: ['{{ name }} {"a":1}', '{{ name }} {"a":1}'],
  url: ['https://example.test/a?b=1&c=2', 'https://example.test/a?b=1&c=2'],
  email: ['hello+tag@example.test', 'hello+tag@example.test'],
  trailing_space: ['Ends with space ', 'Ends with space '],
  double_space: ['Two  spaces', 'Two  spaces'],
  nbsp: ['Keep\u00a0together', 'Keep\u00a0together'],
};

// What a page already holds or an agent sends as HTML, which must save valid and stable.
const html = {
  strong: '<strong>Bold</strong> text',
  nested_formats: '<strong><em>Both</em></strong> text',
  link: '<a href="https://example.test/?a=1&amp;b=2">Link</a> text',
  link_bare_ampersand: '<a href="https://example.test/?a=1&b=2">Link</a> text',
  link_target: '<a href="https://example.test/" target="_blank" rel="noreferrer noopener">Link</a>',
  code_format: 'Run <code>npm i &amp;&amp; go</code>',
  sub_sup: 'H<sub>2</sub>O x<sup>2</sup>',
  line_break: 'Line one<br>Line two',
  text_color:
    '<mark style="background-color:rgba(0, 0, 0, 0);color:#c00" class="has-inline-color">Red</mark> text',
  entities: 'Copyright &copy; &mdash; caf&eacute; &#8217;',
  encoded_tag: 'Write &lt;div&gt; here',
  inline_image:
    'See <img class="wp-image-1" style="width:20px" src="https://example.test/a.png" alt=""> here',
};

// Text that looks like block syntax. Accepting or refusing are both fine, but it must
// never split the document or leave it invalid.
const hostile = {
  block_comment: '<!-- wp:paragraph -->Injected<!-- /wp:paragraph -->',
  closing_comment: 'Before <!-- /wp:paragraph --> after',
  html_comment: 'Before <!-- note --> after',
  more_tag: 'Before <!--more--> after',
  closing_paragraph: 'Before </p><p> after',
  script: 'Before <script>window.bw=1</script> after',
  unknown_tag: '<foo>Unknown</foo> tag',
  unclosed_tag: '<strong>Unclosed',
  php: '<?php echo 1; ?>',
};

const carriers = {
  paragraph: { name: 'core/paragraph', attribute: 'content' },
  heading: { name: 'core/heading', attribute: 'content', attributes: { level: 2 } },
  list_item: { name: 'core/list', child: { name: 'core/list-item', attribute: 'content' } },
  button: { name: 'core/buttons', child: { name: 'core/button', attribute: 'text' } },
  quote_citation: {
    name: 'core/quote',
    attribute: 'citation',
    inner: [{ name: 'core/paragraph', attributes: { content: 'Quoted' } }],
  },
  pullquote: { name: 'core/pullquote', attribute: 'value' },
  verse: { name: 'core/verse', attribute: 'content' },
  preformatted: { name: 'core/preformatted', attribute: 'content' },
  code: { name: 'core/code', attribute: 'content' },
  details_summary: {
    name: 'core/details',
    attribute: 'summary',
    inner: [{ name: 'core/paragraph', attributes: { content: 'Body' } }],
  },
  image_caption: {
    name: 'core/image',
    attribute: 'caption',
    attributes: { url: 'https://example.test/a.png' },
  },
  media_text_paragraph: {
    name: 'core/media-text',
    inner: [{ name: 'core/paragraph', attribute: 'content' }],
    nested: true,
  },
  cover_heading: {
    name: 'core/cover',
    attributes: { dimRatio: 50, customOverlayColor: '#000000', isUserOverlayColor: true },
    inner: [{ name: 'core/heading', attribute: 'content', attributes: { level: 2 } }],
    nested: true,
  },
  table_cell: { name: 'core/table', table: true },
};

// Builds the block a carrier holds text in, and finds that block's text in a tree.
function buildBlock(carrier, value) {
  if (carrier.table) {
    return {
      name: carrier.name,
      attributes: { body: [{ cells: [{ content: value, tag: 'td' }] }] },
    };
  }

  if (carrier.child) {
    return {
      name: carrier.name,
      inner_blocks: [
        { name: carrier.child.name, attributes: { [carrier.child.attribute]: value } },
      ],
    };
  }

  if (carrier.nested) {
    return {
      name: carrier.name,
      attributes: carrier.attributes,
      inner_blocks: carrier.inner.map((inner) => ({
        name: inner.name,
        attributes: { ...inner.attributes, [inner.attribute]: value },
      })),
    };
  }

  return {
    name: carrier.name,
    attributes: { ...carrier.attributes, [carrier.attribute]: value },
    inner_blocks: carrier.inner?.map((inner) => ({
      name: inner.name,
      attributes: inner.attributes,
    })),
  };
}

async function assertCanContinue(blockwork, leaf, name, mutated) {
  if (!leaf.selected || leaf.completed) return;
  const status = await blockwork.status();
  assert.equal(status.ok, true, JSON.stringify(status));

  if (
    mutated ||
    status.busy ||
    status.persistence === 'uncertain' ||
    ['partial', 'uncertain', 'running'].includes(status.last_request?.outcome)
  ) {
    throw new Error(`Cannot continue after ${name}: ${JSON.stringify(status)}`);
  }
}

describe('text sent through update', () => {
  for (const [carrierName, name, attribute] of [
    ['paragraph', 'core/paragraph', 'content'],
    ['heading', 'core/heading', 'content'],
  ]) {
    generated(`${carrierName} accepts what a person types`, { findings: [] }, async (t) => {
      if (!Object.keys(typed).some((name) => t.selected(name))) return;
      const seed = carrierName === 'paragraph' ? paragraph('Anchor') : heading('Anchor');

      await withDocument(
        site,
        { content: doc(seed) },
        async ({ blockwork, doc: opened, id, before }) => {
          let completed = false;
          const { client_id } = opened.blocks[0];
          assert.equal(opened.blocks[0].name, name);

          for (const [hazard, [value, visible]] of Object.entries(typed)) {
            let mutated = false;
            const leaf = await t.test(hazard, async () => {
              const result = await blockwork.edit({
                edits: [{ op: 'update', client_id, attributes: { [attribute]: value } }],
              });
              mutated = result.ok;
              assert.equal(result.ok, true, `${result.error}: ${result.hint}`);
              const read = await blockwork.read({ blocks: { search: visible, limit: 5 } });
              assert.ok(
                read.selection.total >= 1,
                `${JSON.stringify(visible)} is not in the editor's visible text`,
              );
            });
            await assertCanContinue(blockwork, leaf, hazard, mutated);
            completed ||= leaf.completed;
          }

          if (completed) {
            const saved = await blockwork.save();
            await assertSavedCleanly(site, id, before, saved);
          }
        },
      );
    });
  }
});

// Rich text is HTML, but a < that opens no complete tag is literal text. Dropping the
// words and reporting a verified save is the one wrong answer.
describe('angle brackets are never lost silently', () => {
  for (const [value, visible] of [
    ['if a<b then c', 'if a<b then c'],
    ['x<y and more', 'x<y and more'],
    ['5<10', '5<10'],
  ]) {
    test(`${value} reaches the stored page`, async () => {
      await withDocument(
        site,
        { content: doc(paragraph('Anchor')) },
        async ({ blockwork, id, before }) => {
          const result = await blockwork.edit({
            edits: [
              { op: 'insert', block: { name: 'core/paragraph', attributes: { content: value } } },
            ],
          });
          assert.equal(result.ok, true, JSON.stringify(result));
          const saved = await blockwork.save();
          const { after } = await assertSavedCleanly(site, id, before, saved);
          const decoded = after.content.replaceAll('&lt;', '<').replaceAll('&gt;', '>');
          assert.ok(
            decoded.includes(visible),
            `saved as verified without the requested text: ${after.content}`,
          );
        },
      );
    });
  }

  test('existing text with a greater-than sign survives a neighbor edit', async () => {
    const seed = doc(paragraph('One'), paragraph('Home > Products'));

    await withDocument(site, { content: seed }, async ({ blockwork, doc: opened, id, before }) => {
      const result = await blockwork.edit({
        edits: [
          {
            op: 'update',
            client_id: opened.blocks[0].client_id,
            attributes: { content: 'Changed' },
          },
        ],
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      const saved = await blockwork.save();
      const { after } = await assertSavedCleanly(site, id, before, saved);
      assert.ok(after.content.includes('Home'), after.content);
      assert.ok(after.content.includes('Products'), after.content);
    });
  });

  test('a new block with a greater-than sign can be inserted in any spelling', async () => {
    await withDocument(site, { content: doc(paragraph('Anchor')) }, async ({ blockwork }) => {
      for (const content of ['a > b', 'a &gt; b', 'a &#62; b']) {
        const result = await blockwork.edit({
          edits: [{ op: 'insert', block: { name: 'core/paragraph', attributes: { content } } }],
        });
        assert.equal(result.ok, true, JSON.stringify(result));
      }
    });
  });

  test('a page with an inserted greater-than sign takes a later edit after reopening', async () => {
    const id = await withDocument(
      site,
      { content: doc(paragraph('Anchor')) },
      async ({ blockwork, id: seeded, before }) => {
        const result = await blockwork.edit({
          edits: [
            { op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'a > b' } } },
          ],
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        await assertSavedCleanly(site, seeded, before, await blockwork.save());

        return seeded;
      },
    );
    const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);
    const caller = await site.createCaller(tab);

    try {
      const reopened = await caller.connect({
        target: { site_url: site.site, post_id: id, post_type: 'page' },
        workflow: 'background',
      });
      assert.equal(reopened.ok, true, JSON.stringify(reopened));
      const edited = await caller.edit({
        edits: [
          {
            op: 'update',
            client_id: reopened.blocks[0].client_id,
            attributes: { content: 'Changed' },
          },
        ],
      });
      assert.equal(edited.ok, true, JSON.stringify(edited));
    } finally {
      await caller.release().catch(() => undefined);
      await tab.close().catch(() => undefined);
    }
  });
});

for (const [carrierName, carrier] of Object.entries(carriers)) {
  describe(`text in ${carrierName}`, () => {
    generated(
      'typed text reaches the saved page, then the document reopens valid',
      { findings: [] },
      async (t) => {
        if (!Object.keys(typed).some((name) => t.selected(name))) return;
        await withDocument(
          site,
          { content: doc(paragraph('Anchor')) },
          async ({ blockwork, id, before }) => {
            let completed = false;

            for (const [name, [value, visible]] of Object.entries(typed)) {
              let mutated = false;
              const leaf = await t.test(name, async () => {
                const result = await blockwork.edit({
                  edits: [{ op: 'insert', block: buildBlock(carrier, value) }],
                });
                mutated = result.ok;
                assert.equal(result.ok, true, `${result.error}: ${result.hint}`);
                const read = await blockwork.read({ blocks: { search: visible, limit: 5 } });
                assert.ok(
                  read.selection.total >= 1,
                  `${JSON.stringify(visible)} is not in the editor's visible text`,
                );
              });
              await assertCanContinue(blockwork, leaf, name, mutated);
              completed ||= leaf.completed;
            }

            if (completed) {
              const saved = await blockwork.save();
              await assertSavedCleanly(site, id, before, saved);
            }
          },
        );
      },
    );

    generated(
      'formatted and existing HTML stays valid after saving',
      { findings: [] },
      async (t) => {
        if (!Object.keys(html).some((name) => t.selected(name))) return;
        await withDocument(
          site,
          { content: doc(paragraph('Anchor')) },
          async ({ blockwork, id, before }) => {
            let completed = false;

            for (const [name, value] of Object.entries(html)) {
              // A Button's text sits inside its own anchor, so core refuses a nested link.
              const refuses = carrierName === 'button' && value.includes('<a ');
              let mutated = false;
              const leaf = await t.test(name, async () => {
                const result = await blockwork.edit({
                  edits: [{ op: 'insert', block: buildBlock(carrier, value) }],
                });
                mutated = result.ok;
                assert.equal(result.ok, !refuses, `${result.error}: ${result.hint}`);
              });
              await assertCanContinue(blockwork, leaf, name, mutated);
              completed ||= leaf.completed;
            }

            if (completed) {
              const anchor = await blockwork.edit({
                edits: [
                  {
                    op: 'update',
                    path: [0],
                    name: 'core/paragraph',
                    attributes: { content: 'Changed anchor' },
                  },
                ],
              });
              assert.equal(anchor.ok, true, JSON.stringify(anchor));
              const saved = await blockwork.save();
              await assertSavedCleanly(site, id, before, saved);
            }
          },
        );
      },
    );

    generated(
      'text that looks like syntax never breaks the document',
      { findings: [] },
      async (t) => {
        if (!Object.keys(hostile).some((name) => t.selected(name))) return;
        await withDocument(
          site,
          { content: doc(paragraph('Anchor')) },
          async ({ blockwork, id, before }) => {
            let completed = false;

            for (const [name, value] of Object.entries(hostile)) {
              let mutated = false;
              const leaf = await t.test(name, async () => {
                const blocksBefore = (await blockwork.read({ blocks: 'roots' })).selection.total;
                const result = await blockwork.edit({
                  edits: [{ op: 'insert', block: buildBlock(carrier, value) }],
                });

                mutated = result.ok;

                if (!result.ok) {
                  assert.equal(result.editor_result, 'not_applied', JSON.stringify(result));
                  assert.ok(result.hint && result.next, 'a refusal needs a hint and a next step');

                  return;
                }

                const after = (await blockwork.read({ blocks: 'roots' })).selection.total;
                assert.equal(after, blocksBefore + 1, 'one insert must add one root block');
              });
              await assertCanContinue(blockwork, leaf, name, mutated);
              completed ||= leaf.completed;
            }

            if (completed) {
              const anchor = await blockwork.edit({
                edits: [
                  {
                    op: 'update',
                    path: [0],
                    name: 'core/paragraph',
                    attributes: { content: 'Changed anchor' },
                  },
                ],
              });
              assert.equal(anchor.ok, true, JSON.stringify(anchor));
              const saved = await blockwork.save();
              await assertSavedCleanly(site, id, before, saved);
            }
          },
        );
      },
    );
  });
}

run();
