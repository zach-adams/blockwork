import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';

const { after, before, test, generated, run } = editingTests(import.meta.url);

import { doc, paragraph } from './blocks.mjs';
import {
  assertRefused,
  assertSavedCleanly,
  seedDocument,
  seedImage,
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

const content = doc(paragraph('Original'));
const check = (result) => assert.equal(result.ok, true, JSON.stringify(result));
const refusal = (result) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(result.error && result.hint && result.next, JSON.stringify(result));
};

async function adminCaller(body, screen = 'upload.php') {
  const tab = await site.openTab(`${site.site}/wp-admin/${screen}`);
  await waitFor(site, tab, '!!window.wp?.apiFetch');
  const caller = await site.createCaller(tab);

  try {
    return await body(caller, tab);
  } finally {
    await caller.release().catch(() => undefined);
    await tab.close();
  }
}

generated('discover types and create a document once', async (t) => {
  await t.test('discovery', async () => {
    await adminCaller(async (caller) => {
      const found = await caller.call({ operation: 'discover', target: { site_url: site.site } });
      check(found);

      for (const type of [
        'page',
        'post',
        'bw_book',
        'bw_template',
        'bw_locked',
        'bw_base',
        'bw_namespace',
        'bw_hierarchical',
      ]) {
        assert.ok(
          found.types.some((entry) => entry.name === type),
          type,
        );
      }

      assert.ok(!found.types.some((entry) => entry.name === 'bw_hidden'));
    });
  });

  for (const type of [
    'page',
    'post',
    'bw_book',
    'bw_template',
    'bw_locked',
    'bw_no_editor',
    'bw_hidden',
    'bw_base',
    'bw_namespace',
    'bw_hierarchical',
  ]) {
    await t.test(type, async () => {
      await adminCaller(async (caller) => {
        const created = await caller.create({
          target: { site_url: site.site, user_id: 1 },
          post_type: type,
        });

        if (['bw_hidden', 'bw_no_editor'].includes(type)) {
          refusal(created);
          assert.equal(created.error, 'unsupported_post_type', JSON.stringify(created));

          return;
        }

        check(created);

        const id = created.document.post_id;
        const baseline = await storedDocument(site, id);

        if (type === 'bw_locked') {
          await assertRefused(
            site,
            id,
            baseline,
            await caller.edit({ edits: [{ op: 'insert', block: { name: 'core/paragraph' } }] }),
          );
        }

        const request = {
          post: {
            title: `Created ${type}`,
            slug: `created-${type.replaceAll('_', '-')}`,
            status: 'draft',
          },
        };

        if (type === 'post') {
          request.settings = { taxonomies: { category: [1] } };
        }

        const allow = ['title', 'slug', 'status', 'date'];

        if (type === 'bw_hierarchical') {
          request.post.parent_id = await seedDocument(site, {
            content,
            type,
            title: 'Hierarchy parent',
          });
          request.post.menu_order = 3;
          allow.push('parent', 'menu_order');
        }

        check(await caller.edit(request));
        const saved = await caller.save();
        check(saved);
        await assertSavedCleanly(site, id, baseline, saved, { allow });
        const again = await caller.save();
        assert.equal(again.persistence, 'unchanged', JSON.stringify(again));
        const count = await site.php(
          `echo wp_json_encode(count(get_posts(['post_type' => '${type}', 'post_status' => 'draft', 'name' => 'created-${type.replaceAll('_', '-')}'])));`,
        );
        assert.equal(count, 1);
        assert.equal((await storedDocument(site, id)).status, 'draft');
        assert.equal(
          saved.link,
          await site.php(`wp_set_current_user(1); echo wp_json_encode(get_permalink(${id}));`),
        );
        assert.equal(saved.editor_url, `${site.site}/wp-admin/post.php?post=${id}&action=edit`);

        if (type === 'page' || type === 'bw_hierarchical') {
          assert.equal(await site.php(`echo wp_json_encode(get_page_template_slug(${id}));`), '');
        }
      });
    });
  }
});

for (const status of ['publish', 'draft', 'pending', 'private', 'future']) {
  test(`ordinary edit preserves ${status}`, async () => {
    const extra =
      status === 'future'
        ? { post_date: '2099-01-01 12:00:00', post_date_gmt: '2099-01-01 12:00:00' }
        : {};
    await withDocument(
      site,
      { content, type: 'post', status, extra },
      async ({ blockwork, id, before }) => {
        check(await blockwork.edit({ post: { title: `Edited ${status}` } }));
        const saved = await blockwork.save();
        await assertSavedCleanly(site, id, before, saved, { allow: ['title'] });
        assert.equal((await storedDocument(site, id)).status, status);
        assert.equal(
          saved.link,
          await site.php(`wp_set_current_user(1); echo wp_json_encode(get_permalink(${id}));`),
        );
        assert.equal(saved.editor_url, `${site.site}/wp-admin/post.php?post=${id}&action=edit`);
      },
    );
  });
}

for (const [status, post] of Object.entries({
  publish: { status: 'publish' },
  private: { status: 'private' },
  future: { status: 'future', date_gmt: '2099-01-01T12:00:00' },
})) {
  test(`explicitly change draft to ${status}`, async () => {
    await withDocument(site, { content, status: 'draft' }, async ({ blockwork, id, before }) => {
      check(await blockwork.edit({ post }));
      const saved = await blockwork.save();
      // WordPress generates a slug when a draft without one stops being a draft.
      await assertSavedCleanly(site, id, before, saved, { allow: ['status', 'date', 'slug'] });
      const after = await storedDocument(site, id);

      assert.equal(after.status, status);
      assert.ok(after.slug.length > 0, 'the published page needs a generated slug');
    });
  });
}

test('settings persist and unsupported fields refuse with guidance', async () => {
  const parent = await seedDocument(site, { content, title: 'Parent' });
  await withDocument(
    site,
    { content, meta: { bw_subtitle: 'Keep subtitle' } },
    async ({ blockwork, id, before }) => {
      const title = 'Title & "quotes" <em>HTML</em> 🚀';
      check(
        await blockwork.edit({
          post: { title, excerpt: 'Excerpt & words', parent_id: parent, menu_order: 7 },
          settings: {
            meta: {
              bw_string: 'hello',
              bw_integer: 12,
              bw_boolean: true,
              bw_array: ['two', 'one'],
              bw_object: { note: 'value' },
            },
          },
        }),
      );
      const saved = await blockwork.save();
      const { after } = await assertSavedCleanly(site, id, before, saved, {
        allow: ['title', 'excerpt', 'parent', 'menu_order', 'meta'],
      });
      assert.equal(after.title, title);
      assert.equal(after.excerpt, 'Excerpt & words');
      assert.equal(after.parent, parent);
      assert.equal(after.menu_order, 7);
      assert.equal(after.meta.bw_subtitle[0], 'Keep subtitle');
      const read = await blockwork.read({ settings: true });
      assert.deepEqual(read.settings.values.meta.bw_array, ['two', 'one']);
      assert.deepEqual(read.settings.values.meta.bw_object, { note: 'value' });

      for (const key of ['unregistered', '_protected']) {
        const result = await blockwork.edit({ settings: { meta: { [key]: 'no' } } });
        refusal(result);
      }
    },
  );
});

test('another writer changing a field refuses save', async () => {
  await withDocument(site, { content }, async ({ blockwork, id, before }) => {
    check(await blockwork.edit({ post: { title: 'Agent title' } }));
    await site.php(`wp_update_post(['ID' => ${id}, 'post_title' => 'Other title']);`);
    const result = await blockwork.save();
    // The other writer's title is the stored one, and this save must not overwrite it.
    await assertRefused(site, id, before, result, {
      error: 'saved_record_changed',
      allow: ['title'],
    });
    assert.equal((await storedDocument(site, id)).title, 'Other title');
    assert.ok(result.diagnostics.fields.includes('title'), JSON.stringify(result));
  });
});

test('trashed documents refuse connection', async () => {
  await withDocument(
    site,
    { content, status: 'trash' },
    async ({ doc: result }) => refusal(result),
    { connected: false },
  );
});

test('terms can be created, inspected, assigned and deleted', async () => {
  await withDocument(site, { content, type: 'post' }, async ({ blockwork, id, before }) => {
    const planned = await blockwork.call({
      operation: 'prepare_term',
      taxonomy: 'bw_topic',
      action: 'create',
      fields: { name: 'Café & tea', slug: 'cafe-tea' },
    });
    check(planned);
    const created = await blockwork.call({ operation: 'save_resource', receipt: planned.receipt });
    check(created);
    const inspected = await blockwork.call({
      operation: 'inspect_terms',
      taxonomy: 'bw_topic',
      id: created.resource_id,
    });
    check(inspected);
    check(await blockwork.edit({ settings: { taxonomies: { bw_topic: [created.resource_id] } } }));
    const saved = await blockwork.save();
    await assertSavedCleanly(site, id, before, saved);
    const terms = await site.php(
      `echo wp_json_encode(wp_get_object_terms(${id}, 'bw_topic', ['fields' => 'ids']));`,
    );
    assert.deepEqual(terms, [created.resource_id]);
    const current = await blockwork.call({
      operation: 'inspect_terms',
      taxonomy: 'bw_topic',
      id: created.resource_id,
    });
    check(current);
    const deletion = await blockwork.call({
      operation: 'prepare_term',
      taxonomy: 'bw_topic',
      action: 'delete',
      id: created.resource_id,
      edit_token: current.record.edit_token,
      scope: 'all_relationships',
    });
    check(deletion);
    check(await blockwork.call({ operation: 'save_resource', receipt: deletion.receipt }));
  });
});

test('password-protected post keeps its password and status', async () => {
  await withDocument(
    site,
    { content, type: 'post', extra: { post_password: 'fixture-password' } },
    async ({ blockwork, id, before }) => {
      check(await blockwork.edit({ post: { title: 'Password protected' } }));
      await assertSavedCleanly(site, id, before, await blockwork.save(), { allow: ['title'] });
      const password = await site.php(
        `echo wp_json_encode(get_post_field('post_password', ${id}));`,
      );
      assert.equal(password, 'fixture-password');
    },
  );
});

test('explicitly unpublish a published page', async () => {
  await withDocument(site, { content }, async ({ blockwork, id, before }) => {
    check(await blockwork.edit({ post: { status: 'draft' } }));
    await assertSavedCleanly(site, id, before, await blockwork.save(), { allow: ['status'] });
    assert.equal((await storedDocument(site, id)).status, 'draft');
  });
});

test('save reports a revision and a type without revisions reports none', async () => {
  for (const type of ['page', 'bw_no_revision']) {
    await withDocument(site, { content, type }, async ({ blockwork, id, before }) => {
      check(await blockwork.edit({ post: { title: 'Revision title' } }));
      const saved = await blockwork.save();
      await assertSavedCleanly(site, id, before, saved, { allow: ['title'] });

      if (type === 'page') {
        assert.ok(saved.revisions?.url, JSON.stringify(saved));
      } else {
        assert.equal(saved.revisions, null);
      }
    });
  }
});

for (const type of ['bw_dot', 'bw_path']) {
  test(
    `native editor supports unusual route ${type}`,
    {},
    async () => {
      await site.php("update_option('bw_unusual_routes', true);");

      try {
        const id = await seedDocument(site, { content, type });
        const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);

        try {
          await waitFor(
            site,
            tab,
            "window.wp?.data?.select('core/editor')?.__unstableIsEditorReady?.()",
          );
          assert.equal(
            await site.evaluate(tab, "wp.data.select('core/editor').getCurrentPostType()"),
            type,
          );
          const record = await site.evaluate(
            tab,
            "wp.data.select('core').getEntityRecord('postType', wp.data.select('core/editor').getCurrentPostType(), wp.data.select('core/editor').getCurrentPostId())",
          );
          assert.equal(record.id, id);
          await waitFor(site, tab, '!!window.wp?.apiFetch');
          const caller = await site.createCaller(tab);
          const result = await caller.call({
            operation: 'discover',
            target: { site_url: site.site },
            post_type: type,
          });
          check(result);
          assert.ok(result.records.some((entry) => entry.id === id));
        } finally {
          await tab.close();
        }
      } finally {
        await site.php("delete_option('bw_unusual_routes');");
      }
    },
  );
}

for (const route of ['create', 'editor']) {
  test(`publish a normal draft made through ${route}`, async () => {
    await adminCaller(async (caller) => {
      const created = await caller.create({
        target: { site_url: site.site, user_id: 1 },
        post_type: 'page',
      });
      check(created);
      const id = created.document.post_id;

      if (route === 'create') {
        check(
          await caller.edit({
            post: { title: 'Normal created draft', slug: 'normal-created-draft', status: 'draft' },
            edits: [
              {
                op: 'insert',
                block: {
                  name: 'core/paragraph',
                  attributes: { content: 'Normal created content' },
                },
              },
            ],
          }),
        );
        await assertSavedCleanly(site, id, await storedDocument(site, id), await caller.save(), {
          allow: ['title', 'slug', 'status', 'date'],
        });
      } else {
        await caller.release();
        const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);

        try {
          await waitFor(
            site,
            tab,
            "window.wp?.data?.select('core/editor')?.__unstableIsEditorReady?.()",
          );
          await site.evaluate(
            tab,
            "(async () => { await wp.data.dispatch('core/editor').editPost({title: 'Normal editor draft', status: 'draft'}); wp.data.dispatch('core/block-editor').resetBlocks([wp.blocks.createBlock('core/paragraph', {content: 'Normal editor content'})]); })()",
          );
          await waitFor(
            site,
            tab,
            "wp.data.select('core/editor').getEditedPostContent().includes('Normal editor content')",
          );
          await site.evaluate(tab, "wp.data.dispatch('core/editor').savePost()");
        } finally {
          await tab.close();
        }
      }

      const before = await storedDocument(site, id);
      assert.equal(before.status, 'draft');
      assert.equal(before.slug, route === 'create' ? 'normal-created-draft' : '');
      assert.ok(
        before.content.includes(
          route === 'create' ? 'Normal created content' : 'Normal editor content',
        ),
      );
      const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);
      const publisher = await site.createCaller(tab);

      try {
        check(
          await publisher.connect({
            target: { site_url: site.site, post_id: id, post_type: 'page' },
            workflow: 'background',
          }),
        );
        check(await publisher.edit({ post: { status: 'publish' } }));
        const saved = await publisher.save();
        const stored = await storedDocument(site, id);
        assert.equal(stored.status, 'publish');
        assert.ok(stored.slug);
        assert.equal(stored.content, before.content);
        await assertSavedCleanly(site, id, before, saved, { allow: ['status', 'date', 'slug'] });
      } finally {
        await publisher.release();
        await tab.close();
      }
    });
  });
}

generated('invalid slugs and unsupported fields refuse with field guidance', async (t) => {
  await withDocument(site, { content }, async ({ blockwork, id, before }) => {
    for (const slug of ['UPPERCASE', 'two words', '日本語']) {
      await t.test(`slug ${slug}`, async () => {
        await assertRefused(site, id, before, await blockwork.edit({ post: { slug } }));
      });
    }

    for (const field of ['comment_status', 'ping_status', 'sticky', 'author', 'format']) {
      await t.test(field, async () => {
        const result = await blockwork.edit({ post: { [field]: 'unsupported' } });
        await assertRefused(site, id, before, result);
        assert.match(JSON.stringify(result), new RegExp(field));
      });
    }
  });
});

test('very long title survives a settings-only save', async () => {
  await withDocument(site, { content }, async ({ blockwork, id, before }) => {
    const title = 'Long title & "quoted" 🚀 '.repeat(200).trim();
    check(await blockwork.edit({ post: { title } }));
    const { after } = await assertSavedCleanly(site, id, before, await blockwork.save(), {
      allow: ['title'],
    });
    assert.equal(after.title, title);
    assert.equal(after.content, before.content);
  });
});

for (const account of ['author', 'subscriber']) {
  test(`${account} cannot edit another account's page`, async () => {
    await site.signIn(account);

    try {
      await withDocument(
        site,
        { content },
        async ({ doc: result, id, before }) => {
          await assertRefused(site, id, before, result, { error: 'editor_unavailable' });
          const allowed = await site.php(
            `echo wp_json_encode(user_can(get_user_by('login', 'blockwork_${account}'), 'edit_post', ${id}));`,
          );
          assert.equal(allowed, false);
        },
        { connected: false },
      );
      const image = await seedImage(site, { name: `permission-${account}`, width: 40, height: 40 });
      const tab = await site.openTab(`${site.site}/wp-admin/profile.php`);

      try {
        await waitFor(site, tab, '!!window.wp?.apiFetch');
        const caller = await site.createCaller(tab);
        const result = await caller.call({
          operation: 'discover',
          target: { site_url: site.site },
          post_type: 'page',
        });
        refusal(result);
        assert.equal(
          result.error,
          account === 'author' ? 'unsupported_post_type' : 'permission_denied',
          JSON.stringify(result),
        );
        const media = await caller.call({
          operation: 'inspect_media',
          target: { site_url: site.site },
          id: image.id,
        });
        refusal(media);
        assert.equal(media.error, 'permission_denied', JSON.stringify(media));
      } finally {
        await tab.close();
      }
    } finally {
      await site.signIn('admin');
    }
  });
}

test('equal meta is a no-op', async () => {
  await withDocument(
    site,
    { content, meta: { bw_string: 'same' } },
    async ({ blockwork, id, before }) => {
      check(await blockwork.edit({ settings: { meta: { bw_string: 'same' } } }));
      const saved = await blockwork.save();
      assert.equal(saved.persistence, 'unchanged', JSON.stringify(saved));
      const after = await storedDocument(site, id);
      assert.equal(after.content, before.content);
      assert.deepEqual(after.meta, before.meta);
      assert.equal(after.status, before.status);
    },
  );
});

test('denied meta refuses without changing content', async () => {
  await site.php("update_option('bw_denied_meta', true);");

  try {
    await withDocument(site, { content }, async ({ blockwork, id, before }) => {
      const edited = await blockwork.edit({ settings: { meta: { bw_denied: 'blocked' } } });
      const result = edited.ok ? await blockwork.save() : edited;
      // REST writes the other registered keys, with their defaults, before it reaches the denied one.
      await assertRefused(site, id, before, result, { allow: ['meta'] });
      assert.equal((await storedDocument(site, id)).meta.bw_denied, undefined);
    });
  } finally {
    await site.php("delete_option('bw_denied_meta');");
  }
});

test('plugin rewritten meta reports the stored difference', async () => {
  await withDocument(site, { content }, async ({ blockwork, id }) => {
    check(await blockwork.edit({ settings: { meta: { bw_string: 'requested' } } }));
    await site.php("update_option('bw_rewrite_meta', true);");

    try {
      const result = await blockwork.save();
      refusal(result);
      assert.equal(result.persistence, 'applied_with_differences', JSON.stringify(result));
      assert.equal((await storedDocument(site, id)).meta.bw_string[0], 'plugin-value');
      assert.match(JSON.stringify(result.diagnostics), /bw_string/);
      assert.match(result.hint, /live session is settled/i);
      assert.match(result.hint, /never replay this save/i);
    } finally {
      await site.php("delete_option('bw_rewrite_meta');");
    }
  });
});

test('disabled revisions report none after settings save', async () => {
  await site.php("update_option('bw_disable_revisions', true);");

  try {
    await withDocument(site, { content }, async ({ blockwork, id, before }) => {
      check(await blockwork.edit({ post: { excerpt: 'Settings change' } }));
      const saved = await blockwork.save();
      await assertSavedCleanly(site, id, before, saved, { allow: ['excerpt'] });
      assert.equal(saved.revisions, null);
    });
  } finally {
    await site.php("delete_option('bw_disable_revisions');");
  }
});

for (const [taxonomy, name] of [
  ['category', 'Tea & 日本語'],
  ['post_tag', 'Tea &amp; 日本語'],
  ['bw_topic', 'Tea & "quotes" 日本語'],
]) {
  test(`create update and delete ${taxonomy} with sanitized text`, async () => {
    await adminCaller(async (caller) => {
      const target = { site_url: site.site, user_id: 1 };
      const fields = {
        name: `${name} ${taxonomy}`,
        slug: `tea-${taxonomy.replaceAll('_', '-')}`,
        description: 'A & B',
      };

      if (taxonomy === 'bw_topic') {
        fields.meta = { bw_term_label: 'Term meta value' };
      }

      const prepared = await caller.call({
        operation: 'prepare_term',
        target,
        taxonomy,
        action: 'create',
        fields,
      });
      check(prepared);
      const saved = await caller.call({
        operation: 'save_resource',
        target,
        receipt: prepared.receipt,
      });
      check(saved);
      const inspected = await caller.call({
        operation: 'inspect_terms',
        target,
        taxonomy,
        id: saved.resource_id,
      });
      check(inspected);
      const updated = await caller.call({
        operation: 'prepare_term',
        target,
        taxonomy,
        action: 'update',
        id: saved.resource_id,
        edit_token: inspected.record.edit_token,
        fields: { description: 'Updated & quoted "text"' },
      });
      check(updated);
      check(await caller.call({ operation: 'save_resource', target, receipt: updated.receipt }));
      await withDocument(site, { content, type: 'post' }, async ({ blockwork, id, before }) => {
        const expected = taxonomy === 'category' ? [saved.resource_id, 1] : [saved.resource_id];
        check(await blockwork.edit({ settings: { taxonomies: { [taxonomy]: expected } } }));
        await assertSavedCleanly(site, id, before, await blockwork.save());
        const assigned = await site.php(
          `echo wp_json_encode(wp_get_object_terms(${id}, '${taxonomy}', ['fields' => 'ids']));`,
        );
        assert.deepEqual(
          assigned.toSorted((a, b) => a - b),
          expected.toSorted((a, b) => a - b),
        );
      });
      const current = await caller.call({
        operation: 'inspect_terms',
        target,
        taxonomy,
        id: saved.resource_id,
      });
      check(current);
      assert.equal(current.record.count, 1);
      const deleted = await caller.call({
        operation: 'prepare_term',
        target,
        taxonomy,
        action: 'delete',
        id: saved.resource_id,
        edit_token: current.record.edit_token,
        scope: 'all_relationships',
      });
      check(deleted);
      check(await caller.call({ operation: 'save_resource', target, receipt: deleted.receipt }));
    });
  });
}

test('featured image can be set then cleared without reopening for structure', async () => {
  const image = await seedImage(site, { name: 'featured-image', width: 40, height: 40 });
  await withDocument(site, { content }, async ({ blockwork, id, before }) => {
    const inspected = await blockwork.call({ operation: 'inspect_media', id: image.id });
    check(inspected);
    check(
      await blockwork.edit({
        settings: { featured_media: { id: image.id, media_token: inspected.record.edit_token } },
      }),
    );
    check(
      await blockwork.edit({
        edits: [
          {
            op: 'insert',
            block: { name: 'core/paragraph', attributes: { content: 'After image setting' } },
          },
        ],
      }),
    );
    await assertSavedCleanly(site, id, before, await blockwork.save(), { allow: ['meta'] });
    assert.equal(await site.php(`echo wp_json_encode(get_post_thumbnail_id(${id}));`), image.id);
    const current = await storedDocument(site, id);
    check(await blockwork.edit({ settings: { featured_media: 0 } }));
    await assertSavedCleanly(site, id, current, await blockwork.save(), { allow: ['meta'] });
    assert.equal(await site.php(`echo wp_json_encode(get_post_thumbnail_id(${id}));`), 0);
  });
});

test('post default category is an explained difference rather than uncertain persistence', async () => {
  await adminCaller(async (caller) => {
    const created = await caller.create({
      target: { site_url: site.site, user_id: 1 },
      post_type: 'post',
    });
    check(created);
    check(
      await caller.edit({
        post: { title: 'Default category', slug: 'default-category', status: 'draft' },
      }),
    );
    const result = await caller.save();
    assert.equal(result.persistence, 'applied_with_differences', JSON.stringify(result));
    assert.equal(result.error, 'stored_with_field_differences');
    assert.match(JSON.stringify(result), /categories/);
  });
});

test('create refuses an occupied slug before saving', async () => {
  await seedDocument(site, { content, extra: { post_name: 'occupied-slug' } });
  await adminCaller(async (caller) => {
    const created = await caller.create({
      target: { site_url: site.site, user_id: 1 },
      post_type: 'page',
    });
    check(created);
    const before = await storedDocument(site, created.document.post_id);
    const result = await caller.edit({
      post: { title: 'Conflict', slug: 'occupied-slug', status: 'draft' },
    });
    await assertRefused(site, created.document.post_id, before, result, {
      error: 'slug_already_exists',
    });
  });
});

test('term names sanitized by WordPress produce a settled mismatch', async () => {
  await adminCaller(async (caller) => {
    const target = { site_url: site.site, user_id: 1 };
    const prepared = await caller.call({
      operation: 'prepare_term',
      target,
      taxonomy: 'bw_topic',
      action: 'create',
      fields: { name: '<b>Sanitized</b>', slug: 'sanitized-term' },
    });
    check(prepared);
    const saved = await caller.call({
      operation: 'save_resource',
      target,
      receipt: prepared.receipt,
    });
    refusal(saved);
    assert.equal(saved.error, 'verification_mismatch', JSON.stringify(saved));
    assert.equal(saved.persistence, 'different');
    assert.ok(saved.diagnostics.fields.includes('name'));
    assert.ok(saved.resource_id);
  });
});

test('inspect terms learns user identity without connection', async () => {
  await adminCaller(async (caller) => {
    const result = await caller.call({
      operation: 'inspect_terms',
      target: { site_url: site.site },
      taxonomy: 'category',
    });
    check(result);
    assert.equal(result.target.user_id, 1);
    assert.ok(result.records.length > 0);
  });
});

test('contributor can save an own draft post but cannot publish it', async () => {
  await site.php(
    "if (!get_user_by('login', 'blockwork_contributor')) { wp_insert_user(['user_login' => 'blockwork_contributor', 'user_pass' => wp_generate_password(), 'role' => 'contributor']); }",
  );
  await site.signIn('contributor');

  try {
    await adminCaller(async (caller) => {
      const discovered = await caller.call({
        operation: 'discover',
        target: { site_url: site.site },
      });
      check(discovered);
      const created = await caller.create({ target: discovered.target, post_type: 'post' });
      check(created);
      check(
        await caller.edit({
          post: { title: 'Contributor draft', slug: 'contributor-draft', status: 'draft' },
        }),
      );
      const id = created.document.post_id;
      const saved = await caller.save();
      assert.equal(saved.error, 'stored_with_field_differences', JSON.stringify(saved));
      assert.equal(saved.persistence, 'applied_with_differences');
      assert.deepEqual(saved.diagnostics.fields, ['categories']);
      const before = await storedDocument(site, id);
      assert.equal(before.status, 'draft');
      assert.equal(before.title, 'Contributor draft');
      const edited = await caller.edit({ post: { status: 'publish' } });
      check(edited);
      const refused = await caller.save();
      await assertRefused(site, id, before, refused);
      assert.equal(refused.error, 'save_uncertain', JSON.stringify(refused));
      assert.equal(refused.diagnostics.wordpress_error, 'rest_cannot_publish');
      assert.equal(refused.diagnostics.status, 403);
      const recovered = await caller.call({ operation: 'recover', receipt: refused.receipt });
      refusal(recovered);
      assert.equal(recovered.outcome, 'unchanged_original', JSON.stringify(recovered));
      assert.equal(recovered.error, 'save_not_applied');
    }, 'profile.php');
  } finally {
    await site.signIn('admin');
  }
});

test('native meta_input form save persists the field independently of REST content', async () => {
  await site.php("update_option('bw_document_metabox', true);");

  try {
    await withDocument(
      site,
      { content },
      async ({ blockwork, tab, id, before }) => {
        await waitFor(site, tab, "document.querySelector('#bw-meta-input')");
        await site.evaluate(
          tab,
          "document.querySelector('#bw-meta-input').value = 'Native form value'",
        );
        check(await blockwork.edit({ post: { title: 'Native form save' } }));
        const saved = await blockwork.save({ save_all_pending: true });
        const metaBoxes =
          saved.error === 'verification_mismatch' ? saved.diagnostics.meta_boxes : saved.meta_boxes;
        assert.equal(metaBoxes, 'saved', JSON.stringify(saved));
        assert.equal((await storedDocument(site, id)).meta.bw_string[0], 'Native form value');
        await assertSavedCleanly(site, id, before, saved, { allow: ['title', 'meta'] });
      },
      { workflow: 'attached' },
    );
  } finally {
    await site.php("delete_option('bw_document_metabox');");
  }
});

test('page template assignment persists through a native settings save', async () => {
  await site.php(
    "update_option('bw_document_template', true); file_put_contents(get_stylesheet_directory() . '/bw-fixture.php', '<?php get_header(); the_post(); the_content(); get_footer();');",
  );

  try {
    await withDocument(site, { content }, async ({ blockwork, id, before }) => {
      check(await blockwork.edit({ post: { template: 'bw-fixture.php' } }));
      await assertSavedCleanly(site, id, before, await blockwork.save(), { allow: ['meta'] });
      assert.equal(
        await site.php(`echo wp_json_encode(get_page_template_slug(${id}));`),
        'bw-fixture.php',
      );
    });
  } finally {
    await site.php("delete_option('bw_document_template');");
  }
});

for (const type of ['page', 'post']) {
  test(`slug change exposes native old URL behavior for ${type}`, async (t) => {
    await site.php("update_option('permalink_structure', '/%postname%/'); flush_rewrite_rules();");
    const nativeId = await seedDocument(site, {
      content,
      type,
      extra: { post_name: `native-old-${type}-slug` },
    });
    const nativeOldUrl = `${site.site}/native-old-${type}-slug/`;
    assert.equal((await fetch(nativeOldUrl)).status, 200);
    await site.php(
      `wp_update_post(['ID' => ${nativeId}, 'post_name' => 'native-new-${type}-slug']);`,
    );
    const nativeOld = await fetch(nativeOldUrl, { redirect: 'manual' });
    t.diagnostic(`Native old ${type} URL status: ${nativeOld.status}`);
    await withDocument(
      site,
      { content, type, extra: { post_name: `old-${type}-slug` } },
      async ({ blockwork, doc: connected, id, before }) => {
        const oldUrl = `${site.site}/old-${type}-slug/`;
        assert.equal((await fetch(oldUrl)).status, 200);
        check(await blockwork.edit({ post: { slug: `new-${type}-slug` } }));
        const saved = await blockwork.save();
        await assertSavedCleanly(site, id, before, saved, { allow: ['slug', 'meta'] });
        assert.ok(saved.link.includes(`new-${type}-slug`));
        assert.equal((await fetch(saved.link)).status, 200);
        const old = await fetch(oldUrl, { redirect: 'manual' });
        assert.equal(
          old.status,
          nativeOld.status,
          'Blockwork differs from the native slug-change result',
        );

        if (new URL(connected.link).searchParams.has('page_id')) {
          assert.equal((await fetch(connected.link)).status, 200);
        }

        if (type === 'post') {
          assert.equal(old.headers.get('location'), saved.link);
        }
      },
    );
  });
}

test('reading a plugin meta change does not adopt it, resubmitting its value does', async () => {
  await withDocument(
    site,
    { content, meta: { bw_string: 'Original' } },
    async ({ blockwork, tab, id, before }) => {
      check(await blockwork.edit({ post: { title: 'Agent title' } }));
      await site.evaluate(
        tab,
        "wp.data.dispatch('core/editor').editPost({meta: {bw_string: 'Plugin value'}})",
      );
      const refused = await blockwork.save();
      await assertRefused(site, id, before, refused, { error: 'unexpected_editor_change' });
      assert.match(refused.hint, /Reading never clears a field/);
      assert.match(JSON.stringify(refused.diagnostics), /meta.bw_string/);
      const read = await blockwork.read({ settings: true });
      check(read);
      await assertRefused(site, id, before, await blockwork.save(), {
        error: 'unexpected_editor_change',
      });
      check(
        await blockwork.edit({
          settings: { meta: { bw_string: read.settings.values.meta.bw_string } },
        }),
      );
      const { after } = await assertSavedCleanly(site, id, before, await blockwork.save(), {
        allow: ['title', 'meta'],
      });
      assert.equal(after.meta.bw_string[0], 'Plugin value');
    },
  );
});

test('shared document save returns the native link and editor URL', async () => {
  await withDocument(site, { content, type: 'wp_block' }, async ({ blockwork, id, before }) => {
    check(
      await blockwork.edit({
        scope: 'all_references',
        edits: [
          {
            op: 'update',
            path: [0],
            name: 'core/paragraph',
            attributes: { content: 'Shared change' },
          },
        ],
      }),
    );
    const saved = await blockwork.save();
    await assertSavedCleanly(site, id, before, saved);
    assert.equal(
      saved.link,
      await site.php(`wp_set_current_user(1); echo wp_json_encode(get_permalink(${id}));`),
    );
    assert.equal(saved.editor_url, `${site.site}/wp-admin/post.php?post=${id}&action=edit`);
  });
});

test(
  'an unrelated live meta key does not block a write to a different key',
  {},
  async () => {
    await withDocument(
      site,
      { content, meta: { bw_string: 'Original', bw_integer: 1 } },
      async ({ blockwork, tab, id, before }) => {
        check(await blockwork.read({ settings: true }));
        await site.evaluate(
          tab,
          "wp.data.dispatch('core/editor').editPost({meta: {bw_integer: 2}})",
        );
        check(await blockwork.edit({ settings: { meta: { bw_string: 'Requested' } } }));
        assert.equal(await site.evaluate(tab, "wp.data.select('core/editor').getEditedPostAttribute('meta').bw_integer"), 2);
        await assertRefused(site, id, before, await blockwork.save(), {
          error: 'unexpected_editor_change',
        });
        const read = await blockwork.read({ settings: true });
        check(read);
        assert.equal(read.settings.values.meta.bw_integer, 2);
        await assertRefused(site, id, before, await blockwork.save(), { error: 'unexpected_editor_change' });
        check(
          await blockwork.edit({
            settings: { meta: { bw_integer: read.settings.values.meta.bw_integer } },
          }),
        );
        const { after } = await assertSavedCleanly(site, id, before, await blockwork.save(), {
          allow: ['meta'],
        });
        assert.equal(after.meta.bw_string[0], 'Requested');
        assert.equal(after.meta.bw_integer[0], '2');
      },
    );
  },
);

test('reverting a meta patch retains a different native pending meta key', {}, async () => {
  await withDocument(site, { content, meta: { bw_string: 'Original', bw_integer: 1 } }, async ({ blockwork, tab, id, before }) => {
    check(await blockwork.read({ settings: true }));
    await site.evaluate(tab, "wp.data.dispatch('core/editor').editPost({ meta: { bw_integer: 2 } })");
    const snapshot = `(() => {
      const editor = wp.data.select('core/editor');
      const core = wp.data.select('core');
      const record = core.getEditedEntityRecord('postType', editor.getCurrentPostType(), editor.getCurrentPostId());
      const edits = core.getEntityRecordNonTransientEdits('postType', editor.getCurrentPostType(), editor.getCurrentPostId());
      return { blocks: wp.data.select('core/block-editor').getBlocks(), content: editor.getEditedPostContent(), meta: editor.getEditedPostAttribute('meta'), keys: Object.keys(edits).sort(), pending: Object.fromEntries(Object.entries(edits).map(([key, value]) => [key, typeof value === 'function' ? { callable: true, resolved: value(record) } : { callable: false, value }])), dirty: editor.isEditedPostDirty() };
    })()`;
    const pending = await site.evaluate(tab, snapshot);
    check(await blockwork.edit({ settings: { meta: { bw_string: 'Requested' } } }));
    check(await blockwork.revert());
    assert.deepEqual(await site.evaluate(tab, snapshot), pending);
    await assertRefused(site, id, before, await blockwork.save(), { error: 'unexpected_editor_change' });
  });
});

test(
  'contributor can assign an existing category without editing the term',
  {},
  async () => {
    await site.php(
      "if (!get_user_by('login', 'blockwork_contributor')) { wp_insert_user(['user_login' => 'blockwork_contributor', 'user_pass' => wp_generate_password(), 'role' => 'contributor']); }",
    );
    const permissions = await site.php(
      "$user = get_user_by('login', 'blockwork_contributor'); $taxonomy = get_taxonomy('category'); echo wp_json_encode(['assign' => user_can($user, $taxonomy->cap->assign_terms), 'edit' => user_can($user, $taxonomy->cap->edit_terms)]);",
    );
    assert.deepEqual(permissions, { assign: true, edit: false });
    await site.signIn('contributor');

    try {
      await adminCaller(async (caller, tab) => {
        const found = await caller.call({ operation: 'discover', target: { site_url: site.site } });
        check(found);
        const nativeId = await seedDocument(site, {
          content,
          type: 'post',
          status: 'draft',
          extra: { post_author: found.target.user_id },
        });
        const native = await site.evaluate(
          tab,
          `wp.apiFetch({path: '/wp/v2/posts/${nativeId}', method: 'POST', data: {categories: [1]}}).then(record => ({id: record.id, categories: record.categories}))`,
        );
        assert.equal(native.id, nativeId);
        assert.deepEqual(native.categories, [1]);
        const created = await caller.create({ target: found.target, post_type: 'post' });
        check(created);
        const id = created.document.post_id;
        const before = await storedDocument(site, id);
        check(
          await caller.edit({
            post: { title: 'Contributor category', slug: 'contributor-category', status: 'draft' },
            settings: { taxonomies: { category: [1] } },
          }),
        );
        await assertSavedCleanly(site, id, before, await caller.save(), {
          allow: ['title', 'slug', 'status', 'date'],
        });
      }, 'profile.php');
    } finally {
      await site.signIn('admin');
    }
  },
);

test('create a draft with an explicit slug then schedule its content', async () => {
  await adminCaller(async (caller) => {
    const created = await caller.create({
      target: { site_url: site.site, user_id: 1 },
      post_type: 'page',
    });
    check(created);
    const id = created.document.post_id;
    const before = await storedDocument(site, id);
    check(
      await caller.edit({
        post: {
          title: 'Scheduled creation',
          slug: 'scheduled-created-page',
          status: 'draft',
          menu_order: 6,
        },
        edits: [
          {
            op: 'insert',
            block: { name: 'core/paragraph', attributes: { content: 'Scheduled content' } },
          },
        ],
      }),
    );
    await assertSavedCleanly(site, id, before, await caller.save(), {
      allow: ['title', 'slug', 'status', 'date', 'menu_order'],
    });
    const draft = await storedDocument(site, id);
    assert.equal(draft.content, doc(paragraph('Scheduled content')));
    check(await caller.read({ settings: true }));
    check(await caller.edit({ post: { status: 'future', date_gmt: '2099-01-01T12:00:00' } }));
    const { after } = await assertSavedCleanly(site, id, draft, await caller.save(), {
      allow: ['status', 'date'],
    });
    assert.equal(after.status, 'future');
    assert.equal(after.date, '2099-01-01 12:00:00');
    assert.equal(after.menu_order, 6);
    assert.equal(after.content, draft.content);
  });
});

test('an ordinary slug collision reports the native suffix as a settled difference', async () => {
  await seedDocument(site, {
    content,
    title: 'Occupied slug',
    extra: { post_name: 'clashing-page' },
  });
  await withDocument(site, { content }, async ({ blockwork, id, before }) => {
    check(await blockwork.edit({ post: { slug: 'clashing-page' } }));
    const saved = await blockwork.save();
    refusal(saved);
    assert.equal(saved.error, 'stored_with_field_differences', JSON.stringify(saved));
    assert.equal(saved.persistence, 'applied_with_differences');
    assert.deepEqual(saved.diagnostics.fields, ['slug']);
    const after = await storedDocument(site, id);
    assert.equal(after.slug, 'clashing-page-2');
    assert.equal(after.status, before.status);
    assert.equal(after.title, before.title);
    assert.equal(after.content, before.content);
  });
});

test('a lost creation navigation result cannot create a second auto-draft', async () => {
  const count = () =>
    site.php(
      "echo wp_json_encode(count(get_posts(['post_type' => 'page', 'post_status' => 'auto-draft', 'numberposts' => -1, 'fields' => 'ids'])));",
    );
  const before = await count();
  await adminCaller(async (caller, tab) => {
    const goto = tab.goto;
    let navigations = 0;
    tab.goto = async (url) => {
      navigations++;
      await goto(url);
      throw new Error('Fixture navigation response lost');
    };

    try {
      const request = { target: { site_url: site.site, user_id: 1 }, post_type: 'page' };
      const failed = await caller.create(request);
      refusal(failed);
      assert.equal(failed.error, 'create_browser_failed', JSON.stringify(failed));
      assert.equal(failed.operation_started, true);
      await waitFor(
        site,
        tab,
        "window.wp?.data?.select('core/editor')?.__unstableIsEditorReady?.() && wp.data.select('core/editor').getCurrentPostId() > 0",
      );
      const again = await caller.create(request);
      refusal(again);
      assert.equal(again.error, 'create_already_attempted', JSON.stringify(again));
      assert.equal(navigations, 1);
      assert.equal(await count(), before + 1);
      const id = await site.evaluate(tab, "wp.data.select('core/editor').getCurrentPostId()");
      check(
        await caller.connect({
          target: { site_url: site.site, post_id: id, post_type: 'page' },
          workflow: 'background',
        }),
      );
    } finally {
      tab.goto = goto;
    }
  });
});

run();
