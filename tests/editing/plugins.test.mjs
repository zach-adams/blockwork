import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';

const { after, before, test, generated, run } = editingTests(import.meta.url);

import { button, buttons, doc, paragraph } from './blocks.mjs';
import {
  assertRefused,
  assertSavedCleanly,
  frontEnd,
  seedDocument,
  seedImage,
  serializeNatively,
  startEditingSite,
  storedDocument,
  waitFor,
  withDocument,
} from './harness.mjs';

let site;
before(async () => {
  site = await startEditingSite();
});
after(() => site?.[Symbol.asyncDispose]());

for (const rewrite of ['comment', 'class']) {
  test(`content rewrite ${rewrite} does not silently verify different stored markup`, async () => {
    await withDocument(site, { content: doc(paragraph('Before')) }, async ({ blockwork, id }) => {
      assert.equal(
        (
          await blockwork.edit({
            edits: [
              { op: 'update', path: [0], name: 'core/paragraph', attributes: { content: 'After' } },
            ],
          })
        ).ok,
        true,
      );
      await site.php(`update_option('bw_test_rewrite', '${rewrite}');`);

      try {
        const result = await blockwork.save();
        const stored = await storedDocument(site, id);
        assert.notEqual(stored.content, doc(paragraph('After')));
        assert.notEqual(result.persistence, 'verified', JSON.stringify(result));
        assert.ok(result.hint && result.next, JSON.stringify(result));
      } finally {
        await site.php(`delete_option('bw_test_rewrite');`);
      }
    });
  });
}

test('a plugin changing the title reports the stored difference', async () => {
  await withDocument(site, { content: doc(paragraph('Before')) }, async ({ blockwork, id }) => {
    assert.equal(
      (
        await blockwork.edit({
          edits: [
            { op: 'update', path: [0], name: 'core/paragraph', attributes: { content: 'After' } },
          ],
        })
      ).ok,
      true,
    );
    await site.php(`update_option('bw_test_fields', 1);`);

    try {
      const result = await blockwork.save();
      assert.equal((await storedDocument(site, id)).title, 'Changed by fixture');
      assert.equal(result.persistence, 'uncertain', JSON.stringify(result));
      assert.equal(result.error, 'verification_mismatch');
      assert.ok(result.diagnostics.fields.includes('title'));
      assert.equal(result.next, 'recover_save_do_not_replay');
      assert.ok(result.receipt && result.hint);
    } finally {
      await site.php(`delete_option('bw_test_fields');`);
    }
  });
});

test(
  'a plugin collapsing visible preformatted whitespace cannot produce verified persistence',

  async () => {
    const pre = '<!-- wp:bw/pre-space -->\n<pre>A  B</pre>\n<!-- /wp:bw/pre-space -->';
    await withDocument(
      site,
      { content: doc(pre, paragraph('Before')) },
      async ({ blockwork, id }) => {
        const edit = await blockwork.edit({
          edits: [
            { op: 'update', path: [1], name: 'core/paragraph', attributes: { content: 'After' } },
          ],
        });
        assert.equal(edit.ok, true, JSON.stringify(edit));
        await site.php(`update_option('bw_test_rewrite', 'pre');`);

        try {
          const result = await blockwork.save();
          assert.match((await storedDocument(site, id)).content, /<pre>A B<\/pre>/);
          assert.notEqual(result.persistence, 'verified', JSON.stringify(result));
          assert.ok(result.hint && result.next, JSON.stringify(result));
        } finally {
          await site.php(`delete_option('bw_test_rewrite');`);
        }
      },
    );
  },
);

test(
  'capture keeps an unrelated fixed page tool visible',
  {},
  async () => {
    await withDocument(site, { content: doc(paragraph('Before')) }, async ({ doc: connected }) => {
      await site.php(`update_option('bw_test_notice', 'tool');`);
      const tab = await site.openTab('about:blank');
      const caller = await site.createCaller(tab);

      try {
        await tab.goto(connected.link);
        await waitFor(
          site,
          tab,
          `Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'OK' && button.parentElement.textContent.includes('Cookie policy'))`,
        );
        const capture = await caller.capture_page({ widths: ['desktop'] });
        assert.equal(capture.ok, true, capture.error);
        assert.equal(
          await site.evaluate(
            tab,
            `Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'OK' && button.parentElement.textContent.includes('Cookie policy'))`,
          ),
          true,
        );
        assert.equal(capture.shots[0].hidden_notices, 0);
      } finally {
        await tab.close();
        await site.php(`delete_option('bw_test_notice');`);
      }
    });
  },
);

const paragraphEdit = [
  { op: 'update', path: [0], name: 'core/paragraph', attributes: { content: 'After' } },
];

const transformations = [
  [
    'strip_style',
    '<!-- wp:paragraph {"style":{"color":{"text":"#123456"}}} -->\n<p class="has-text-color" style="color:#123456">Before</p>\n<!-- /wp:paragraph -->',
    true,
  ],
  ['comment', doc(paragraph('Before')), true],
  ['class', doc(paragraph('Before')), true],
  [
    'pre',
    doc(
      paragraph('Before'),
      '<!-- wp:bw/pre-space -->\n<pre>A  B</pre>\n<!-- /wp:bw/pre-space -->',
    ),
    true,
  ],
  ['shortcode', doc(paragraph('Before')), true],
  ['whitespace', doc(paragraph('Before'), paragraph('Neighbor')), false],
  ['entity', doc(paragraph('Before'), paragraph('A & B')), false],
  [
    'cdn',
    doc(paragraph('Before'), paragraph('<a href="https://example.test/image.png">Image</a>')),
    true,
  ],
  ['analytics', doc(paragraph('Before')), true],
];

for (const hook of ['content_save_pre', 'wp_insert_post_data']) {
  for (const [mode, seed, material] of transformations) {
    const option = hook === 'content_save_pre' ? 'bw_test_transform' : 'bw_test_insert_transform';
    test(
      `server ${hook} ${mode} rewrite has an honest persistence outcome`,
      async () => {
        const initial =
          mode === 'cdn'
            ? await serializeNatively(
                site,
                `[wp.blocks.createBlock('core/paragraph',{content:'Before'}),wp.blocks.createBlock('core/image',{url:'https://example.test/image.png',alt:'Fixture'})]`,
              )
            : seed;
        await withDocument(site, { content: initial }, async ({ blockwork, id, before }) => {
          assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
          await site.php(`update_option('${option}', '${mode}');`);

          try {
            const saved = await blockwork.save();
            const content = (await storedDocument(site, id)).content;
            assert.notEqual(content, initial);

            if (mode === 'cdn') {
              assert.match(content, /src="https:\/\/cdn\.example\.test\/image\.png"/);
            }

            if (mode === 'strip_style') {
              assert.doesNotMatch(content, /style="color:#123456"/);
              assert.match(content, /has-text-color/);
            }

            if (material) {
              assert.notEqual(saved.persistence, 'verified', JSON.stringify(saved));
              assert.ok(saved.error && saved.hint && saved.next, JSON.stringify(saved));
              assert.match(saved.next, /recover|inspect/);
            } else {
              await assertSavedCleanly(site, id, before, saved);
            }
          } finally {
            await site.php(`delete_option('${option}');`);
          }
        });
      },
    );
  }
}

for (const mode of ['title', 'after_title', 'erase_meta', 'reject']) {
  test(
    mode === 'erase_meta'
      ? 'REST-hidden plugin meta lies outside verified document fields'
      : `REST hook ${mode} is never silently accepted`,
    async () => {
      await withDocument(
        site,
        { content: doc(paragraph('Before')), meta: { fixture_owned: 'Keep' } },
        async ({ blockwork, id, before }) => {
          assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
          await site.php(`update_option('bw_test_rest', '${mode}');`);

          try {
            const saved = await blockwork.save();

            if (mode === 'erase_meta') {
              const { after } = await assertSavedCleanly(site, id, before, saved, {
                allow: ['meta'],
              });
              assert.equal(after.meta.fixture_owned, undefined);
              const otherMeta = (meta) =>
                Object.fromEntries(Object.entries(meta).filter(([key]) => key !== 'fixture_owned'));
              assert.deepEqual(otherMeta(after.meta), otherMeta(before.meta));

              return;
            }

            assert.equal(saved.ok, false, JSON.stringify(saved));
            assert.ok(saved.error && saved.hint && saved.next, JSON.stringify(saved));

            if (mode === 'reject') {
              await assertRefused(site, id, before, saved);
            } else {
              assert.match(saved.next, /recover|inspect/);
            }
          } finally {
            await site.php(`delete_option('bw_test_rest');`);
          }
        },
      );
    },
  );
}

for (const field of ['post_name', 'post_status']) {
  test(`workflow plugin changing ${field} is reported`, async () => {
    await withDocument(site, { content: doc(paragraph('Before')) }, async ({ blockwork }) => {
      assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
      await site.php(`update_option('bw_test_post_field', '${field}');`);

      try {
        const saved = await blockwork.save();
        assert.notEqual(saved.persistence, 'verified', JSON.stringify(saved));
        assert.ok(saved.error && saved.hint && saved.next);
        assert.match(saved.next, /recover|inspect/);
      } finally {
        await site.php(`delete_option('bw_test_post_field');`);
      }
    });
  });
}

for (const mode of ['autosaving_lock', 'fetch_accessor', 'modal']) {
  test(`editor extension ${mode} permits a complete native save`, async () => {
    await site.php(`update_option('bw_test_extension', '${mode}');`);

    try {
      await withDocument(
        site,
        { content: doc(paragraph('Before')) },
        async ({ blockwork, id, before }) => {
          assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
          await assertSavedCleanly(site, id, before, await blockwork.save());
        },
      );
    } finally {
      await site.php(`delete_option('bw_test_extension');`);
    }
  });
}

test('native saving lock refuses without changing stored content', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('Before')) },
    async ({ blockwork, id, before, tab }) => {
      assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
      await site.evaluate(tab, `wp.data.dispatch('core/editor').lockPostSaving('fixture')`);
      await assertRefused(site, id, before, await blockwork.save());
    },
  );
});

for (const mode of ['saved', 'fail', 'login']) {
  test(`classic meta box ${mode} reports its own persistence`, async () => {
    await site.php(`update_option('bw_test_metabox', '${mode}');`);

    try {
      await withDocument(
        site,
        { content: doc(paragraph('Before')) },
        async ({ blockwork, tab, id, before }) => {
          await waitFor(site, tab, `document.querySelector('#fixture_value')`);
          await site.evaluate(tab, `document.querySelector('#fixture_value').value = 'Changed'`);
          assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
          const saved = await blockwork.save({ save_all_pending: true });
          await assertSavedCleanly(site, id, before, saved, { allow: ['meta'] });
          assert.equal(
            (await storedDocument(site, id)).meta.fixture_panel?.[0],
            mode === 'saved' ? 'Changed' : undefined,
          );
          // A redirect counts as saved, as saving.md documents, because its destination is opaque.
          assert.equal(
            saved.meta_boxes,
            mode === 'fail' ? 'failed' : 'saved',
            JSON.stringify(saved),
          );
        },
        { workflow: 'attached' },
      );
    } finally {
      await site.php(`delete_option('bw_test_metabox');`);
    }
  });
}

test('hidden content.raw refuses before mutation with repair guidance', async () => {
  await site.php(`update_option('bw_test_hide_raw', 1);`);

  try {
    await withDocument(
      site,
      { content: doc(paragraph('Before')) },
      async ({ doc: result, id, before }) => {
        await assertRefused(site, id, before, result);
      },
      { connected: false },
    );
  } finally {
    await site.php(`delete_option('bw_test_hide_raw');`);
  }
});

test('PDF button URL survives no-op save and neighboring paragraph edit', async () => {
  const content = doc(
    paragraph('Before'),
    buttons(button('Download PDF', 'https://example.test/document.pdf')),
  );
  await withDocument(site, { content }, async ({ blockwork, id, before }) => {
    assert.equal((await blockwork.save()).persistence, 'unchanged');
    assert.equal((await storedDocument(site, id)).content, content);
    assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
    await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal((await storedDocument(site, id)).content, content.replace('Before', 'After'));
  });
});

for (const seconds of [10, 40]) {
  test(`save_post delayed ${seconds} seconds never invites a replay`, async (t) => {
    await withDocument(
      site,
      { content: doc(paragraph('Before')) },
      async ({ blockwork, tab, id, before }) => {
        assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
        await site.php(`update_option('bw_test_delay', ${seconds});`);

        try {
          const saved = await blockwork.save();
          t.diagnostic(
            JSON.stringify({
              delay_seconds: seconds,
              persistence: saved.persistence,
              error: saved.error,
              next: saved.next,
            }),
          );

          if (saved.persistence === 'verified') {
            await assertSavedCleanly(site, id, before, saved);
          } else {
            assert.equal(saved.ok, false, JSON.stringify(saved));
            assert.ok(saved.hint && saved.next, JSON.stringify(saved));
            assert.match(saved.next, /do_not_replay|inspect|wait_for/);
            assert.doesNotMatch(saved.next, /retry/);
          }

          await waitFor(site, tab, `!wp.data.select('core/editor').isSavingPost()`, 70_000);
          assert.equal((await storedDocument(site, id)).content, doc(paragraph('After')));
        } finally {
          await site.php(`delete_option('bw_test_delay');`);
        }
      },
    );
  });
}

test('a stale REST field registration does not erase pending paragraph work', async () => {
  await withDocument(site, { content: doc(paragraph('Before')) }, async ({ blockwork, id }) => {
    assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
    await site.php(`update_option('bw_test_stale_schema', 1);`);

    try {
      const result = await blockwork.save();
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.ok(result.hint && result.next);
      assert.equal((await storedDocument(site, id)).content, doc(paragraph('Before')));
    } finally {
      await site.php(`delete_option('bw_test_stale_schema');`);
    }
  });
});

test('a privacy policy page refuses an editor without its native capability', async (t) => {
  const id = await seedDocument(site, { content: doc(paragraph('Before')) });
  await site.php(`update_option('wp_page_for_privacy_policy', ${id});`);
  await site.signIn('editor');
  const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);

  try {
    const blockwork = await site.createCaller(tab);
    const result = await blockwork.connect({
      target: { site_url: site.site, post_id: id, post_type: 'page' },
      workflow: 'background',
    });
    t.diagnostic(JSON.stringify({ error: result.error, hint: result.hint, next: result.next }));
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.notEqual(result.error, 'reauthorization_required', JSON.stringify(result));
    assert.ok(result.error && result.hint && result.next);
    assert.equal((await storedDocument(site, id)).content, doc(paragraph('Before')));
  } finally {
    await tab.close();
    await site.signIn('admin');
    await site.php(`delete_option('wp_page_for_privacy_policy');`);
  }
});

test('translated consent notice remains visible and keep_notices never hides it', async () => {
  await withDocument(site, { content: doc(paragraph('Before')) }, async ({ doc: connected }) => {
    await site.php(`update_option('bw_test_notice', 'german');`);
    const tab = await site.openTab('about:blank');

    try {
      const front = await site.createCaller(tab);
      await tab.goto(connected.link);
      await waitFor(site, tab, `document.body.innerText.includes('Datenschutz')`);

      for (const keep_notices of [false, true]) {
        const captured = await front.capture_page({ widths: ['desktop', 'mobile'], keep_notices });
        assert.equal(captured.ok, true, JSON.stringify(captured));
        assert.deepEqual(
          captured.shots.map((shot) => shot.hidden_notices),
          [0, 0],
        );
        assert.equal(
          await site.evaluate(tab, `document.body.innerText.includes('Datenschutz')`),
          true,
        );
      }
    } finally {
      await tab.close();
      await site.php(`delete_option('bw_test_notice');`);
    }
  });
});

for (const mode of ['attributes', 'extra_class']) {
  test(`plugin ${mode} applied after page creation cannot silently lose saved content`, async () => {
    const id = await seedDocument(site, { content: doc(paragraph('Before')) });
    const before = await storedDocument(site, id);
    await site.php(`update_option('bw_test_registration', '${mode}');`);
    const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);

    try {
      const caller = await site.createCaller(tab);
      const result = await caller.connect({
        target: { site_url: site.site, post_id: id, post_type: 'page' },
        workflow: 'background',
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      const edited = await caller.edit({ edits: paragraphEdit });

      if (!edited.ok) {
        assert.ok(edited.error && edited.hint && edited.next);
        assert.equal((await storedDocument(site, id)).content, doc(paragraph('Before')));
      } else {
        const saved = await caller.save();
        await assertSavedCleanly(site, id, before, saved);
        assert.match((await storedDocument(site, id)).content, /After/);
      }

      await caller.release();
    } finally {
      await tab.close();
      await site.php(`delete_option('bw_test_registration');`);
    }
  });
}

test('an ambiguous attached draft stays protected from native autosave', async () => {
  await withDocument(
    site,
    { status: 'draft', content: doc(paragraph('Before'), '<!-- wp:bw/shape {"config":{}} /-->') },
    async ({ blockwork, tab, id, before, target }) => {
      const refused = await blockwork.edit({ edits: paragraphEdit });
      assert.equal(refused.error, 'ambiguous_union_attribute', JSON.stringify(refused));
      await assertRefused(site, id, before, refused);
      assert.equal((await blockwork.connect({ target, workflow: 'attached', unsaved_preview: true })).ok, true);
      assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
      const protection = await site.evaluate(tab, `(() => {
        wp.data.dispatch('core/editor').updateEditorSettings({ autosaveInterval: 1 });
        const editor = wp.data.select('core/editor');
        return [editor.isPostAutosavingLocked(), editor.isPostSavingLocked(), editor.isEditedPostAutosaveable()];
      })()`);
      assert.deepEqual(protection, [true, true, false]);
      await site.evaluate(tab, 'new Promise(resolve => setTimeout(resolve, 2500))');
      assert.equal((await storedDocument(site, id)).content, before.content);
      assert.equal((await blockwork.save({ save_all_pending: true })).error, 'unsaved_preview_save_forbidden');
      assert.equal((await blockwork.revert()).ok, true);
    },
    { workflow: 'attached' },
  );
});

for (const config of [{}, { 0: 'x' }, [], ['x']]) {
  test(
    `ambiguous union shape preserves storage ${JSON.stringify(config)}`,

    async () => {
      await withDocument(
        site,
        { content: doc(paragraph('Before'), `<!-- wp:bw/shape ${JSON.stringify({ config })} /-->`) },
        async ({ blockwork, id, before }) => {
          const refused = await blockwork.edit({
            edits: [{ op: 'update', path: [1], name: 'bw/shape', attributes: { config: { keep: true } } }],
          });
          assert.equal(refused.error, 'ambiguous_union_attribute', JSON.stringify(refused));
          assert.deepEqual(refused.diagnostics.path, [1]);
          assert.equal(refused.diagnostics.attribute, 'config');
          assert.ok(refused.hint && refused.next);
          await assertRefused(site, id, before, refused);
          assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
          const saved = await blockwork.save();
          assert.equal(saved.error, 'ambiguous_union_attribute', JSON.stringify(saved));
          await assertRefused(site, id, before, saved);
        },
      );
    },
  );
}

for (const config of [{}, { 0: 'x' }]) {
  test(
    `PHP reserialization preserves union attribute meaning ${JSON.stringify(config)}`,

    async () => {
      const unionBlock = `<!-- wp:bw/shape ${JSON.stringify({ config: { keep: true } })} /-->`;
      await withDocument(
        site,
        { content: doc(paragraph('Before'), unionBlock) },
        async ({ blockwork, id, tab }) => {
          assert.match((await frontEnd(site, id)).html, /Object configuration/);
          const edited = await blockwork.edit({ edits: [
            ...paragraphEdit,
            { op: 'update', path: [1], name: 'bw/shape', unset: ['config'] },
            { op: 'update', path: [1], name: 'bw/shape', attributes: { config } },
          ] });
          assert.equal(edited.ok, true, JSON.stringify(edited));
          const desired = await site.evaluate(tab, 'wp.data.select("core/editor").getEditedPostContent()');
          assert.deepEqual(JSON.parse(desired.match(/<!-- wp:bw\/shape (.*?) \/-->/)[1]).config, config);
          await site.php(`update_option('bw_test_transform', 'shape');`);

          try {
            const saved = await blockwork.save();
            const stored = (await storedDocument(site, id)).content;
            assert.notEqual(stored, desired);
            const attributes = JSON.parse(stored.match(/<!-- wp:bw\/shape (.*?) \/-->/)[1]);
            assert.equal(Array.isArray(attributes.config), true);
            assert.match((await frontEnd(site, id)).html, /Array configuration/);
            assert.notEqual(saved.persistence, 'verified', JSON.stringify(saved));
            assert.ok(saved.error && saved.hint && saved.next);
          } finally {
            await site.php(`delete_option('bw_test_transform');`);
          }
        },
      );
    },
  );
}

for (const mode of ['csp', 'media_fatal']) {
  test(`native startup failure ${mode} has actionable guidance`, async (t) => {
    const id = await seedDocument(site, { content: doc(paragraph('Before')) });
    await site.php(`update_option('bw_test_${mode}', 1);`);
    const tab = await site.openTab('about:blank');

    try {
      if (mode === 'csp') {
        await tab.cdp.send('Page.setBypassCSP', { enabled: false });
      }

      await tab.goto(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);

      if (mode === 'csp') {
        await waitFor(site, tab, `document.readyState === 'complete'`);
        const policy = await site.evaluate(
          tab,
          `fetch(location.href).then(response => response.headers.get('content-security-policy'))`,
        );

        if (!policy) {
          t.skip(
            'The Playground HTTP bridge omits the fixture PHP Content-Security-Policy header, so this fixture cannot enforce the policy.',
          );

          return;
        }

        assert.match(policy, /script-src 'self'/);
      }

      const caller = await site.createCaller(tab);
      const result = await caller.connect({
        target: { site_url: site.site, post_id: id, post_type: 'page' },
        workflow: 'background',
      });
      t.diagnostic(
        JSON.stringify({
          error: result.error,
          hint: result.hint,
          next: result.next,
          diagnostics: result.diagnostics,
        }),
      );
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.ok(result.error && result.hint && result.next, JSON.stringify(result));
      assert.equal((await storedDocument(site, id)).content, doc(paragraph('Before')));
    } finally {
      await tab.close();
      await site.php(`delete_option('bw_test_${mode}');`);
    }
  });
}

for (const count of [400, 600]) {
  test(`a gallery of ${count} images preserves every item on a neighboring edit`, async (t) => {
    const content = await serializeNatively(
      site,
      `[wp.blocks.createBlock('core/paragraph',{content:'Before'}),wp.blocks.createBlock('core/gallery',{},Array.from({length:${count}},(_,i)=>wp.blocks.createBlock('core/image',{url:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',alt:'Fixture '+i})))]`,
    );
    await withDocument(
      site,
      { content },
      async ({ blockwork, id, before, tab }) => {
        const nativeContent = await site.evaluate(
          tab,
          `wp.data.select('core/editor').getEditedPostContent()`,
        );
        const edit = await blockwork.edit({ edits: paragraphEdit });

        if (!edit.ok) {
          await assertRefused(site, id, before, edit);
          t.diagnostic(
            `Native gallery edit refused with ${edit.error}; stored content remained exact.`,
          );

          return;
        }

        const saved = await blockwork.save({ save_all_pending: true });
        await assertSavedCleanly(site, id, before, saved);
        assert.equal(
          (await storedDocument(site, id)).content,
          nativeContent.replace('Before', 'After'),
        );
        assert.equal(nativeContent.match(/<!-- wp:image/g)?.length, count);
        t.diagnostic(`Saved and verified all ${count} images.`);
      },
      { workflow: 'attached' },
    );
  });
}

test('picture wrapper is a frontend transform and never changes the stored image', async () => {
  const image = await seedImage(site, { name: 'picture-fixture', width: 100, height: 50 });
  const content = await serializeNatively(
    site,
    `[wp.blocks.createBlock('core/paragraph',{content:'Before'}),wp.blocks.createBlock('core/image',{id:${image.id},url:${JSON.stringify(image.url)},alt:'Fixture'})]`,
  );
  await site.php(`update_option('bw_test_picture', 1);`);

  try {
    await withDocument(site, { content }, async ({ blockwork, id, before }) => {
      assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
      await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal((await storedDocument(site, id)).content, content.replace('Before', 'After'));
      assert.match((await frontEnd(site, id)).html, /<picture><img/);
    });
  } finally {
    await site.php(`delete_option('bw_test_picture');`);
  }
});

test('PHP notice output before save JSON is never treated as a verified save', async () => {
  await withDocument(site, { content: doc(paragraph('Before')) }, async ({ blockwork, id }) => {
    assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
    await site.php(`update_option('bw_test_php_notice',1);`);

    try {
      const saved = await blockwork.save();
      assert.equal(saved.ok, false, JSON.stringify(saved));
      assert.equal(saved.persistence, 'uncertain');
      assert.ok(saved.receipt);
      assert.ok(saved.error && saved.hint && saved.next);
      assert.match(saved.next, /recover|inspect/);
      assert.equal((await storedDocument(site, id)).content, doc(paragraph('After')));
    } finally {
      await site.php(`delete_option('bw_test_php_notice');`);
    }
  });
});

test('fetch accessor is restored exactly after native save and release', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('Before')) },
    async ({ blockwork, id, before, tab }) => {
      await site.evaluate(
        tab,
        `(() => { const original=window.fetch; const getter=()=>original; const setter=()=>{}; Object.defineProperty(window,'fetch',{configurable:true,get:getter,set:setter}); window.fixtureFetch={getter,setter}; })()`,
      );
      assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
      await assertSavedCleanly(site, id, before, await blockwork.save());
      await blockwork.release();
      assert.equal(
        await site.evaluate(
          tab,
          `Object.getOwnPropertyDescriptor(window,'fetch').get === window.fixtureFetch.getter && Object.getOwnPropertyDescriptor(window,'fetch').set === window.fixtureFetch.setter`,
        ),
        true,
      );
    },
  );
});

for (const base of ['records', 'records.v2', 'library/records']) {
  test(
    `native custom REST base ${base} is discovered without guessing`,
    async () => {
      await site.php(`update_option('bw_test_route', '${base}');`);

      try {
        await withDocument(
          site,
          { type: 'bw_route', content: doc(paragraph('Before')) },
          async ({ blockwork, doc: connected, id, before, tab }) => {
            await waitFor(
              site,
              tab,
              `window.wp?.data?.select('core/editor')?.__unstableIsEditorReady?.()`,
            );
            assert.equal(
              await site.evaluate(
                tab,
                `wp.apiFetch({path:'/fixture/v1/${base}/${id}'}).then(record=>record.id)`,
              ),
              id,
            );

            assert.equal(connected.ok, true, JSON.stringify(connected));
            assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
            await assertSavedCleanly(site, id, before, await blockwork.save());
          },
          { connected: false },
        );
      } finally {
        await site.php(`delete_option('bw_test_route');`);
      }
    },
  );
}

for (const redirect of ['frontend', 'renamed_login']) {
  test(`editor redirected to ${redirect} refuses with repair guidance`, async () => {
    const id = await seedDocument(site, { content: doc(paragraph('Before')) });
    const before = await storedDocument(site, id);
    await site.php(`update_option('bw_test_redirect', '${redirect}');`);
    const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);

    try {
      const caller = await site.createCaller(tab);
      await assertRefused(
        site,
        id,
        before,
        await caller.connect({
          target: { site_url: site.site, post_id: id, post_type: 'page' },
          workflow: 'background',
        }),
      );
    } finally {
      await tab.close();
      await site.php(`delete_option('bw_test_redirect');`);
    }
  });
}

test('a document settings panel permits a clean native save', async () => {
  await site.php(`update_option('bw_test_extension','panel');`);

  try {
    await withDocument(
      site,
      { content: doc(paragraph('Before')) },
      async ({ blockwork, id, before }) => {
        assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
        await assertSavedCleanly(site, id, before, await blockwork.save());
      },
    );
  } finally {
    await site.php(`delete_option('bw_test_extension');`);
  }
});

test('capture of a frontend render fatal remains distinct from document persistence', async () => {
  const content = '<!-- wp:bw/fatal /-->';
  const id = await seedDocument(site, { content });
  const response = await frontEnd(site, id);
  assert.match(response.html, /critical error|Fixture render failure/i);
  const tab = await site.openTab('about:blank');

  try {
    const caller = await site.createCaller(tab);
    const captured = await caller.capture_page({
      url: `${site.site}/?page_id=${id}`,
      widths: ['desktop'],
    });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    assert.equal((await storedDocument(site, id)).content, content);
  } finally {
    await tab.close();
  }
});

for (const mode of ['saved', 'content']) {
  test(
    `an attached meta-box-only change with ${mode} behavior is saved honestly`,
    async () => {
      await site.php(`update_option('bw_test_metabox','${mode}');`);

      try {
        await withDocument(
          site,
          { content: doc(paragraph('Before')) },
          async ({ blockwork, tab, id, before }) => {
            await waitFor(site, tab, `document.querySelector('#fixture_value')`);

            if (mode === 'content') {
              assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
            }

            await site.evaluate(
              tab,
              `(() => { const input=document.querySelector('#fixture_value'); input.value='Changed'; input.dispatchEvent(new Event('change',{bubbles:true})); })()`,
            );
            const saved = await blockwork.save({ save_all_pending: true });
            assert.equal(
              (await storedDocument(site, id)).meta.fixture_panel?.[0],
              'Changed',
              JSON.stringify(saved),
            );

            if (mode === 'saved') {
              await assertSavedCleanly(site, id, before, saved, { allow: ['meta'] });
              assert.equal((await storedDocument(site, id)).content, before.content);
            } else {
              assert.notEqual(saved.persistence, 'verified', JSON.stringify(saved));
              assert.ok(saved.hint && saved.next);
            }
          },
          { workflow: 'attached' },
        );
      } finally {
        await site.php(`delete_option('bw_test_metabox');`);
      }
    },
  );
}

for (const workflow of ['background', 'attached']) {
  test(`plugin makes editor dirty on load in ${workflow} workflow`, async () => {
    await site.php(`update_option('bw_test_extension','dirty');`);

    try {
      await withDocument(
        site,
        { content: doc(paragraph('Before')) },
        async ({ blockwork, doc: connected, id, before }) => {
          if (workflow === 'background') {
            await assertRefused(site, id, before, connected, { error: 'editor_not_clean' });
          } else {
            assert.equal(connected.ok, true, JSON.stringify(connected));
            const saved = await blockwork.save({ save_all_pending: true });
            await site.php(`delete_option('bw_test_extension');`);
            await assertSavedCleanly(site, id, before, saved);
            assert.equal(
              (await storedDocument(site, id)).content,
              doc(paragraph('Fixture changed')),
            );
          }
        },
        { workflow, connected: false },
      );
    } finally {
      await site.php(`delete_option('bw_test_extension');`);
    }
  });
}

for (const field of ['post_title', 'post_name', 'post_status']) {
  test(`save_post hook changing ${field} is reported without replay`, async () => {
    await withDocument(site, { content: doc(paragraph('Before')) }, async ({ blockwork, id }) => {
      assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
      await site.php(`update_option('bw_test_after_field','${field}');`);

      try {
        const saved = await blockwork.save();
        assert.notEqual(saved.persistence, 'verified', JSON.stringify(saved));
        assert.ok(saved.error && saved.hint && saved.next);
        assert.match(saved.next, /recover|inspect/);
        const stored = await storedDocument(site, id);
        assert.equal(
          stored[{ post_title: 'title', post_name: 'slug', post_status: 'status' }[field]],
          field === 'post_status' ? 'pending' : 'fixture-after-save',
        );
      } finally {
        await site.php(`delete_option('bw_test_after_field');`);
      }
    });
  });
}

test('a failing dynamic editor preview does not prevent truthful document persistence', async () => {
  const content = doc(
    paragraph('Before'),
    '<!-- wp:bw/preview-failure {"members":["Fixture member"]} /-->',
  );
  await withDocument(
    site,
    { content, meta: { fixture_owned: 'Keep' } },
    async ({ blockwork, tab, id, before }) => {
      await waitFor(
        site,
        tab,
        `Array.from(document.querySelectorAll('iframe')).some(frame=>frame.contentDocument?.body?.textContent.includes('Fixture preview failed')) || document.body.textContent.includes('Fixture preview failed')`,
      );
      assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
      await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal((await storedDocument(site, id)).content, content.replace('Before', 'After'));
      assert.match((await frontEnd(site, id)).html, /Fixture dynamic output/);
      assert.match((await frontEnd(site, id)).html, /<li>Fixture member<\/li>/);
    },
  );
});

test('verified persistence remains distinct from stale frontend plugin output', async () => {
  await site.php(`update_option('bw_test_cached_front',1);`);

  try {
    await withDocument(
      site,
      { content: doc(paragraph('Before')) },
      async ({ blockwork, id, before }) => {
        assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
        await assertSavedCleanly(site, id, before, await blockwork.save());
        assert.equal((await storedDocument(site, id)).content, doc(paragraph('After')));
        const front = await frontEnd(site, id);
        assert.match(front.html, /Fixture stale cached content/);
        assert.doesNotMatch(front.html, /<p>After<\/p>/);
      },
    );
  } finally {
    await site.php(`delete_option('bw_test_cached_front');`);
  }
});

test('wp-admin behind a same-site editor redirect permits a complete save', async () => {
  await site.php(
    `update_option('bw_test_redirect','admin_route'); update_option('bw_test_redirect_hits',0);`,
  );

  try {
    await withDocument(
      site,
      { content: doc(paragraph('Before')) },
      async ({ blockwork, id, before }) => {
        assert.ok(await site.php(`echo wp_json_encode((int)get_option('bw_test_redirect_hits'));`));
        assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
        await assertSavedCleanly(site, id, before, await blockwork.save());
      },
    );
  } finally {
    await site.php(`delete_option('bw_test_redirect');`);
  }
});

test('unchanged meta box defaults persist during the document save', async () => {
  await site.php(`update_option('bw_test_metabox','saved');`);

  try {
    await withDocument(
      site,
      { content: doc(paragraph('Before')) },
      async ({ blockwork, id, before }) => {
        assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
        await assertSavedCleanly(site, id, before, await blockwork.save(), { allow: ['meta'] });
        assert.equal((await storedDocument(site, id)).meta.fixture_panel?.[0], 'Before');
      },
    );
  } finally {
    await site.php(`delete_option('bw_test_metabox');`);
  }
});

test('an unchanged meta box rebuilds its cache exclusion after a slug change', async () => {
  await site.php(`update_option('bw_test_metabox','cache_exclusion');`);

  try {
    await withDocument(
      site,
      {
        content: doc(paragraph('Before')),
        meta: { fixture_excluded_url: 'https://example.test/old' },
      },
      async ({ blockwork, tab, id, before }) => {
        await site.evaluate(
          tab,
          `wp.data.dispatch('core/editor').editPost({slug:'fixture-cache-slug'})`,
        );
        assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
        const saved = await blockwork.save({ save_all_pending: true });
        await assertSavedCleanly(site, id, before, saved, { allow: ['slug', 'meta'] });
        assert.equal((await storedDocument(site, id)).meta.fixture_excluded_url?.[0], saved.link);
      },
      { workflow: 'attached' },
    );
  } finally {
    await site.php(`delete_option('bw_test_metabox');`);
  }
});

test('a stale meta box overwriting requested REST meta reports the stored difference', async () => {
  await site.php(`update_option('bw_test_metabox','stale_registered');`);

  try {
    await withDocument(
      site,
      { content: doc(paragraph('Before')), meta: { fixture_panel: 'Before' } },
      async ({ blockwork, tab, id, before }) => {
        await site.evaluate(
          tab,
          `wp.data.dispatch('core/editor').editPost({meta:{...wp.data.select('core/editor').getEditedPostAttribute('meta'),fixture_panel:'Requested'}})`,
        );
        assert.equal((await blockwork.edit({ edits: paragraphEdit })).ok, true);
        const saved = await blockwork.save({ save_all_pending: true });
        assert.equal(saved.ok, false, JSON.stringify(saved));
        assert.equal(saved.error, 'verification_mismatch', JSON.stringify(saved));
        assert.equal(saved.next, 'recover_save_do_not_replay');
        assert.equal(saved.persistence, 'uncertain');
        assert.ok(saved.receipt);
        assert.ok(saved.diagnostics.fields.includes('meta.fixture_panel'));
        assert.ok(saved.hint);
        assert.equal((await storedDocument(site, id)).meta.fixture_panel?.[0], 'Before');
        assert.equal((await storedDocument(site, id)).content, doc(paragraph('After')));
        const stored = await storedDocument(site, id);

        for (const field of [
          'title',
          'status',
          'slug',
          'date',
          'author',
          'excerpt',
          'parent',
          'menu_order',
          'editor_mode',
        ]) {
          assert.deepEqual(stored[field], before[field]);
        }
      },
      { workflow: 'attached' },
    );
  } finally {
    await site.php(`delete_option('bw_test_metabox');`);
  }
});

test('a meta save after a native save refuses a key the meta box wrote', async () => {
  await site.php(
    `update_option('bw_test_metabox','stale_registered'); update_option('bw_test_stale_schema','1');`,
  );

  try {
    await withDocument(
      site,
      {
        content: doc(paragraph('Before')),
        meta: { fixture_panel: 'Original', fixture_late: 'Original' },
      },
      async ({ blockwork, tab, id }) => {
        // The user's Save posts the meta box form after the REST save. The form
        // stores fixture_panel, and the editor's record keeps 'Original'.
        await site.evaluate(
          tab,
          `wp.data.dispatch('core/editor').editPost({title:'Saved by user'}); wp.data.dispatch('core/editor').savePost()`,
        );
        await waitFor(
          site,
          tab,
          `!wp.data.select('core/editor').isSavingPost() && !wp.data.select('core/edit-post').isSavingMetaBoxes()`,
        );
        assert.equal((await storedDocument(site, id)).meta.fixture_panel?.[0], 'Before');
        const edited = await blockwork.edit({ settings: { meta: { fixture_late: 'Agent' } } });
        assert.equal(edited.ok, true, JSON.stringify(edited));
        const refused = await blockwork.save({ save_all_pending: true });
        assert.equal(refused.error, 'saved_record_changed', JSON.stringify(refused));
        assert.ok(refused.diagnostics.fields.includes('meta.fixture_panel'));
        const stored = await storedDocument(site, id);
        assert.equal(stored.meta.fixture_panel?.[0], 'Before');
        assert.equal(stored.meta.fixture_late?.[0], 'Original');
      },
      { workflow: 'attached' },
    );
  } finally {
    await site.php(`delete_option('bw_test_metabox'); delete_option('bw_test_stale_schema');`);
  }
});

test('notice restoration failure retains capture results and requires closing the tab', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('Before')) },
    async ({ doc: connected, id, before }) => {
      await site.php(`update_option('bw_test_notice','restore_failure');`);
      const tab = await site.openTab('about:blank');

      try {
        const front = await site.createCaller(tab);
        const url = new URL(connected.link);
        url.searchParams.set('_wpnonce', 'example-token');
        const captured = await front.capture_page({ url: url.href, widths: ['desktop'] });
        assert.equal(captured.ok, true, captured.error);
        assert.equal(captured.shots.length, 1);
        assert.equal(captured.shots[0].hidden_notices, 1);
        assert.equal(captured.notice_cleanup?.error, 'notice_restore_failed');
        assert.equal(captured.notice_cleanup.next, 'close_tab');
        assert.ok(captured.notice_cleanup.hint);
        assert.equal(
          await site.evaluate(tab, `new URL(location.href).searchParams.get('_wpnonce')`),
          'example-token',
        );
        assert.equal((await storedDocument(site, id)).content, before.content);
      } finally {
        await tab.close();
        await site.php(`delete_option('bw_test_notice');`);
      }
    },
  );
});

generated('plugin abilities preserve query input and keep uncertain output bounded', async (t) => {
  const inputs = [
    ['empty array', { list: [] }],
    ['empty object', { nested: {} }],
    ['nested null', { extra: { value: null } }],
    ['bracket key', { 'bad[key]': 'value' }],
    ['constructor key', JSON.parse('{"constructor":1}')],
    ['prototype key', JSON.parse('{"__proto__":{"value":1}}')],
  ];
  const selected = inputs.filter(([name]) => t.selected(name));

  if (selected.length || t.selected('valid echo') || t.selected('oversized output')) {
    await withDocument(
      site,
      { content: doc(paragraph('Before')) },
      async ({ blockwork, tab, id, before }) => {
        for (const [name, input] of selected) {
          const leaf = await t.test(name, async () => {
            let runs = 0;
            const stop = await site.intercept(tab, {
              urlPattern: '*abilities*echo*run*',
              stage: 'Request',
              decide: (params) => {
                if (params.request.method === 'GET') {
                  runs++;
                }

                return 'pass';
              },
            });

            try {
              const result = await blockwork.call({
                operation: 'run_ability',
                name: 'blockwork-fixture/echo',
                effect: 'read',
                input,
              });
              await assertRefused(site, id, before, result, {
                error: 'ability_query_input_unsupported',
              });
              assert.equal(result.persistence, 'not_attempted');
              assert.ok(result.diagnostics.path.startsWith('input'));
              assert.equal(runs, 0);
            } finally {
              await stop();
            }
          });

          if (!leaf.completed) return;
        }

        const echoLeaf = await t.test('valid echo', async () => {
          let runs = 0;
          const stop = await site.intercept(tab, {
            urlPattern: '*abilities*echo*run*',
            stage: 'Request',
            decide: (params) => {
              if (params.request.method === 'GET') {
                runs++;
              }

              return 'pass';
            },
          });

          try {
            const echo = await blockwork.call({
              operation: 'run_ability',
              name: 'blockwork-fixture/echo',
              effect: 'read',
              input: { flag: false, list: [1], nested: { label: 'Fixture', items: ['one'] } },
            });
            assert.equal(echo.ok, true, JSON.stringify(echo));
            assert.equal(echo.output.input.flag, false);
            assert.equal(echo.output.types.flag, 'boolean');
            assert.equal(runs, 1);
          } finally {
            await stop();
          }
        });

        if (echoLeaf.selected && !echoLeaf.completed) return;
        await t.test('oversized output', async () => {
          const large = await blockwork.call({
            operation: 'run_ability',
            name: 'blockwork-fixture/multibyte-output',
            effect: 'read',
          });
          assert.equal(large.ok, true, JSON.stringify(large));
          assert.equal(large.output_omitted, 'too_large');
          assert.equal(
            large.output_bytes,
            Buffer.byteLength(JSON.stringify({ text: '界'.repeat(30000) })),
          );
          assert.equal(large.output, undefined);
          assert.ok(Buffer.byteLength(JSON.stringify(large)) < 4096);
        });
      },
    );
  }

  await t.test('uncertain write', async () => {
    await withDocument(
      site,
      { content: doc(paragraph('Before')) },
      async ({ blockwork, id, before }) => {
        const name = 'blockwork-fixture/set-marker';
        const count = () =>
          site.php(
            `echo wp_json_encode(count(array_filter(get_option('blockwork_fixture_calls',[]), static fn($name)=>$name==='blockwork-fixture/set-marker')));`,
          );
        const prior = await count();
        await site.php(`update_option('bw_test_ability_html',1);`);

        try {
          const result = await blockwork.call({
            operation: 'run_ability',
            name,
            effect: 'write',
            input: { value: 'Fixture marker' },
          });
          await assertRefused(site, id, before, result, {
            error: 'ability_output_unreadable',
            next: 'report_uncertain_do_not_replay',
          });
          assert.equal(result.persistence, 'uncertain');
          assert.equal(await count(), prior + 1);
          assert.equal(
            await site.php(`echo wp_json_encode(get_option('blockwork_fixture_marker'));`),
            'Fixture marker',
          );
        } finally {
          await site.php(`delete_option('bw_test_ability_html');`);
        }
      },
    );
  });
});

test('a render-dependent meta getter refuses inconsistent native and filtered records', async () => {
  await site.php(`update_option('bw_test_rendered_getter',1);`);

  try {
    await withDocument(
      site,
      { content: doc(paragraph('Before')) },
      async ({ doc: result, id, before }) => {
        await assertRefused(site, id, before, result, { error: 'saved_record_changed' });
        assert.ok(result.diagnostics.fields.some((field) => field.startsWith('meta')));
      },
      { connected: false },
    );
  } finally {
    await site.php(`delete_option('bw_test_rendered_getter');`);
  }
});

test('a plugin loading many rendered pages does not become a pending document save', async () => {
  await site.php(
    `$ids=[]; for($i=0;$i<30;$i++){ $ids[]=wp_insert_post(['post_type'=>'page','post_status'=>'publish','post_title'=>'Fixture hierarchy '.$i,'post_content'=>str_repeat('<!-- wp:paragraph --><p>Fixture background content</p><!-- /wp:paragraph -->',20)]); } update_option('bw_test_hierarchy_ids',$ids); update_option('bw_test_hierarchy_query',1);`,
  );

  try {
    await withDocument(
      site,
      { content: doc(paragraph('Before')) },
      async ({ blockwork, tab, id, before }) => {
        await waitFor(site, tab, `window.fixture_hierarchy_count === 30`);
        const result = await blockwork.save();
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.persistence, 'unchanged');
        const stored = await storedDocument(site, id);

        for (const field of Object.keys(before).filter((field) => field !== 'lock')) {
          assert.deepEqual(stored[field], before[field]);
        }
      },
    );
  } finally {
    await site.php(
      `delete_option('bw_test_hierarchy_query'); delete_option('bw_test_hierarchy_ids');`,
    );
  }
});

for (const mode of ['missing', 'blocked']) {
  test(`plugin pattern-opening action ${mode} refuses before changing the draft`, async () => {
    const content = await serializeNatively(
      site,
      `[wp.blocks.createBlock('core/group',{metadata:{patternName:'fixture/section',name:'Fixture section'},templateLock:'contentOnly'},[wp.blocks.createBlock('core/paragraph',{content:'Before'})])]`,
    );
    await site.php(`update_option('bw_test_pattern_action','${mode}');`);

    try {
      await withDocument(site, { content }, async ({ blockwork, tab, id, before }) => {
        const section_client_id = await site.evaluate(
          tab,
          `wp.data.select('core/block-editor').getBlocks()[0].clientId`,
        );
        const result = await blockwork.edit({
          open_pattern_section: { section_client_id },
          edits: [
            {
              op: 'update',
              path: [0, 0],
              name: 'core/paragraph',
              attributes: { content: 'After' },
            },
          ],
        });
        await assertRefused(site, id, before, result, {
          error:
            mode === 'missing' ? 'pattern_section_open_unavailable' : 'pattern_section_not_opened',
        });
        assert.equal(
          await site.evaluate(tab, `wp.data.select('core/editor').getEditedPostContent()`),
          content,
        );
      });
    } finally {
      await site.php(`delete_option('bw_test_pattern_action');`);
    }
  });
}

for (const action of ['save_order', 'external_change']) {
  test(`plugin fields with a dotted name and exposed menu_order handle ${action}`, async () => {
    await site.php(
      `update_option('bw_test_route','records'); update_option('bw_test_odd_fields',1); update_option('bw_test_dot_value','original');`,
    );

    try {
      await withDocument(
        site,
        { type: 'bw_route', content: doc(paragraph('Before')) },
        async ({ blockwork, id, before }) => {
          const request = { edits: paragraphEdit };

          if (action === 'save_order') {
            request.post = { menu_order: 7 };
          }

          assert.equal((await blockwork.edit(request)).ok, true);

          if (action === 'external_change') {
            await site.php(`update_option('bw_test_dot_value','external');`);
            const result = await blockwork.save();
            await assertRefused(site, id, before, result, { error: 'saved_record_changed' });
            assert.deepEqual(result.diagnostics.fields, ['<key>'], JSON.stringify(result));
          } else {
            await assertSavedCleanly(site, id, before, await blockwork.save(), {
              allow: ['menu_order'],
            });
            assert.equal((await storedDocument(site, id)).menu_order, 7);
            assert.equal((await storedDocument(site, id)).content, doc(paragraph('After')));
          }
        },
      );
    } finally {
      await site.php(
        `delete_option('bw_test_route'); delete_option('bw_test_odd_fields'); delete_option('bw_test_dot_value');`,
      );
    }
  });
}

run();
