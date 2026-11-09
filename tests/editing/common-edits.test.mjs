import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';

import { button, buttons, doc, group, heading, list, listItem, paragraph } from './blocks.mjs';
import {
  assertRefused,
  assertSavedCleanly,
  changedPaths,
  frontEnd,
  seedDocument,
  seedImage,
  startEditingSite,
  storedTree,
  waitFor,
  withDocument,
} from './harness.mjs';

let site;
let serializer;
const { after, before, test, run } = editingTests(import.meta.url);

before(async () => {
  site = await startEditingSite();
});
after(async () => {
  await serializer?.close();
  await site?.[Symbol.asyncDispose]();
});

const success = (result) => assert.equal(result.ok, true, JSON.stringify(result));
const page = () =>
  doc(
    group(
      heading('Welcome'),
      paragraph('A clear plan for your work.'),
      buttons(button('Start', '/start/')),
    ),
    group(
      heading('Services'),
      paragraph('A clear plan for your work.'),
      list(listItem('Planning'), listItem('Delivery'), listItem('Support')),
    ),
    group(heading('Contact'), paragraph('A clear plan for your work.')),
  );

const jobs = [
  {
    name: 'change the heading and button together',
    edits: [
      { op: 'update', path: [0, 0], attributes: { content: 'Welcome aboard' } },
      { op: 'update', path: [0, 2, 0], attributes: { text: 'Contact us', url: '/contact/' } },
    ],
    paths: ['0.0', '0.2.0'],
    expected: () =>
      page()
        .replace('Welcome</h2>', 'Welcome aboard</h2>')
        .replace('href="/start/">Start', 'href="/contact/">Contact us'),
    visible: ['Welcome aboard', 'href="/contact/">Contact us'],
  },
  {
    name: 'change repeated text only in the services section',
    edits: [
      { op: 'update', path: [1, 1], attributes: { content: 'A practical plan for your work.' } },
    ],
    paths: ['1.1'],
    expected: () =>
      page().replace(
        'Services</h2>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph -->\n<p>A clear',
        'Services</h2>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph -->\n<p>A practical',
      ),
    visible: ['A practical plan for your work.', 'A clear plan for your work.'],
  },
  {
    name: 'add remove and reorder service list items',
    edits: [
      { op: 'remove', path: [1, 2, 1] },
      { op: 'move', path: [1, 2, 1], parent: [1, 2], index: 0 },
      {
        op: 'insert',
        parent: [1, 2],
        index: 2,
        block: { name: 'core/list-item', attributes: { content: 'Review' } },
      },
    ],
    paths: ['1.2.0', '1.2.1', '1.2.2'],
    expected: () =>
      page().replace(
        list(listItem('Planning'), listItem('Delivery'), listItem('Support')),
        list(listItem('Support'), listItem('Planning'), listItem('Review')),
      ),
    visible: ['<li>Support</li>', '<li>Planning</li>', '<li>Review</li>'],
  },
];

for (const job of jobs) {
  test(job.name, async () => {
    await withDocument(site, { content: page() }, async ({ blockwork, id, before }) => {
      const original = await storedTree(site, id);

      if (job.name.includes('repeated')) {
        const read = await blockwork.read({
          blocks: { search: 'A clear plan for your work.', attributes: true },
        });
        success(read);
        assert.equal(read.selection.total, 3);
        assert.deepEqual(
          read.blocks.map((block) => block.path),
          [
            [0, 1],
            [1, 1],
            [2, 1],
          ],
        );
      }

      success(await blockwork.edit({ edits: job.edits }));
      const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal(saved.content, job.expected());
      assert.deepEqual(changedPaths(original, await storedTree(site, id)), job.paths);
      const front = await frontEnd(site, id);
      assert.equal(front.status, 200);

      for (const text of job.visible) assert.ok(front.html.includes(text), text);
    });
  });
}

test('copy an FAQ and refine its question and answer', async () => {
  const faq =
    '<!-- wp:details -->\n<details class="wp-block-details"><summary>When can we start?</summary><!-- wp:paragraph -->\n<p>Contact us today.</p>\n<!-- /wp:paragraph --></details>\n<!-- /wp:details -->';
  const seed = doc(
    group(heading('Questions'), faq),
    group(heading('Contact'), paragraph('Get in touch.')),
  );
  await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    const read = await blockwork.read({
      blocks: {
        client_id: (await blockwork.read({ blocks: { search: 'core/details' } })).blocks[0]
          .client_id,
        markup: true,
      },
    });
    success(read);
    const copy = read.markup
      .replace('When can we start?', 'How do we prepare?')
      .replace('Contact us today.', 'Gather your project details.');
    success(await blockwork.edit({ edits: [{ op: 'insert', parent: [0], markup: copy }] }));
    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(saved.content, seed.replace(faq, `${faq}\n\n${copy}`));
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), ['0', '0.2']);
    const front = await frontEnd(site, id);
    assert.ok(front.html.includes('How do we prepare?'));
    assert.ok(front.html.includes('Gather your project details.'));
  });
});

test('copy a saved section from another page and retain its source', async () => {
  const section = group(heading('Our approach'), paragraph('We listen first.'));
  const source = await seedDocument(site, { content: doc(section, paragraph('Source only')) });
  const seed = doc(group(heading('Existing'), paragraph('Keep this section.')));
  await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    success(
      await blockwork.edit({
        edits: [
          { op: 'update', path: [0, 1], attributes: { content: 'Keep the edited section.' } },
        ],
      }),
    );
    const roots = await blockwork.read({ source: { post_id: source, post_type: 'page' } });
    success(roots);
    const read = await blockwork.read({
      source: { post_id: source, post_type: 'page' },
      blocks: { client_id: roots.blocks[0].client_id, depth: 3, markup: true },
    });
    success(read);
    assert.equal(read.markup, section);
    success(await blockwork.edit({ edits: [{ op: 'insert', markup: read.markup }] }));
    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(
      saved.content,
      doc(seed.replace('Keep this section.', 'Keep the edited section.'), section),
    );
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), ['0.1', '1']);
    assert.ok((await frontEnd(site, id)).html.includes('We listen first.'));
  });
});

test('build and refine a section before checking both preview widths', async () => {
  const seed = page();

  await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    const insert = await blockwork.edit({
      edits: [
        {
          op: 'insert',
          block: {
            name: 'core/group',
            attributes: { layout: { type: 'constrained' } },
            inner_blocks: [
              { name: 'core/heading', attributes: { content: 'Draft next steps' } },
              { name: 'core/paragraph', attributes: { content: 'Begin here.' } },
            ],
          },
        },
      ],
    });
    success(insert);
    success(
      await blockwork.edit({
        edits: [
          { op: 'update', path: [3, 1], attributes: { content: 'Contact our team to begin.' } },
        ],
      }),
    );
    success(
      await blockwork.edit({
        edits: [{ op: 'update', path: [3, 0], attributes: { content: 'Next steps' } }],
      }),
    );
    const roots = await blockwork.read({ blocks: 'roots' });
    const section = roots.blocks[3].client_id;

    for (const width of ['desktop', 'mobile']) {
      const measured = await blockwork.measure({ blocks: [section], width });
      success(measured);
      assert.equal(measured.blocks[0].rendered, true, JSON.stringify(measured));
      assert.ok(measured.blocks[0].elements[0].rect.width > 0);
    }

    const view = await blockwork.view({ client_id: section, widths: ['desktop', 'mobile'] });
    success(view);
    assert.equal(view.shots.length, 2);
    assert.ok(
      view.shots.every((shot) => shot.rendered && shot.image),
      JSON.stringify(view),
    );
    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(
      saved.content,
      doc(seed, group(heading('Next steps'), paragraph('Contact our team to begin.'))),
    );
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), ['3']);
    assert.ok((await frontEnd(site, id)).html.includes('Contact our team to begin.'));
  });
});

// The shapes agents reached for most often before reading the reference.
test('read by depth, measure by client_id, and unset by name all work', async () => {
  await withDocument(site, { content: page() }, async ({ blockwork, doc: opened }) => {
    const tree = await blockwork.read({ blocks: { depth: 2 } });
    success(tree);
    assert.ok(tree.blocks.some((block) => block.path.length === 2));
    assert.ok(tree.blocks.every((block) => block.path.length <= 2));
    assert.equal(tree.selection.depth_limited, true);
    const refused = await blockwork.read({ blocks: { depth: 2, markup: true } });
    assert.equal(refused.error, 'invalid_read', JSON.stringify(refused));

    const clientId = opened.blocks[0].client_id;
    const measured = await blockwork.measure({ client_id: clientId, width: 'mobile' });
    success(measured);
    assert.equal(measured.blocks[0].client_id, clientId);

    const heading = tree.blocks.find((block) => block.name === 'core/heading').client_id;
    success(
      await blockwork.edit({
        edits: [{ op: 'update', client_id: heading, attributes: { anchor: 'welcome' } }],
      }),
    );
    success(
      await blockwork.edit({ edits: [{ op: 'update', client_id: heading, unset: ['anchor'] }] }),
    );
    const read = await blockwork.read({ blocks: { client_id: heading, depth: 0 } });
    assert.equal(read.blocks[0].attributes.anchor, undefined);
  });
});

test('oversized inspection limits are clamped and reported', async () => {
  await withDocument(site, { content: page() }, async ({ blockwork, doc: opened }) => {
    const result = await blockwork.read({
      blocks: { client_id: opened.blocks[0].client_id, depth: 99, limit: 999 },
    });
    success(result);
    assert.deepEqual(result.selection.clamped, { depth: 8, limit: 50 });
  });
});

test('a guessed edit field is refused with a useful correction', async () => {
  await withDocument(site, { content: page() }, async ({ blockwork, id, before }) => {
    const result = await blockwork.edit({
      edits: [{ op: 'update', path: [0, 0], attribute: { content: 'New title' } }],
    });
    await assertRefused(site, id, before, result);
    assert.match(result.hint, /\battribute\b/i);
    assert.match(result.hint, /attributes/i);
  });
});

const sectionJobs = [
  {
    name: 'remove only the contact section',
    edits: [{ op: 'remove', path: [2] }],
    expected: () =>
      doc(
        group(
          heading('Welcome'),
          paragraph('A clear plan for your work.'),
          buttons(button('Start', '/start/')),
        ),
        group(
          heading('Services'),
          paragraph('A clear plan for your work.'),
          list(listItem('Planning'), listItem('Delivery'), listItem('Support')),
        ),
      ),
    paths: ['2'],
  },
  {
    name: 'move contact before services',
    edits: [{ op: 'move', path: [2], index: 1 }],
    expected: () =>
      doc(
        group(
          heading('Welcome'),
          paragraph('A clear plan for your work.'),
          buttons(button('Start', '/start/')),
        ),
        group(heading('Contact'), paragraph('A clear plan for your work.')),
        group(
          heading('Services'),
          paragraph('A clear plan for your work.'),
          list(listItem('Planning'), listItem('Delivery'), listItem('Support')),
        ),
      ),
    paths: ['1', '1.0', '1.2', '2', '2.0', '2.2'],
  },
  {
    name: 'bold and link phrases and promote the heading',
    edits: [
      { op: 'update', path: [0, 0], attributes: { level: 1 } },
      {
        op: 'update',
        path: [0, 1],
        attributes: {
          content: 'A <strong>clear plan</strong> for <a href="/work/">your work</a>.',
        },
      },
    ],
    expected: () =>
      page()
        .replace(heading('Welcome'), heading('Welcome', 1))
        .replace(
          paragraph('A clear plan for your work.'),
          paragraph('A <strong>clear plan</strong> for <a href="/work/">your work</a>.'),
        ),
    paths: ['0.0', '0.1'],
  },
];

for (const job of sectionJobs) {
  test(job.name, async () => {
    await withDocument(site, { content: page() }, async ({ blockwork, id, before }) => {
      const original = await storedTree(site, id);
      success(await blockwork.edit({ edits: job.edits }));
      const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal(saved.content, job.expected());
      assert.deepEqual(changedPaths(original, await storedTree(site, id)), job.paths);
      assert.equal((await frontEnd(site, id)).status, 200);
    });
  });
}

test('duplicate a section from its markup and retitle the copy', async () => {
  await withDocument(site, { content: page() }, async ({ blockwork, doc: opened, id, before }) => {
    const original = await storedTree(site, id);
    const read = await blockwork.read({
      blocks: { client_id: opened.blocks[2].client_id, markup: true },
    });
    success(read);
    success(await blockwork.edit({ edits: [{ op: 'insert', markup: read.markup }] }));
    success(
      await blockwork.edit({
        edits: [{ op: 'update', path: [3, 0], attributes: { content: 'Visit' } }],
      }),
    );
    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(
      saved.content,
      doc(page(), group(heading('Visit'), paragraph('A clear plan for your work.'))),
    );
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), ['3']);
  });
});

test('reset a heading to its native default and update dynamic card text and level', async () => {
  const seed = doc(
    heading('Stories', 3),
    '<!-- wp:bw/job-post-card {"imageId":0,"headingLevel":3,"text":"Old story"} /-->',
  );
  await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    success(
      await blockwork.edit({
        edits: [
          { op: 'update', path: [0], unset: [['level']] },
          {
            op: 'update',
            path: [1],
            attributes: { headingLevel: 2, text: 'New story' },
            unset: [['imageId']],
          },
        ],
      }),
    );
    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(
      saved.content,
      doc(heading('Stories'), '<!-- wp:bw/job-post-card {"text":"New story"} /-->'),
    );
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), ['0', '1']);
    assert.ok((await frontEnd(site, id)).html.includes('<h2>New story</h2>'));
  });
});

test('copy pattern metadata and accept an unchanged replace as no change', async () => {
  const section = group(heading('Approach'), paragraph('Listen first.')).replace(
    '"layout":',
    '"metadata":{"patternName":"example/approach","categories":["featured"]},"layout":',
  );
  const source = await seedDocument(site, { content: section });
  await withDocument(site, { content: page() }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    const roots = await blockwork.read({ source: { post_id: source, post_type: 'page' } });
    success(roots);
    const read = await blockwork.read({
      source: { post_id: source, post_type: 'page' },
      blocks: { client_id: roots.blocks[0].client_id, markup: true },
    });
    success(read);
    success(await blockwork.edit({ edits: [{ op: 'insert', markup: read.markup }] }));
    const unchanged = await blockwork.edit({
      edits: [{ op: 'replace', path: [3], markup: read.markup }],
    });
    assert.equal(unchanged.ok, false, JSON.stringify(unchanged));
    assert.equal(unchanged.error, 'no_change');
    assert.ok(unchanged.hint);
    assert.ok(unchanged.next);
    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(saved.content, doc(page(), section));
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), ['3']);
  });
});

// Native serialization supplies exact fixture markup without duplicating core save functions.
async function native(expression) {
  if (!serializer) {
    const id = await seedDocument(site, { content: '', title: 'Job serializer', status: 'draft' });
    serializer = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);
    await waitFor(
      site,
      serializer,
      `window.wp?.data?.select('core/editor')?.__unstableIsEditorReady?.()`,
    );
  }

  return site.evaluate(serializer, `wp.blocks.serialize(${expression})`);
}

const p = (content, extra = {}) => ({ name: 'core/paragraph', attributes: { content, ...extra } });
const g = (children, attributes = {}) => ({
  name: 'core/group',
  attributes: { layout: { type: 'constrained' }, ...attributes },
  inner_blocks: children,
});
const h = (content, level = 2) => ({ name: 'core/heading', attributes: { content, level } });
const expression = (trees) =>
  `(${JSON.stringify(trees)}).map(function build(b) { return wp.blocks.createBlock(b.name, b.attributes, (b.inner_blocks || []).map(build)); })`;

const layoutJobs = [
  {
    name: 'rebuild an introduction with linked line breaks',
    seed: () => g([h('Old intro'), p('Old copy')]),
    final: () =>
      g([h('Introduction', 1), p('Read our overview.<br><a href="/details/">See details</a>')], {
        align: 'full',
        layout: { type: 'constrained', contentSize: '700px' },
        style: {
          color: { background: '#f3f3f3' },
          spacing: {
            blockGap: '10px',
            padding: { top: '50px', bottom: '50px', left: '24px', right: '24px' },
          },
        },
      }),
  },
  {
    name: 'replace a line break with a vertical stack',
    seed: () => p('Project advice<br><a href="/contact/">Contact us</a>'),
    final: () =>
      g(
        [
          p('Project advice', { style: { typography: { lineHeight: '18px' } } }),
          p('<a href="/contact/">Contact us</a>', {
            style: { typography: { lineHeight: '18px' } },
          }),
        ],
        {
          layout: { type: 'flex', orientation: 'vertical', justifyContent: 'center' },
          style: {
            spacing: { blockGap: '4px', margin: { top: '20px' }, padding: { bottom: '3.333px' } },
          },
        },
      ),
  },
  {
    name: 'set fixed text width and callout typography',
    seed: () => g([g([p('Color options')])], { layout: { type: 'flex' } }),
    final: () =>
      g(
        [
          g(
            [
              p('Color options', {
                style: { typography: { fontWeight: '500', letterSpacing: '-0.275px' } },
              }),
            ],
            {
              style: {
                layout: { selfStretch: 'fixed', flexSize: '450px' },
                spacing: { padding: { bottom: '3.333px' } },
              },
            },
          ),
        ],
        { layout: { type: 'flex' } },
      ),
  },
  {
    name: 'underline linked copy and set native link color',
    seed: () => p('<a href="/details/">Read details</a>'),
    final: () =>
      p('<a href="/details/"><u>Read details</u></a>', {
        style: { elements: { link: { color: { text: '#24758d' } } } },
      }),
  },
];

for (const job of layoutJobs) {
  test(job.name, async () => {
    const seed = await native(expression([job.seed(), p('Keep footer')]));
    const expected = await native(expression([job.final(), p('Keep footer')]));
    await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
      const original = await storedTree(site, id);
      success(await blockwork.edit({ edits: [{ op: 'replace', path: [0], block: job.final() }] }));
      const read = await blockwork.read();
      success(read);

      for (const width of ['desktop', 'mobile']) {
        const measured = await blockwork.measure({ blocks: [read.blocks[0].client_id], width });
        success(measured);
        assert.equal(measured.blocks[0].rendered, true);
        assert.ok(measured.blocks[0].elements[0].rect.width > 0);
      }

      const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal(saved.content, expected);
      const expectedTree = await site.php(
        `echo wp_json_encode(parse_blocks(base64_decode('${Buffer.from(expected).toString('base64')}')));`,
      );
      assert.deepEqual(
        changedPaths(original, await storedTree(site, id)),
        changedPaths(original, expectedTree),
      );
      assert.ok((await frontEnd(site, id)).html.includes('Keep footer'));
    });
  });
}

test('add a table row while leaving the rest of the page unchanged', async () => {
  const table = {
    name: 'core/table',
    attributes: {
      body: [
        {
          cells: [
            { content: 'Starter', tag: 'td' },
            { content: '5%', tag: 'td' },
          ],
        },
      ],
    },
  };
  const updated = structuredClone(table);
  updated.attributes.body.push({
    cells: [
      { content: 'Growth', tag: 'td' },
      { content: '4%', tag: 'td' },
    ],
  });
  const seed = await native(expression([g([h('Pricing'), table]), p('Keep footer')]));
  const expected = await native(expression([g([h('Pricing'), updated]), p('Keep footer')]));
  await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    success(
      await blockwork.edit({
        edits: [{ op: 'update', path: [0, 1], attributes: updated.attributes }],
      }),
    );
    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(saved.content, expected);
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), ['0.1']);
    assert.ok((await frontEnd(site, id)).html.includes('<td>Growth</td><td>4%</td>'));
  });
});

test('add and remove a thumbnail caption row without changing the main card', async () => {
  const image = await seedImage(site, { name: 'job-main' });
  const thumb = await seedImage(site, { name: 'job-thumbnail', width: 90, height: 17 });
  const main = {
    name: 'core/image',
    attributes: { id: image.id, url: image.url, alt: 'Main artwork' },
  };
  const row = g(
    [
      {
        name: 'core/image',
        attributes: {
          id: thumb.id,
          url: thumb.url,
          alt: '',
          width: '90px',
          height: '17px',
          style: { layout: { selfStretch: 'fixed', flexSize: '90px' } },
        },
      },
      p('Finish sample'),
    ],
    {
      layout: { type: 'flex', flexWrap: 'nowrap' },
      style: {
        spacing: { blockGap: '14px', padding: { top: '14px' } },
        border: { top: { width: '1px', style: 'solid' } },
      },
    },
  );
  const seed = await native(
    expression([g([main, h('Artwork'), p('Keep caption')]), p('Keep footer')]),
  );
  const added = await native(
    expression([g([main, h('Artwork'), p('Keep caption'), row]), p('Keep footer')]),
  );
  await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    success(await blockwork.edit({ edits: [{ op: 'insert', parent: [0], block: row }] }));
    const first = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(first.after.content, added);
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), ['0', '0.3']);
    assert.ok((await frontEnd(site, id)).html.includes('Finish sample'));
    success(await blockwork.edit({ edits: [{ op: 'remove', path: [0, 3] }] }));
    const last = await assertSavedCleanly(site, id, first.after, await blockwork.save());
    assert.equal(last.after.content, seed);
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), []);
    const front = await frontEnd(site, id);
    assert.ok(!front.html.includes('Finish sample'));
    assert.ok(front.html.includes('Main artwork'));
  });
});

test('restore the parent gap after clearing a child zero margin', async () => {
  const seed = await native(
    expression([
      g([p('First'), p('Second', { style: { spacing: { margin: { top: '0' } } } })], {
        style: { spacing: { blockGap: '10px' } },
      }),
      p('Footer'),
    ]),
  );
  const expected = await native(
    expression([
      g([p('First'), p('Second')], { style: { spacing: { blockGap: '10px' } } }),
      p('Footer'),
    ]),
  );
  await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    const read = await blockwork.read({ blocks: 'all' });
    success(read);
    const ids = read.blocks.filter((b) => b.path.length === 2).map((b) => b.client_id);
    const gap = async () => {
      const result = await blockwork.measure({ blocks: ids, properties: ['margin-top'] });
      success(result);
      const [a, b] = result.blocks.map((item) => item.elements[0].rect);

      return b.y - a.y - a.height;
    };

    assert.ok(Math.abs(await gap()) < 1);
    success(
      await blockwork.edit({
        edits: [{ op: 'update', path: [0, 1], unset: [['style', 'spacing', 'margin', 'top']] }],
      }),
    );
    assert.ok(Math.abs((await gap()) - 10) < 1);
    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(saved.content, expected);
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), ['0.1']);
  });
});

test('crop expandable artwork in unequal vertically centered columns', async () => {
  const image = await seedImage(site, { name: 'job-crop' });
  const img = { name: 'core/image', attributes: { id: image.id, url: image.url, alt: 'Artwork' } };
  const column = (children, attributes = {}) => ({
    name: 'core/column',
    attributes,
    inner_blocks: children,
  });
  const columns = (children, attributes = {}) => ({
    name: 'core/columns',
    attributes,
    inner_blocks: children,
  });
  const seedTree = columns([column([img]), column([h('Visit'), p('Meet the team')])]);
  const editedImage = {
    ...img,
    attributes: {
      ...img.attributes,
      aspectRatio: '8/5',
      scale: 'cover',
      focalPoint: { x: 0.5, y: 0.7 },
      lightbox: { enabled: true },
      style: { border: { radius: '12px' } },
    },
  };
  const final = columns(
    [
      column([editedImage], { width: '62.5%', verticalAlignment: 'center' }),
      column([h('Visit'), p('Meet the team')], { width: '37.5%', verticalAlignment: 'center' }),
    ],
    { verticalAlignment: 'center' },
  );
  const seed = await native(expression([seedTree, p('Footer')]));
  const expected = await native(expression([final, p('Footer')]));
  await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    success(
      await blockwork.edit({
        edits: [
          { op: 'update', path: [0], attributes: final.attributes },
          { op: 'update', path: [0, 0], attributes: final.inner_blocks[0].attributes },
          { op: 'update', path: [0, 1], attributes: final.inner_blocks[1].attributes },
          { op: 'update', path: [0, 0, 0], attributes: editedImage.attributes },
        ],
      }),
    );
    const all = await blockwork.read({ blocks: 'all' });
    const imageId = all.blocks.find((b) => b.name === 'core/image').client_id;
    const measured = await blockwork.measure({
      blocks: [imageId],
      properties: ['aspect-ratio', 'object-fit', 'border-radius'],
    });
    success(measured);
    const imageElement = measured.blocks[0].elements.find((e) => e.tag === 'img');
    assert.ok(imageElement, JSON.stringify(measured));
    assert.ok(Math.abs(imageElement.rect.width / imageElement.rect.height - 1.6) < 0.05);
    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(saved.content, expected);
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), [
      '0',
      '0.0',
      '0.0.0',
      '0.1',
    ]);
    const html = (await frontEnd(site, id)).html;
    assert.ok(html.includes('wp-lightbox-container'));
    assert.ok(html.includes('object-fit:cover'));
  });
});

test('move custom item groups between containers and apply their large style', async () => {
  const item = (text) => ({ name: 'bw/job-item', inner_blocks: [p(text)] });
  const container = (children) => ({ name: 'bw/job-container', inner_blocks: children });
  const seed = await native(
    expression([
      container([item('Remove sample'), item('One'), item('Two'), item('Three')]),
      container([p('Destination')]),
      p('Footer'),
    ]),
  );
  const finalItems = ['One', 'Two', 'Three'].map((text) => ({
    ...item(text),
    attributes: { className: 'is-style-large' },
  }));
  const expected = await native(
    expression([container([p('Destination'), ...finalItems]), p('Footer')]),
  );
  await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    const edits = [{ op: 'remove', path: [0, 0] }];

    for (let i = 1; i <= 3; i++) {
      edits.push({ op: 'move', path: [0, 0], parent: [1], index: i });
      edits.push({ op: 'set_block_style', path: [1, i], style: 'large' });
    }

    edits.push({ op: 'remove', path: [0] });
    success(await blockwork.edit({ edits }));
    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(saved.content, expected);
    const expectedTree = await site.php(
      `echo wp_json_encode(parse_blocks(base64_decode('${Buffer.from(expected).toString('base64')}')));`,
    );
    assert.deepEqual(
      changedPaths(original, await storedTree(site, id)),
      changedPaths(original, expectedTree),
    );
    assert.ok((await frontEnd(site, id)).html.includes('is-style-large'));
  });
});

for (const operation of ['inspect_media', 'inspect_terms']) {
  test(`${operation} resolves the current user without a document`, async () => {
    const tab = await site.openTab(`${site.site}/wp-admin/`);

    try {
      const caller = await site.createCaller(tab);
      const request = {
        operation,
        target: { site_url: site.site },
        ...(operation === 'inspect_terms' ? { taxonomy: 'category' } : { search: 'job' }),
      };
      const result = await caller.call(request);
      success(result);
      assert.ok(result.target.user_id > 0, JSON.stringify(result));
    } finally {
      await tab.close();
    }
  });
}

test('copy only approved metadata and slug and report the new public URL', async () => {
  await site.php(`update_option('permalink_structure', '/%postname%/'); flush_rewrite_rules();`);

  try {
    const control = await seedDocument(site, {
      content: paragraph('Native URL control'),
      extra: { post_name: 'native-url-before' },
    });
    const controlOldLink = await site.php(
      `$old = get_permalink(${control}); wp_update_post(['ID' => ${control}, 'post_name' => 'native-url-after']); echo wp_json_encode($old);`,
    );
    const defaults = await site.php(
      `$meta = []; foreach (array_merge(get_registered_meta_keys('post'), get_registered_meta_keys('post', 'page')) as $key => $args) { if (!empty($args['show_in_rest'])) { $meta[$key] = $args['default'] ?? match ($args['type']) { 'integer', 'number' => 0, 'boolean' => false, 'array', 'object' => [], default => '' }; } } echo wp_json_encode($meta);`,
    );
    const source = await seedDocument(site, {
      content: paragraph('Source'),
      extra: { post_name: 'approved-source' },
      meta: {
        bw_seo_title: 'Approved title',
        bw_seo_description: 'Approved description',
        bw_unrelated: 'Do not copy',
      },
    });
    await withDocument(
      site,
      {
        content: page(),
        meta: {
          ...defaults,
          bw_seo_title: 'Old title',
          bw_seo_description: 'Old description',
          bw_unrelated: 'Keep destination',
        },
      },
      async ({ blockwork, id, before }) => {
        const oldLink = await site.php(`echo wp_json_encode(get_permalink(${id}));`);
        const fields = await site.php(
          `echo wp_json_encode(['slug' => get_post(${source})->post_name, 'title' => get_post_meta(${source}, 'bw_seo_title', true), 'description' => get_post_meta(${source}, 'bw_seo_description', true)]);`,
        );
        const original = await storedTree(site, id);
        success(
          await blockwork.edit({
            post: { slug: `${fields.slug}-copy` },
            settings: {
              meta: { bw_seo_title: fields.title, bw_seo_description: fields.description },
            },
          }),
        );
        const receipt = await blockwork.save();
        const { after: saved } = await assertSavedCleanly(site, id, before, receipt, {
          allow: ['slug', 'meta'],
        });
        assert.equal(saved.slug, `${fields.slug}-copy`);
        assert.equal(saved.content, before.content);
        assert.deepEqual(saved.meta, {
          ...before.meta,
          bw_seo_title: ['Approved title'],
          bw_seo_description: ['Approved description'],
        });
        assert.deepEqual(changedPaths(original, await storedTree(site, id)), []);
        assert.equal(receipt.link, await site.php(`echo wp_json_encode(get_permalink(${id}));`));
        assert.equal((await fetch(receipt.link)).status, 200);

        // Compare the old route with a native slug change under this fixture's routing.
        for (const suffix of ['', '?campaign=test']) {
          const old = await fetch(oldLink + suffix, { redirect: 'manual' });
          const nativeOld = await fetch(controlOldLink + suffix, { redirect: 'manual' });
          assert.equal(old.status, nativeOld.status);
          assert.equal(
            (await old.text()).includes('A clear plan for your work.'),
            (await nativeOld.text()).includes('Native URL control'),
          );
        }
      },
    );
  } finally {
    await site.php(`update_option('permalink_structure', ''); flush_rewrite_rules();`);
  }
});

test('combine category filters and move the CTA beside an unrelated insertion', async () => {
  const categories = await site.php(
    `$ids = []; foreach (['Job updates', 'Job stories'] as $name) { $term = wp_insert_term($name, 'category'); $ids[] = is_wp_error($term) ? (int) $term->get_error_data() : $term['term_id']; } foreach ($ids as $index => $term) { $id = wp_insert_post(['post_type'=>'post','post_status'=>'publish','post_title'=>'Job category ' . $index]); wp_set_post_terms($id, [$term], 'category'); } echo wp_json_encode($ids);`,
  );
  const query = {
    name: 'core/query',
    attributes: {
      queryId: 71,
      query: {
        excludeCurrent: null,
        inherit: false,
        postType: 'post',
        perPage: 2,
        order: 'desc',
        orderBy: 'date',
        taxQuery: { include: { category: [categories[0]] } },
      },
    },
    inner_blocks: [{ name: 'core/post-template', inner_blocks: [{ name: 'core/post-title' }] }],
  };
  const cta = {
    name: 'core/buttons',
    inner_blocks: [{ name: 'core/button', attributes: { text: 'Contact', url: '/contact/' } }],
  };
  const extraCta = {
    name: 'core/buttons',
    inner_blocks: [{ name: 'core/button', attributes: { text: 'Read archive', url: '/archive/' } }],
  };
  const finalQuery = structuredClone(query);
  finalQuery.attributes.query.perPage = 8;
  finalQuery.attributes.query.taxQuery.include.category = categories;
  finalQuery.inner_blocks[0].attributes = { layout: { type: 'grid', columnCount: 3 } };
  const seed = await native(expression([h('News'), query, p('Keep introduction'), cta]));
  const expected = await native(
    expression([h('News'), finalQuery, cta, p('Keep introduction'), extraCta]),
  );
  await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    success(
      await blockwork.edit({
        edits: [
          { op: 'insert', block: extraCta },
          { op: 'update', path: [1], attributes: finalQuery.attributes },
          { op: 'update', path: [1, 0], attributes: finalQuery.inner_blocks[0].attributes },
          { op: 'move', path: [3], index: 2 },
        ],
      }),
    );
    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(saved.content, expected);
    const expectedTree = await site.php(
      `echo wp_json_encode(parse_blocks(base64_decode('${Buffer.from(expected).toString('base64')}')));`,
    );
    assert.deepEqual(
      changedPaths(original, await storedTree(site, id)),
      changedPaths(original, expectedTree),
    );
    const front = await frontEnd(site, id);
    assert.ok(front.html.includes('Read archive'));
    assert.ok(front.html.includes('Job category 0'));
    assert.ok(front.html.includes('Job category 1'));
  });
});

test('align unequal card buttons at the bottom and retain their adjacent logo', async () => {
  const image = await seedImage(site, { name: 'job-logo', width: 90, height: 30 });
  const row = (logo = false) =>
    g(
      [
        {
          name: 'core/buttons',
          inner_blocks: [{ name: 'core/button', attributes: { text: 'Start', url: '/start/' } }],
        },
        ...(logo
          ? [
              {
                name: 'core/image',
                attributes: {
                  id: image.id,
                  url: image.url,
                  alt: 'Partner logo',
                  width: '90px',
                  height: '30px',
                },
              },
            ]
          : []),
      ],
      { layout: { type: 'flex', flexWrap: 'nowrap' } },
    );
  const copy = [
    'Short copy.',
    'A longer description of the service and the people who deliver it.',
    'A medium description.',
  ];
  const cards = copy.map((text, i) =>
    g([p(text), row(i === 1)], { style: { dimensions: { minHeight: '350px' } } }),
  );
  const final = cards.map((card) => ({
    ...card,
    attributes: {
      ...card.attributes,
      layout: {
        type: 'flex',
        orientation: 'vertical',
        justifyContent: 'stretch',
        flexWrap: 'nowrap',
      },
      style: { ...card.attributes.style, spacing: { blockGap: '10px' } },
    },
    inner_blocks: [
      card.inner_blocks[0],
      {
        ...card.inner_blocks[1],
        attributes: {
          ...card.inner_blocks[1].attributes,
          style: { spacing: { margin: { top: 'auto' } } },
        },
      },
    ],
  }));
  const wrapper = (children) =>
    g(children, { layout: { type: 'flex', flexWrap: 'nowrap', verticalAlignment: 'stretch' } });
  const seed = await native(expression([wrapper(cards), p('Footer')]));
  const expected = await native(expression([wrapper(final), p('Footer')]));
  await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    const edits = final.flatMap((card, index) => [
      { op: 'update', path: [0, index], attributes: card.attributes },
      { op: 'update', path: [0, index, 1], attributes: card.inner_blocks[1].attributes },
    ]);
    success(await blockwork.edit({ edits }));
    const read = await blockwork.read({ blocks: 'all' });
    const rows = read.blocks
      .filter((b) => b.path.length === 3 && b.path[2] === 1)
      .map((b) => b.client_id);

    for (const width of ['desktop', 'mobile']) {
      const measured = await blockwork.measure({ blocks: rows, width });
      success(measured);
      const bottoms = measured.blocks.map((b) => {
        const r = b.elements[0].rect;

        return r.y + r.height;
      });
      assert.ok(Math.max(...bottoms) - Math.min(...bottoms) < 2, JSON.stringify(measured));
    }

    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(saved.content, expected);
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), [
      '0.0',
      '0.0.1',
      '0.1',
      '0.1.1',
      '0.2',
      '0.2.1',
    ]);
    assert.ok((await frontEnd(site, id)).html.includes('Partner logo'));
  });
});

test('equalize three cards while retaining a scrolling phone row', async () => {
  const cards = ['One', 'A much longer card title', 'Three'].map((title) =>
    g([h(title, 3), p('Keep approved copy and <a href="/details/">link</a>.')]),
  );
  const wrapper = (children) =>
    g(children, {
      layout: { type: 'flex', flexWrap: 'nowrap' },
      className: 'bw-job-scroll',
      style: { spacing: { blockGap: '20px' } },
    });
  const final = cards.map((card) => ({
    ...card,
    attributes: {
      ...card.attributes,
      style: { layout: { selfStretch: 'fixed', flexSize: '100%' } },
    },
  }));
  const seed = await native(expression([wrapper(cards), p('Footer')]));
  const expected = await native(expression([wrapper(final), p('Footer')]));
  await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    success(
      await blockwork.edit({
        edits: final.map((card, index) => ({
          op: 'update',
          path: [0, index],
          attributes: card.attributes,
        })),
      }),
    );
    const read = await blockwork.read({ blocks: 'all' });
    const ids = read.blocks.filter((b) => b.path.length === 2).map((b) => b.client_id);

    for (const width of ['desktop', 'mobile']) {
      const result = await blockwork.measure({ blocks: ids, width });
      success(result);
      const rects = result.blocks.map((b) => b.elements[0].rect);
      assert.ok(
        Math.max(...rects.map((r) => r.width)) - Math.min(...rects.map((r) => r.width)) < 2,
        JSON.stringify(result),
      );
      assert.ok(rects[2].x > rects[0].x);

      if (width === 'mobile') assert.ok(rects[2].x + rects[2].width > result.viewport.width);
    }

    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(saved.content, expected);
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), ['0.0', '0.1', '0.2']);
    assert.ok((await frontEnd(site, id)).html.includes('Keep approved copy'));
  });
});

test('rebuild a page one section at a time and refine the new sections', async () => {
  const final = [
    g([h('Overview'), p('New overview')]),
    g([h('Services'), p('New services')]),
    g([h('Contact'), p('New contact')]),
  ];
  const expected = await native(expression(final));
  await withDocument(site, { content: page() }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);

    for (let index = 0; index < final.length; index++) {
      success(
        await blockwork.edit({
          edits: [
            { op: 'replace', path: [index], block: g([h('Draft section'), p('Draft copy')]) },
          ],
        }),
      );
      success(
        await blockwork.edit({
          edits: [
            { op: 'update', path: [index, 0], attributes: final[index].inner_blocks[0].attributes },
            { op: 'update', path: [index, 1], attributes: final[index].inner_blocks[1].attributes },
          ],
        }),
      );
    }

    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(saved.content, expected);
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), [
      '0',
      '0.0',
      '0.1',
      '0.2',
      '1',
      '1.1',
      '1.2',
      '2.1',
    ]);
    assert.ok((await frontEnd(site, id)).html.includes('New services'));
  });
});

test('replace a dynamic card fallback image without changing its heading', async () => {
  const image = await seedImage(site, { name: 'job-fallback' });
  const card = { name: 'bw/job-post-card', attributes: { text: 'Featured story' } };
  const final = { ...card, attributes: { ...card.attributes, imageId: image.id } };
  const seed = await native(expression([h('Stories'), card, p('Keep footer')]));
  const expected = await native(expression([h('Stories'), final, p('Keep footer')]));
  await withDocument(site, { content: seed }, async ({ blockwork, id, before }) => {
    const original = await storedTree(site, id);
    success(
      await blockwork.edit({
        edits: [{ op: 'update', path: [1], attributes: { imageId: image.id } }],
      }),
    );
    const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(saved.content, expected);
    assert.deepEqual(changedPaths(original, await storedTree(site, id)), ['1']);
    const front = await frontEnd(site, id);
    assert.ok(front.html.includes('Featured story'));
    assert.ok(
      front.html.includes(
        await site.php(`echo wp_json_encode(wp_get_attachment_image_url(${image.id}));`),
      ),
    );
    assert.equal(await site.php(`echo wp_json_encode((bool) get_post(${image.id}));`), true);
  });
});

for (const job of [
  { count: 1000, inserted: 0 },
  { count: 800, inserted: 50 },
]) {
  test(`edit a ${job.count} block page and insert ${job.inserted} blocks without disturbing existing copy`, async () => {
    const blocks = Array.from({ length: job.count }, (_, index) =>
      paragraph(`Section copy ${index}`),
    );
    const added = Array.from({ length: job.inserted / 10 }, (_, section) =>
      group(
        heading(`New section ${section}`),
        ...Array.from({ length: 8 }, (_, index) =>
          paragraph(`New section copy ${section}.${index}`),
        ),
      ),
    );
    const expected = [...blocks];
    expected[400] = paragraph('Updated section copy');
    expected.push(...added);
    await withDocument(site, { content: doc(...blocks) }, async ({ blockwork, id, before }) => {
      const original = await storedTree(site, id);
      success(
        await blockwork.edit({
          edits: [{ op: 'update', path: [400], attributes: { content: 'Updated section copy' } }],
        }),
      );

      if (added.length)
        success(await blockwork.edit({ edits: [{ op: 'insert', markup: doc(...added) }] }));
      const { after: saved } = await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal(saved.content, doc(...expected));
      assert.deepEqual(changedPaths(original, await storedTree(site, id)), [
        '400',
        ...added.map((_, index) => String(job.count + index)),
      ]);
      assert.ok((await frontEnd(site, id)).html.includes('Updated section copy'));
    });
  });
}

test('a guessed child field gets an exact replacement in the main hint', async () => {
  await withDocument(site, { content: page() }, async ({ blockwork, id, before }) => {
    const result = await blockwork.edit({
      edits: [{ op: 'insert', block: { name: 'core/group', innerBlocks: [p('Not inserted')] } }],
    });
    await assertRefused(site, id, before, result, { error: 'invalid_edit' });
    assert.match(result.hint, /innerBlocks/);
    assert.match(result.hint, /inner_blocks/);
    assert.deepEqual(
      changedPaths(
        await site.php(
          `echo wp_json_encode(parse_blocks(base64_decode('${Buffer.from(before.content).toString('base64')}')));`,
        ),
        await storedTree(site, id),
      ),
      [],
    );
  });
});

run();
