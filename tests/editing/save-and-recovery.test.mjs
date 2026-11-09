import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';

import { buttons, doc, group, paragraph } from './blocks.mjs';
import {
  assertRefused as harnessAssertRefused,
  assertSavedCleanly,
  seedDocument,
  startEditingSite,
  storedDocument,
  waitFor,
  withDocument,
} from './harness.mjs';

let site;
const { after, before, generated, run, test } = editingTests(import.meta.url);
before(async () => {
  site = await startEditingSite();
});
after(() => site?.[Symbol.asyncDispose]());

const seed = () => ({ content: doc(paragraph('First'), paragraph('Second')) });
const update = (path, content) => ({
  op: 'update',
  path: [path],
  name: 'core/paragraph',
  attributes: { content },
});

test('reconnect preserves pending work, and two saves then an unchanged save keep the session usable', async () => {
  await withDocument(site, seed(), async ({ blockwork, target, id, before }) => {
    assert.equal((await blockwork.edit({ edits: [update(0, 'One')] })).ok, true);
    assert.equal((await blockwork.connect({ target, workflow: 'background' })).ok, true);
    const first = await blockwork.save();
    await assertSavedCleanly(site, id, before, first);
    assert.equal(
      (await storedDocument(site, id)).content,
      doc(paragraph('One'), paragraph('Second')),
    );
    assert.equal((await blockwork.edit({ edits: [update(1, 'Two')] })).ok, true);
    const second = await blockwork.save();
    await assertSavedCleanly(site, id, before, second);
    assert.equal((await storedDocument(site, id)).content, doc(paragraph('One'), paragraph('Two')));
    const unchanged = await blockwork.save();
    assert.equal(unchanged.ok, true, JSON.stringify(unchanged));
    assert.equal(unchanged.persistence, 'unchanged');
    assert.equal((await blockwork.status()).busy, false);
  });
});

test('external saved content before save refuses and identifies the field', async () => {
  await withDocument(site, seed(), async ({ blockwork, id }) => {
    assert.equal((await blockwork.edit({ edits: [update(0, 'Agent')] })).ok, true);
    await site.php(
      `wp_update_post(['ID' => ${id}, 'post_content' => ${JSON.stringify(doc(paragraph('External')))}]);`,
    );
    const external = await storedDocument(site, id);
    const result = await blockwork.save();
    await assertRefused(site, id, external, result, { error: 'saved_record_changed' });
    assert.ok(result.diagnostics.fields.includes('content'), JSON.stringify(result));
  });
});

test('attached typing elsewhere is preserved and a changed target refuses', async () => {
  await withDocument(
    site,
    seed(),
    async ({ blockwork, tab, id, before }) => {
      await site.evaluate(
        tab,
        `wp.data.dispatch('core/block-editor').updateBlockAttributes(wp.data.select('core/block-editor').getBlocks()[1].clientId, {content: 'Human'})`,
      );
      assert.equal((await blockwork.edit({ edits: [update(0, 'Agent')] })).ok, true);
      const refused = await blockwork.save();
      await assertRefused(site, id, before, refused, { error: 'save_all_pending_required' });
      const saved = await blockwork.save({ save_all_pending: true });
      await assertSavedCleanly(site, id, before, saved);
      assert.equal(
        (await storedDocument(site, id)).content,
        doc(paragraph('Agent'), paragraph('Human')),
      );
    },
    { workflow: 'attached' },
  );
  await withDocument(
    site,
    seed(),
    async ({ blockwork, tab, id, before }) => {
      await site.evaluate(
        tab,
        `wp.data.dispatch('core/block-editor').updateBlockAttributes(wp.data.select('core/block-editor').getBlocks()[0].clientId, {content: 'Human'})`,
      );
      const result = await blockwork.edit({ edits: [update(0, 'Agent')] });
      await assertRefused(site, id, before, result, { error: 'block_changed' });
    },
    { workflow: 'attached' },
  );
});

test('release of a background session rejects subsequent edits', async () => {
  await withDocument(site, seed(), async ({ blockwork, id, before }) => {
    const released = await blockwork.release();
    assert.equal(released.ok, true, JSON.stringify(released));
    assert.equal(released.cleanup, 'release_requested');
    const result = await blockwork.edit({ edits: [update(0, 'After')] });
    await assertRefused(site, id, before, result, { error: 'document_released' });
  });
});

test('attached release retains the native lock', async () => {
  await withDocument(
    site,
    seed(),
    async ({ blockwork, id }) => {
      const before = (await storedDocument(site, id)).lock;
      assert.ok(before);
      const released = await blockwork.release();
      assert.equal(released.ok, true, JSON.stringify(released));
      const retained = (await storedDocument(site, id)).lock;
      assert.equal(retained.split(':')[1], before.split(':')[1]);
      assert.ok(Number(retained.split(':')[0]) >= Number(before.split(':')[0]));
      assert.equal(released.cleanup, 'editor_retained');
    },
    { workflow: 'attached' },
  );
});

test('a foreign lock before save stops the write', async () => {
  await withDocument(site, seed(), async ({ blockwork, id, before }) => {
    assert.equal((await blockwork.edit({ edits: [update(0, 'Agent')] })).ok, true);
    await site.php(
      `$user = get_user_by('login', 'blockwork_editor'); update_post_meta(${id}, '_edit_lock', time() . ':' . $user->ID);`,
    );
    const result = await blockwork.save();
    await assertRefused(site, id, before, result, { error: 'post_locked' });
  });
});

test('a failed edit leaves nothing for an unchanged save', async () => {
  await withDocument(site, seed(), async ({ blockwork, id, before }) => {
    const failed = await blockwork.edit({
      edits: [
        { op: 'update', path: [99], name: 'core/paragraph', attributes: { content: 'No target' } },
      ],
    });
    await assertRefused(site, id, before, failed);
    const saved = await blockwork.save();
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.persistence, 'unchanged');
  });
});

test('revoked login refuses the save without losing the draft', async () => {
  await withDocument(site, seed(), async ({ blockwork, id, before, tab, target }) => {
    assert.equal((await blockwork.edit({ edits: [update(0, 'Pending')] })).ok, true);
    await site.php(`WP_Session_Tokens::get_instance(1)->destroy_all();`);

    try {
      const result = await blockwork.save();
      await assertRefused(site, id, before, result, { error: 'reauthorization_required' });
      assert.equal(
        await site.evaluate(
          tab,
          `String(wp.data.select('core/block-editor').getBlocks()[0].attributes.content)`,
        ),
        'Pending',
      );
      await site.signIn();
      assert.equal((await blockwork.connect({ target, workflow: 'background' })).ok, true);
      assert.equal(
        await site.evaluate(
          tab,
          `String(wp.data.select('core/block-editor').getBlocks()[0].attributes.content)`,
        ),
        'Pending',
      );
      await assertSavedCleanly(site, id, before, await blockwork.save());
    } finally {
      await site.signIn();
    }
  });
});

test('a same-user lock is accepted and released', async () => {
  await withDocument(site, seed(), async ({ blockwork, id, before }) => {
    const lock = (await storedDocument(site, id)).lock;
    assert.match(lock, /:1$/);
    assert.equal((await blockwork.edit({ edits: [update(0, 'After')] })).ok, true);
    await assertSavedCleanly(site, id, before, await blockwork.save());
    const released = await blockwork.release();
    assert.equal(released.cleanup, 'release_requested');
    const after = (await storedDocument(site, id)).lock;
    assert.ok(
      !after || Number(String(after).split(':')[0]) < Date.now() / 1000 - 140,
      String(after),
    );
  });
});

function assertGuidance(result) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(result.error);
  assert.ok(result.hint?.length > 10);
  assert.ok(result.next);

  if (['browser_command_failed', 'browser_operation_pending'].includes(result.error)) {
    assert.ok(result.diagnostics?.stage, JSON.stringify(result));
  } else {
    assert.ok(
      result.editor_result || result.persistence || result.operation_started === false,
      JSON.stringify(result),
    );
  }

  const { debug: _debug, ...publicResult } = result;
  assert.doesNotMatch(
    JSON.stringify(publicResult),
    /fixture-secret|fixture-nonce|fixture-server-message/,
  );
}

const transportCases = [
  {
    name: 'lost committed response',
    stage: 'Response',
    decision: 'fail',
    outcome: 'matched_desired',
  },
  {
    name: 'lost request before commit',
    stage: 'Request',
    decision: 'fail',
    outcome: 'unchanged_original',
  },
  {
    name: 'server 500 before commit',
    stage: 'Request',
    decision: {
      status: 500,
      body: '{"code":"fixture_failure","message":"fixture-server-message fixture-secret"}',
    },
    outcome: 'unchanged_original',
  },
  {
    name: 'nonce failure before commit',
    stage: 'Request',
    decision: {
      status: 403,
      body: '{"code":"rest_cookie_invalid_nonce","message":"fixture-nonce fixture-secret"}',
    },
    outcome: 'unchanged_original',
  },
  {
    name: 'non-JSON after commit',
    stage: 'Response',
    decision: {
      status: 200,
      body: 'fixture-server-message fixture-secret',
      contentType: 'text/html',
    },
    outcome: 'matched_desired',
  },
  {
    name: 'PHP notice before JSON after commit',
    stage: 'Response',
    decision: { status: 200, body: 'Notice: fixture-server-message fixture-secret\n{"id":1}' },
    outcome: 'matched_desired',
  },
];

generated(
  'document read failures have authored recovery guidance and no injected secrets',
  { findings: [] },
  async (t) => {
    const scenarios = [
      { error: 'fetch_error', decision: 'fail' },
      {
        error: 'permission_denied',
        decision: {
          status: 403,
          body: '{"code":"rest_cannot_edit","message":"fixture-server-message fixture-secret fixture-nonce","data":{"status":403}}',
        },
      },
      { error: 'request_timeout', decision: 'hold' },
    ].filter((scenario) => t.selected(scenario.error));

    if (!scenarios.length) return;
    await withDocument(site, seed(), async ({ blockwork, tab, id, before }) => {
      assert.equal((await blockwork.edit({ edits: [update(0, 'Pending')] })).ok, true);

      for (const scenario of scenarios) {
        const leaf = await t.test(scenario.error, async () => {
          let resume;
          const gate = new Promise((resolve) => {
            resume = resolve;
          });
          let reads = 0;
          // A timed-out fetch loses its interception ID before the gate opens.
          // Keep that expected cancellation out of the harness's async listener.
          const interceptTab =
            scenario.decision === 'hold'
              ? {
                  ...tab,
                  cdp: {
                    send: async (method, ...args) => {
                      try {
                        return await tab.cdp.send(method, ...args);
                      } catch (error) {
                        if (
                          method === 'Fetch.continueRequest' &&
                          /Invalid InterceptionId|Fetch domain is not enabled/.test(error.message)
                        )
                          return;

                        throw error;
                      }
                    },
                  },
                }
              : tab;
          const stop = await site.intercept(interceptTab, {
            urlPattern: '*wp-json*',
            stage: 'Request',
            decide: async ({ request }) => {
              if (request.method !== 'GET' || !request.url.includes(`/pages/${id}`)) return 'pass';
              reads++;

              if (scenario.decision === 'hold') {
                await gate;

                return 'pass';
              }

              return scenario.decision;
            },
          });

          try {
            const result = await blockwork.save();
            assert.ok(reads > 0);
            await assertRefused(site, id, before, result, { error: scenario.error });
          } finally {
            resume();
            await site.evaluate(tab, 'true');
            await stop();
          }
        });

        if (!leaf.completed) return;
        const status = await blockwork.status();
        assert.equal(status.ok, true, JSON.stringify(status));
        assert.equal(Boolean(status.busy), false, JSON.stringify(status));
        assert.notEqual(status.persistence, 'uncertain', JSON.stringify(status));
        assert.ok(
          !['partial', 'uncertain', 'running'].includes(status.last_request?.outcome),
          JSON.stringify(status),
        );
      }
    });
  },
);

for (const scenario of transportCases) {
  test(`save recovery handles ${scenario.name} without replay`, async () => {
    await withDocument(site, seed(), async ({ blockwork, tab, id, before }) => {
      assert.equal((await blockwork.edit({ edits: [update(0, 'Desired')] })).ok, true);
      let writes = 0;
      const stop = await site.intercept(tab, {
        urlPattern: '*wp-json*',
        stage: scenario.stage,
        decide: ({ request }) => {
          if (!['POST', 'PUT'].includes(request.method) || !request.url.includes(`/pages/${id}`))
            return 'pass';
          writes++;

          return scenario.decision;
        },
      });
      let saved;

      try {
        saved = await blockwork.save();
      } finally {
        await stop();
      }

      assertGuidance(saved);

      if (scenario.name === 'nonce failure before commit') {
        assert.equal(saved.error, 'browser_operation_pending', JSON.stringify(saved));
        assert.equal(saved.diagnostics.stage, 'poll');
        assert.ok(saved.diagnostics.job_id);
        assert.ok(await blockwork.read_receipt());

        return;
      }

      assert.equal(saved.persistence, 'uncertain', JSON.stringify(saved));
      assert.match(saved.next, /verify|recover/);
      const receipt = await blockwork.read_receipt();
      assert.ok(receipt);
      const blocked = await blockwork.save();
      assertGuidance(blocked);
      assert.equal(blocked.error, 'save_unresolved');
      assert.equal(writes, 1, 'a failed response must not replay the write');
      const fresh = await site.openTab(`${site.site}/wp-admin/index.php?page=bw-recovery`);

      try {
        await waitFor(site, fresh, 'window.wp?.apiFetch');
        const caller = await site.createCaller(fresh);
        const recovered = await caller.call({
          operation: 'recover',
          target: receipt.target,
          receipt,
        });
        assert.equal(recovered.outcome, scenario.outcome, JSON.stringify(recovered));

        if (scenario.outcome === 'matched_desired') {
          assert.equal(recovered.persistence, 'verified');
          assert.equal(
            (await storedDocument(site, id)).content,
            doc(paragraph('Desired'), paragraph('Second')),
          );
        } else {
          assertGuidance(recovered);
          assert.equal(recovered.error, 'save_not_applied');
          assert.equal((await storedDocument(site, id)).content, before.content);
        }

        await site.php(
          `wp_update_post(['ID' => ${id}, 'post_content' => 'Later writer', 'post_title' => 'Later title']);`,
        );
        const different = await caller.call({
          operation: 'recover',
          target: receipt.target,
          receipt,
        });
        assertGuidance(different);
        assert.equal(different.error, 'saved_record_different');
        assert.equal(different.outcome, 'different');
        assert.equal((await storedDocument(site, id)).content, 'Later writer');
      } finally {
        await fresh.close();
      }
    });
  });
}

for (const moment of ['before edit', 'during edit', 'after edit']) {
  test(`foreign lock ${moment} refuses and release preserves its owner`, async () => {
    await withDocument(site, seed(), async ({ blockwork, tab, id, before }) => {
      if (moment === 'after edit')
        assert.equal((await blockwork.edit({ edits: [update(0, 'Pending')] })).ok, true);
      await site.php(
        `$u = get_user_by('login', 'blockwork_editor'); update_post_meta(${id}, '_edit_lock', time() . ':' . $u->ID);`,
      );
      const lock = (await storedDocument(site, id)).lock;

      if (moment === 'before edit') {
        await site.evaluate(
          tab,
          `wp.data.dispatch('core/editor').updatePostLock({isLocked: true, user: {id: 2, name: 'Fixture editor'}})`,
        );
      }

      if (moment === 'during edit') {
        await site.evaluate(
          tab,
          `(() => {
          const unsubscribe = wp.data.subscribe(() => {
            if (String(wp.data.select('core/block-editor').getBlocks()[0].attributes.content) === 'Pending') {
              unsubscribe();
              wp.data.dispatch('core/editor').updatePostLock({isLocked: true, user: {id: 2, name: 'Fixture editor'}});
            }
          });
        })()`,
        );
      }

      const edits =
        moment === 'during edit'
          ? [update(0, 'Pending'), update(1, 'After takeover')]
          : [update(0, 'Pending')];
      const refused =
        moment === 'after edit' ? await blockwork.save() : await blockwork.edit({ edits });
      await assertRefused(site, id, before, refused, { error: 'post_locked' });
      assertGuidance(refused);

      if (moment === 'during edit')
        assert.equal(
          await site.evaluate(
            tab,
            `String(wp.data.select('core/block-editor').getBlocks()[1].attributes.content)`,
          ),
          'Second',
        );

      await waitFor(site, tab, `!wp.data.select('core/editor').isSavingPost()`);
      const released = await blockwork.release();
      assert.equal(released.ok, true, JSON.stringify(released));
      assert.equal(released.cleanup, 'not_owned', JSON.stringify(released));
      assert.equal((await storedDocument(site, id)).lock, lock);
    });
  });
}

for (const workflow of ['background', 'attached']) {
  test(`${workflow} recreated caller reconnects without losing pending work`, async () => {
    await withDocument(
      site,
      seed(),
      async ({ blockwork, tab, target, id, before }) => {
        assert.equal((await blockwork.edit({ edits: [update(0, 'Pending')] })).ok, true);
        const replacement = await site.createCaller(tab);
        assert.equal((await replacement.connect({ target, workflow })).ok, true);
        assert.equal(
          await site.evaluate(
            tab,
            `String(wp.data.select('core/block-editor').getBlocks()[0].attributes.content)`,
          ),
          'Pending',
        );
        await assertSavedCleanly(
          site,
          id,
          before,
          await replacement.save({ save_all_pending: true }),
        );
        assert.equal(
          (await storedDocument(site, id)).content,
          doc(paragraph('Pending'), paragraph('Second')),
        );
      },
      { workflow },
    );
  });
}

test('two same-account tabs detect the first saved write before the second saves', async () => {
  await withDocument(site, seed(), async ({ blockwork, target, id, tab, before }) => {
    const other = await site.openTab(tab.url);
    const caller = await site.createCaller(other);

    try {
      assert.equal((await caller.connect({ target, workflow: 'attached' })).ok, true);
      assert.equal((await caller.edit({ edits: [update(1, 'Second tab')] })).ok, true);
      assert.equal((await blockwork.edit({ edits: [update(0, 'First tab')] })).ok, true);
      await assertSavedCleanly(site, id, before, await blockwork.save());
      const stored = await storedDocument(site, id);
      const refused = await caller.save({ save_all_pending: true });
      await assertRefused(site, id, stored, refused, { error: 'saved_record_changed' });
      assertGuidance(refused);
    } finally {
      await caller.release();
      await other.close();
    }
  });
});

test('unexpected background typing must be read before saving', async () => {
  await withDocument(site, seed(), async ({ blockwork, tab, id, before, doc: connected }) => {
    await site.evaluate(
      tab,
      `wp.data.dispatch('core/block-editor').updateBlockAttributes(wp.data.select('core/block-editor').getBlocks()[1].clientId, {content: 'Unreviewed'})`,
    );
    const refused = await blockwork.save();
    await assertRefused(site, id, before, refused, { error: 'unexpected_editor_change' });
    assertGuidance(refused);
    assert.ok(refused.diagnostics.blocks.length);
    assert.equal(
      (await blockwork.read({ blocks: { client_id: connected.blocks[1].client_id, depth: 1 } })).ok,
      true,
    );
    await assertSavedCleanly(site, id, before, await blockwork.save());
    assert.equal(
      (await storedDocument(site, id)).content,
      doc(paragraph('First'), paragraph('Unreviewed')),
    );
  });
});

for (const workflow of ['background', 'attached']) {
  test(`${workflow} preserves persisted Code Mode and user preferences`, async () => {
    const preferences = {
      _modified: new Date().toISOString(),
      core: {
        editorMode: 'text',
        distractionFree: true,
        fixedToolbar: true,
        isComplementaryAreaVisible: true,
      },
      'core/edit-post': {
        fullscreenMode: true,
        spotlightMode: true,
        welcomeGuide: true,
        isListViewOpened: true,
      },
      'core/editor': { deviceType: 'Mobile' },
    };
    const original = await site.php(
      `echo wp_json_encode(get_user_meta(1, 'wp_persisted_preferences', true));`,
    );
    const encoded = Buffer.from(JSON.stringify(preferences)).toString('base64');
    await site.php(
      `update_user_meta(1, 'wp_persisted_preferences', json_decode(base64_decode('${encoded}'), true));`,
    );

    try {
      await withDocument(
        site,
        { content: group(paragraph('Nested')) },
        async ({ blockwork, doc: connected, tab, id, before }) => {
          const openedPreferences = await site.php(
            `echo wp_json_encode(get_user_meta(1, 'wp_persisted_preferences', true));`,
          );

          if (workflow === 'attached') assert.equal(connected.editor_mode, 'text');
          assert.equal(
            await site.evaluate(tab, `wp.data.select('core/editor').getEditorMode()`),
            workflow === 'attached' ? 'text' : 'visual',
          );

          if (workflow === 'attached') {
            const refused = await blockwork.measure({ blocks: [connected.blocks[0].client_id] });
            assertGuidance(refused);
            assert.equal(refused.error, 'editor_code_mode');
            const insert = await blockwork.edit({
              edits: [
                {
                  op: 'insert',
                  parent: [0],
                  block: { name: 'core/paragraph', attributes: { content: 'Nested insert' } },
                },
              ],
            });
            await assertRefused(site, id, before, insert, { error: 'editor_code_mode' });
          } else {
            assert.equal(
              (
                await blockwork.edit({
                  edits: [
                    {
                      op: 'insert',
                      parent: [0],
                      block: { name: 'core/paragraph', attributes: { content: 'Nested insert' } },
                    },
                  ],
                })
              ).ok,
              true,
            );
            await assertSavedCleanly(site, id, before, await blockwork.save());
          }

          const current = await site.php(
            `echo wp_json_encode(get_user_meta(1, 'wp_persisted_preferences', true));`,
          );
          assert.equal(current.core.editorMode, 'text');
          const { _modified: _openedModified, ...openedValues } = openedPreferences;
          const { _modified: _currentModified, ...currentValues } = current;
          assert.deepEqual(currentValues, openedValues);
        },
        { workflow },
      );
    } finally {
      const restore = Buffer.from(JSON.stringify(original)).toString('base64');
      await site.php(
        `update_user_meta(1, 'wp_persisted_preferences', json_decode(base64_decode('${restore}'), true));`,
      );
    }
  });
}

for (const scenario of [
  {
    name: 'nothing has been edited',
    action: async (blockwork) => blockwork.revert(),
    error: 'revert_not_available',
  },
  {
    name: 'human typing follows an edit',
    action: async (blockwork, tab) => {
      assert.equal((await blockwork.edit({ edits: [update(0, 'Agent')] })).ok, true);
      await site.evaluate(
        tab,
        `wp.data.dispatch('core/block-editor').updateBlockAttributes(wp.data.select('core/block-editor').getBlocks()[0].clientId, {content: 'Human'})`,
      );

      return blockwork.revert();
    },
    error: 'intervening_editor_change',
  },
]) {
  test(`revert refuses when ${scenario.name}`, async () => {
    await withDocument(
      site,
      seed(),
      async ({ blockwork, tab, id, before }) => {
        const result = await scenario.action(blockwork, tab);
        await assertRefused(site, id, before, result, { error: scenario.error });
        assertGuidance(result);
      },
      { workflow: 'attached' },
    );
  });
}

test('verification read failure keeps committed save uncertain and recoverable', async () => {
  await withDocument(site, seed(), async ({ blockwork, tab, id }) => {
    assert.equal((await blockwork.edit({ edits: [update(0, 'Committed')] })).ok, true);
    let wrote = false;
    const stop = await site.intercept(tab, {
      urlPattern: '*wp-json*',
      stage: 'Response',
      decide: ({ request }) => {
        if (!request.url.includes(`/pages/${id}`)) return 'pass';

        if (['POST', 'PUT'].includes(request.method)) wrote = true;

        return wrote && request.method === 'GET' ? 'fail' : 'pass';
      },
    });
    let result;

    try {
      result = await blockwork.save();
    } finally {
      await stop();
    }

    assertGuidance(result);
    assert.equal(result.persistence, 'uncertain');
    const receipt = await blockwork.read_receipt();
    assert.ok(receipt);
    const recovered = await blockwork.call({ operation: 'recover', receipt });
    assert.equal(recovered.outcome, 'matched_desired', JSON.stringify(recovered));
    assert.equal(
      (await storedDocument(site, id)).content,
      doc(paragraph('Committed'), paragraph('Second')),
    );
  });
});

test('external write between connect and edit is caught before save', async () => {
  await withDocument(site, seed(), async ({ blockwork, id }) => {
    await site.php(`wp_update_post(['ID' => ${id}, 'post_title' => 'External title']);`);
    assert.equal((await blockwork.edit({ edits: [update(0, 'Pending')] })).ok, true);
    const before = await storedDocument(site, id);
    const refused = await blockwork.save();
    await assertRefused(site, id, before, refused, { error: 'saved_record_changed' });
    assertGuidance(refused);
    assert.ok(refused.diagnostics.fields.includes('title'));
  });
});

test('status reports a paused running save and the settled result', async () => {
  await withDocument(site, seed(), async ({ blockwork, tab, id, before }) => {
    assert.equal((await blockwork.edit({ edits: [update(0, 'After')] })).ok, true);
    let resume;
    let paused;
    const ready = new Promise((resolve) => {
      paused = resolve;
    });
    const gate = new Promise((resolve) => {
      resume = resolve;
    });
    const stop = await site.intercept(tab, {
      urlPattern: '*wp-json*',
      stage: 'Response',
      decide: async ({ request }) => {
        if (request.url.includes(`/pages/${id}`) && ['POST', 'PUT'].includes(request.method)) {
          paused();
          await gate;
        }

        return 'pass';
      },
    });
    const saving = blockwork.save();
    let runningStatus;

    try {
      await Promise.race([
        ready,
        saving.then(() => {
          throw new Error('Save ended without an intercepted write');
        }),
      ]);
      runningStatus = await blockwork.status();
    } finally {
      resume();

      try {
        await saving;
      } finally {
        await stop();
      }
    }

    await assertSavedCleanly(site, id, before, await saving);
    const status = await blockwork.status();
    assert.equal(status.busy, false);
    assert.equal(status.persistence, 'verified');
    assert.equal(status.last_request.outcome, 'saved');
    // One caller runs one operation at a time, as invocation.md documents.
    assert.equal(runningStatus.error, 'host_operation_in_progress', JSON.stringify(runningStatus));
    assert.equal(runningStatus.next, 'wait_for_host_operation');
  });
});

test('a later writer during save verification is never reported as the desired save', async () => {
  await withDocument(site, seed(), async ({ blockwork, tab, id }) => {
    assert.equal((await blockwork.edit({ edits: [update(0, 'Desired')] })).ok, true);
    const stop = await site.intercept(tab, {
      urlPattern: '*wp-json*',
      stage: 'Response',
      decide: async ({ request }) => {
        if (request.url.includes(`/pages/${id}`) && ['POST', 'PUT'].includes(request.method)) {
          await site.php(`wp_update_post(['ID' => ${id}, 'post_content' => 'Later writer']);`);
        }

        return 'pass';
      },
    });
    let result;

    try {
      result = await blockwork.save();
    } finally {
      await stop();
    }

    assertGuidance(result);
    assert.equal(result.error, 'verification_mismatch');
    assert.equal(result.persistence, 'uncertain');
    const receipt = await blockwork.read_receipt();
    assert.ok(receipt);
    const recovered = await blockwork.call({ operation: 'recover', receipt });
    assertGuidance(recovered);
    assert.equal(recovered.error, 'saved_record_different');
    assert.equal((await storedDocument(site, id)).content, 'Later writer');
  });
});

for (const scenario of ['foreign lock', 'pending draft']) {
  test(`background connect refuses ${scenario} without adopting it`, async () => {
    const id = await seedDocument(site, seed());
    const before = await storedDocument(site, id);
    const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);
    const caller = await site.createCaller(tab);

    try {
      await waitFor(
        site,
        tab,
        `window.wp?.data?.select('core/editor')?.__unstableIsEditorReady?.()`,
      );

      if (scenario === 'foreign lock') {
        await site.php(
          `$u = get_user_by('login', 'blockwork_editor'); update_post_meta(${id}, '_edit_lock', time() . ':' . $u->ID);`,
        );
      } else {
        await site.evaluate(
          tab,
          `wp.data.dispatch('core/block-editor').updateBlockAttributes(wp.data.select('core/block-editor').getBlocks()[0].clientId, {content: 'Human pending'})`,
        );
      }

      const result = await caller.connect({
        target: { site_url: site.site, post_id: id, post_type: 'page' },
        workflow: 'background',
      });
      await assertRefused(site, id, before, result, {
        error: scenario === 'foreign lock' ? 'post_locked' : 'editor_not_clean',
      });
      assertGuidance(result);

      if (scenario === 'pending draft')
        assert.equal(
          await site.evaluate(
            tab,
            `String(wp.data.select('core/block-editor').getBlocks()[0].attributes.content)`,
          ),
          'Human pending',
        );
    } finally {
      await caller.release();
      await tab.close();
    }
  });
}

for (const interruption of ['reload', 'closed tab']) {
  test(`${interruption} ends the original page session with usable recovery guidance`, async () => {
    await withDocument(site, seed(), async ({ blockwork, tab, id, before }) => {
      assert.equal((await blockwork.edit({ edits: [update(0, 'Unsaved')] })).ok, true);

      if (interruption === 'reload') {
        await tab.goto(tab.url);
        await waitFor(
          site,
          tab,
          `window.wp?.data?.select('core/editor')?.__unstableIsEditorReady?.()`,
        );
      } else {
        await tab.close();
      }

      const result = await blockwork.edit({ edits: [update(1, 'After interruption')] });
      await assertRefused(site, id, before, result);
      assertGuidance(result);
    });
  });
}

test('native autosave in an attached draft does not prevent its explicit save', async () => {
  await withDocument(
    site,
    { ...seed(), status: 'draft' },
    async ({ blockwork, tab, id, before }) => {
      assert.equal((await blockwork.edit({ edits: [update(0, 'Autosaved draft')] })).ok, true);
      await site.evaluate(tab, `wp.data.dispatch('core/editor').autosave()`);
      await waitFor(site, tab, `!wp.data.select('core/editor').isSavingPost()`);
      const result = await blockwork.save({ save_all_pending: true });

      if (result.persistence !== 'unchanged')
        await assertSavedCleanly(site, id, before, result, { allow: ['date'] });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(
        (await storedDocument(site, id)).content,
        doc(paragraph('Autosaved draft'), paragraph('Second')),
      );
    },
    { workflow: 'attached' },
  );
});

test('Heartbeat refreshes the background native lock', async () => {
  await withDocument(site, seed(), async ({ blockwork, tab, id, before }) => {
    await site.php(`update_post_meta(${id}, '_edit_lock', (time() - 30) . ':1');`);
    await site.evaluate(
      tab,
      `new Promise((resolve) => {
      wp.hooks.addAction('heartbeat.tick', 'bw-test/renewed', (data) => {
        if (data['wp-refresh-post-lock']?.new_lock) {
          wp.hooks.removeAction('heartbeat.tick', 'bw-test/renewed');
          resolve();
        }
      });
      wp.heartbeat.connectNow();
    })`,
    );
    assert.ok(Number((await storedDocument(site, id)).lock.split(':')[0]) > Date.now() / 1000 - 20);
    assert.match((await storedDocument(site, id)).lock, /:1$/);
    assert.equal((await blockwork.edit({ edits: [update(0, 'Heartbeat alive')] })).ok, true);
    await assertSavedCleanly(site, id, before, await blockwork.save());
  });
});

test('changes during connect lock acquisition cannot become reviewed content', async () => {
  const id = await seedDocument(site, seed());
  const before = await storedDocument(site, id);
  const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);
  const caller = await site.createCaller(tab);
  await waitFor(site, tab, `window.wp?.data?.select('core/editor')?.__unstableIsEditorReady?.()`);
  let changed = false;
  const stop = await site.intercept(tab, {
    urlPattern: '*admin-ajax.php*',
    stage: 'Response',
    decide: async ({ request }) => {
      if (!changed && request.postData?.includes('heartbeat')) {
        changed = true;
        await site.evaluate(
          tab,
          `wp.data.dispatch('core/block-editor').updateBlockAttributes(wp.data.select('core/block-editor').getBlocks()[1].clientId, {content: 'During lock acquisition'})`,
        );
      }

      return 'pass';
    },
  });

  try {
    const result = await caller.connect({
      target: { site_url: site.site, post_id: id, post_type: 'page' },
      workflow: 'background',
    });
    assert.equal(changed, true, 'the connect Heartbeat must have been intercepted');
    await assertRefused(site, id, before, result, { error: 'editor_not_clean' });
    assertGuidance(result);
  } finally {
    await stop();
    await caller.release();
    await tab.close();
  }
});

test('lost settings-only save cannot claim an unapplied write after a foreign field changes', async () => {
  await withDocument(site, seed(), async ({ blockwork, tab, id }) => {
    const edited = await blockwork.edit({ post: { title: 'Desired title' } });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    const stop = await site.intercept(tab, {
      urlPattern: '*wp-json*',
      stage: 'Request',
      decide: ({ request }) =>
        request.url.includes(`/pages/${id}`) && ['POST', 'PUT'].includes(request.method)
          ? 'fail'
          : 'pass',
    });

    try {
      const result = await blockwork.save();
      assertGuidance(result);
      assert.equal(result.persistence, 'uncertain');
    } finally {
      await stop();
    }

    const receipt = await blockwork.read_receipt();
    await site.php(`wp_update_post(['ID' => ${id}, 'post_excerpt' => 'Foreign excerpt']);`);
    const recovered = await blockwork.call({ operation: 'recover', receipt });
    assertGuidance(recovered);
    assert.equal(recovered.error, 'saved_record_different');
    assert.equal(recovered.outcome, 'different');
    assert.equal((await storedDocument(site, id)).title, 'Editing case');
    assert.equal((await storedDocument(site, id)).excerpt, 'Foreign excerpt');
  });
});

async function assertRefused(site, id, before, result, options) {
  await harnessAssertRefused(site, id, before, result, options);
  assertGuidance(result);
}

test('connect preserves a native local autosave backup without restoring it', async () => {
  const id = await seedDocument(site, seed());
  const before = await storedDocument(site, id);
  const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);
  const caller = await site.createCaller(tab);

  try {
    await waitFor(site, tab, `window.wp?.data?.select('core/editor')?.__unstableIsEditorReady?.()`);
    await site.evaluate(
      tab,
      `wp.data.dispatch('core/block-editor').updateBlockAttributes(wp.data.select('core/block-editor').getBlocks()[0].clientId, {content: 'Local backup pending'})`,
    );
    await site.evaluate(tab, `wp.data.dispatch('core/editor').autosave({local: true})`);
    const backup = await site.evaluate(
      tab,
      `Object.entries(sessionStorage).filter(([, value]) => value.includes('Local backup pending'))`,
    );
    assert.ok(backup.length, 'native local autosave must create a browser backup');
    await tab.goto(tab.url);
    const result = await caller.connect({
      target: { site_url: site.site, post_id: id, post_type: 'page' },
      workflow: 'background',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await storedDocument(site, id)).content, before.content);
    assert.equal(
      await site.evaluate(tab, `wp.data.select('core/editor').getEditedPostContent()`),
      before.content,
    );
    assert.deepEqual(
      await site.evaluate(
        tab,
        `Object.entries(sessionStorage).filter(([, value]) => value.includes('Local backup pending'))`,
      ),
      backup,
    );
  } finally {
    await caller.release();
    await tab.close();
  }
});

test('newer server autosave is not silently restored or overwritten at connect', async () => {
  const id = await seedDocument(site, seed());
  await site.php(
    `wp_set_current_user(1); $post = get_post(${id}, ARRAY_A); $post['post_title'] = 'Autosave title'; $post['post_content'] = 'Server autosave pending'; $revision = _wp_put_post_revision($post, true); $wpdb->update($wpdb->posts, ['post_modified' => gmdate('Y-m-d H:i:s', time() + 60), 'post_modified_gmt' => gmdate('Y-m-d H:i:s', time() + 60)], ['ID' => $revision]); clean_post_cache($revision);`,
  );
  const before = await storedDocument(site, id);
  const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);
  const caller = await site.createCaller(tab);

  try {
    const result = await caller.connect({
      target: { site_url: site.site, post_id: id, post_type: 'page' },
      workflow: 'background',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await storedDocument(site, id)).content, before.content);
    assert.equal(
      await site.evaluate(tab, `wp.data.select('core/editor').getEditedPostContent()`),
      before.content,
    );
    const autosave = await site.php(
      `echo wp_json_encode(wp_get_post_autosave(${id}, 1)->post_content);`,
    );
    assert.equal(autosave, 'Server autosave pending');
    assert.equal(
      await site.php(
        `echo wp_json_encode(strtotime(wp_get_post_autosave(${id}, 1)->post_modified_gmt) > strtotime(get_post(${id})->post_modified_gmt));`,
      ),
      true,
    );
  } finally {
    await caller.release();
    await tab.close();
  }
});

test('native template children remain unread after inserting another child', async () => {
  await withDocument(
    site,
    { content: doc(buttons(), paragraph('Neighbor')) },
    async ({ blockwork, tab, id, before }) => {
      const edited = await blockwork.edit({
        edits: [
          {
            op: 'insert',
            parent: [0],
            block: { name: 'core/button', attributes: { text: 'Requested' } },
          },
        ],
      });
      assert.equal(edited.ok, true, JSON.stringify(edited));
      const result = await blockwork.save();
      await assertRefused(site, id, before, result, { error: 'unexpected_editor_change' });
      assert.ok(result.diagnostics.blocks.length);
      assert.equal(
        await site.evaluate(
          tab,
          `String(wp.data.select('core/block-editor').getBlocks()[1].attributes.content)`,
        ),
        'Neighbor',
      );
    },
  );
});

test('planning preserves a native serialization hook change and refuses the stale plan', async () => {
  await withDocument(site, seed(), async ({ blockwork, tab, id, before }) => {
    await site.evaluate(
      tab,
      `wp.hooks.addFilter('blocks.getSaveContent.extraProps', 'bw-test/planning', (props) => {
      wp.hooks.removeFilter('blocks.getSaveContent.extraProps', 'bw-test/planning');
      queueMicrotask(() => wp.data.dispatch('core/block-editor').updateBlockAttributes(wp.data.select('core/block-editor').getBlocks()[1].clientId, {content: 'Concurrent typing'}));
      return props;
    })`,
    );

    try {
      const result = await blockwork.edit({ edits: [update(0, 'Requested')] });
      await assertRefused(site, id, before, result, { error: 'editor_content_changed' });
      assert.equal(result.editor_result, 'not_applied');
      assert.equal(
        await site.evaluate(
          tab,
          `String(wp.data.select('core/block-editor').getBlocks()[1].attributes.content)`,
        ),
        'Concurrent typing',
      );
    } finally {
      await site.evaluate(
        tab,
        `wp.hooks.removeFilter('blocks.getSaveContent.extraProps', 'bw-test/planning')`,
      );
    }
  });
});

run();
