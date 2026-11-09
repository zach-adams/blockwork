import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fixtureControl } from '../../tools/fixture-control.mjs';

// This module runs inside the desktop host's cua_repl, not a separate browser.
export async function createDesktopSuite(cua, descriptor, sourcePath, artifactDir) {
  for (const url of [descriptor.target.site_url, descriptor.control_url]) {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'Use a disposable loopback fixture.');
  }

  const source = await readFile(sourcePath, 'utf8');
  const built = await readFile(
    new URL('../../skills/blockwork/scripts/editor.js', import.meta.url),
    'utf8',
  );
  assert.equal(source, built, 'Installed Blockwork must match the checkout bundle.');
  await mkdir(artifactDir, { recursive: true });
  const report = {
    run_id: randomUUID(),
    wordpress: descriptor.state.wordpress,
    fixture_timings: descriptor.timings,
    engine_sha256: createHash('sha256').update(source).digest('hex'),
    cases: [],
  };
  let account;
  let current;
  let trace;
  const sessions = new Set();
  const targetFor = (document, actor = 'admin') => {
    const { post_id, post_type } = descriptor.state.documents[document];

    return {
      site_url: descriptor.target.site_url,
      user_id: descriptor.state.accounts[actor],
      post_id,
      post_type,
    };
  };

  async function evaluate(capability, expression, timeoutMs = 45000) {
    const result = await capability.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      { timeoutMs },
    );
    assert.ok(!result.exceptionDetails, 'Privileged page evaluation threw.');

    return result.result.value;
  }

  async function operation(session, request) {
    const started = performance.now();
    const result = await evaluate(session.capability, `${source}(${JSON.stringify(request)})`);
    trace.push({
      operation: request.operation,
      target: request.target,
      duration_ms: performance.now() - started,
      result,
    });

    return result;
  }

  async function open(document, actor = 'admin', editor_url, forceLogin = false) {
    const target = targetFor(document, actor);
    const url =
      editor_url ?? `${target.site_url}/wp-admin/post.php?post=${target.post_id}&action=edit`;
    const login = account !== actor || forceLogin;
    const tab = await cua.createBrowserTab('iab', undefined, { visible: false });
    await tab.goto(
      login
        ? `${target.site_url}/wp-login.php?reauth=1&redirect_to=${encodeURIComponent(url)}`
        : url,
    );
    const session = { tab, target };
    sessions.add(session);
    const dom = await tab.playwright.domSnapshot();

    if (login || dom.includes('Username or Email Address')) {
      const credentials = await fixtureControl(descriptor, 'credentials', document, actor);
      await tab.playwright
        .getByLabel('Username or Email Address', { exact: true })
        .fill(credentials.username);
      await tab.playwright.getByLabel('Password', { exact: true }).fill(credentials.password);
      await tab.playwright.expectNavigation(
        () => tab.playwright.getByRole('button', { name: 'Log In', exact: true }).click(),
        { timeoutMs: 20000, url },
      );
      account = actor;
      await tab.playwright.domSnapshot();
    }

    session.capability = await tab.capabilities.get('cdp');
    const ready = await evaluate(
      session.capability,
      `(async () => {
      const target = ${JSON.stringify(target)};
      const until = Date.now() + 10000;
      do {
        const editor = window.wp?.data?.select('core/editor');
        const blocks = window.wp?.data?.select('core/block-editor')?.getBlocks();
        if (editor?.getCurrentPostType() === target.post_type && String(editor.getCurrentPostId()) === String(target.post_id) && blocks?.length) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < until);
      return false;
    })()`,
      15000,
    );
    assert.ok(ready, 'Native editor did not load the exact fixture target within 10 seconds.');
    session.ready = true;
    const editorDom = await tab.playwright.domSnapshot();

    if (editorDom.includes('dialog "Welcome to the site editor"')) {
      await tab.playwright
        .getByRole('dialog', { name: 'Welcome to the site editor', exact: true })
        .getByRole('button', { name: 'Get started', exact: true })
        .click();
      await tab.playwright.domSnapshot();
    } else if (editorDom.includes('dialog "Welcome to the editor"')) {
      await tab.playwright
        .getByRole('dialog', { name: 'Welcome to the editor', exact: true })
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await tab.playwright.domSnapshot();
    }

    return session;
  }

  async function close(session) {
    try {
      if (session.capability && session.connected) {
        const release = await operation(session, { operation: 'release', target: session.target });
        current.cleanup.push(release);
      }
    } finally {
      await session.tab.close();
      sessions.delete(session);
    }
  }

  async function connect(session, workflow = 'background') {
    const { user_id: _user_id, ...target } = session.target;
    const result = await operation(session, { operation: 'connect', workflow, target, blocks: 'all' });

    if (!result.ok) {
      current.native_state = await evaluate(
        session.capability,
        `(() => {
        const editor = wp.data.select('core/editor');
        return { content: editor.getEditedPostContent(), dirty: editor.isEditedPostDirty(), blocks: wp.data.select('core/block-editor').getBlocks().map(block => ({name:block.name, attributes:block.attributes, children:block.innerBlocks.map(child => ({name:child.name, attributes:child.attributes}))})) };
      })()`,
      );
    }

    assert.equal(result.ok, true, JSON.stringify(result));
    session.connected = true;

    return result;
  }

  async function edit(session, text) {
    if (!session.connected) {
      await connect(session);
    }

    const navigation = session.target.post_type === 'wp_navigation';
    const request = {
      operation: 'edit',
      target: session.target,
      edits: [
        {
          op: 'update',
          path: [0],
          name: navigation ? 'core/navigation-link' : 'core/paragraph',
          attributes: navigation ? { label: text } : { content: text },
        },
      ],
    };

    if (['wp_template', 'wp_template_part', 'wp_navigation'].includes(session.target.post_type)) {
      request.scope = 'site_wide';
    }

    const result = await operation(session, request);
    assert.equal(result.ok, true, JSON.stringify(result));

    return result;
  }

  // The bootstrap stores this receipt before the second call; record it the same way.
  async function save(session, request = {}) {
    const prepared = await operation(session, {
      operation: 'prepare_save',
      target: session.target,
      ...request,
    });

    if (!prepared.ok || !prepared.receipt) {
      return prepared;
    }

    const receiptFile = `${current.name}-${current.receipts.length + 1}-receipt.json`;
    await writeFile(join(artifactDir, receiptFile), JSON.stringify(prepared.receipt, null, 2));
    current.receipts.push(receiptFile);
    let result;

    try {
      result = await operation(session, {
        operation: 'save',
        target: session.target,
        receipt: prepared.receipt,
        ...request,
      });
    } catch (error) {
      current.transport_failure = error.message;
      result = { ok: false, persistence: 'uncertain', error: 'save-transport-failed' };
    }

    if (result.persistence === 'uncertain') {
      const recovered = await operation(session, {
        operation: 'recover',
        target: { site_url: session.target.site_url, user_id: session.target.user_id },
        receipt: prepared.receipt,
      });

      if (recovered.ok && recovered.outcome === 'matched_desired') {
        return { ...recovered, persistence: 'verified', valid: true };
      }
    }

    return result;
  }

  async function roundtrip(document, actor = 'admin', forceLogin = false) {
    let editor_url;

    if (document.startsWith('wp_')) {
      const discovery = await open('roundtrip', actor);
      const entity = await operation(discovery, {
        operation: 'inspect_entity',
        target: targetFor(document, actor),
      });
      assert.equal(entity.ok, true, JSON.stringify(entity));
      editor_url = entity.editor_url;
      assert.ok(editor_url);
      await close(discovery);
    }

    const session = await open(document, actor, editor_url, forceLogin);
    const text = `Blockwork ${document} saved on WordPress ${descriptor.state.wordpress}. ${report.run_id.slice(0, 8)}`;
    const before = await fixtureControl(descriptor, 'snapshot', document, actor);
    await edit(session, text);
    const saved = await save(session);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.persistence, 'verified');
    assert.equal(saved.valid, true);
    const persisted = await fixtureControl(descriptor, 'snapshot', document, actor);
    assert.equal(persisted.status, before.status, 'Publication status changed.');
    assert.ok(persisted.content.includes(text), 'Server did not persist the requested change.');

    if (document !== 'wp_navigation') {
      assert.ok(persisted.content.includes('Keep this paragraph.'), 'Unedited paragraph changed.');
    }

    await close(session);
    const released = await fixtureControl(descriptor, 'snapshot', document, actor);
    current.lock_released = Number(released.lock.split(':')[0]) < Date.now() / 1000 - 10;
    const reload = await open(document, actor, editor_url);
    const fresh = await connect(reload);
    assert.equal(fresh.validity.valid, true, JSON.stringify(fresh));
    assert.ok(
      fresh.blocks.some((block) => block.preview.includes(text)),
      'Fresh editor did not load the saved content.',
    );
    await close(reload);
    assert.ok(current.lock_released, 'Owned lock remains fresh after release.');
  }

  const cases = {
    'paragraph_roundtrip': () => roundtrip('roundtrip'),
    async 'attached_draft'() {
      const session = await open('roundtrip');
      const humanTitle = `Blockwork human draft ${report.run_id}`;
      const humanText = 'Human paragraph before Blockwork';
      await evaluate(session.capability, `(() => {
        const block = wp.data.select('core/block-editor').getBlocks()[0];
        wp.element.flushSync(() => {
          wp.data.dispatch('core/editor').editPost({ title: ${JSON.stringify(humanTitle)} });
          wp.data.dispatch('core/block-editor').updateBlockAttributes(block.clientId, { content: ${JSON.stringify(humanText)} });
        });
      })()`);
      const connected = await connect(session, 'attached');
      assert.equal(connected.title, humanTitle);
      assert.equal(connected.dirty, true);
      const found = await operation(session, {
        operation: 'read', target: session.target, blocks: { search: humanText },
      });
      assert.equal(found.ok, true, JSON.stringify(found));
      assert.equal(found.selection.total, 1, JSON.stringify(found));
      const edited = await operation(session, {
        operation: 'edit', target: session.target,
        edits: [{ op: 'update', client_id: found.blocks[0].client_id, attributes: { content: 'Agent edit in human draft' } }],
      });
      assert.equal(edited.editor_result, 'applied', JSON.stringify(edited));
      assert.equal(await evaluate(session.capability, "wp.data.select('core/editor').isPostAutosavingLocked()"), false);
      assert.equal(await evaluate(session.capability, "wp.data.select('core/editor').getEditedPostAttribute('title')"), humanTitle);
      const status = await operation(session, { operation: 'status', target: session.target });
      assert.equal(status.last_request.outcome, 'applied', JSON.stringify(status));
      const saved = await save(session, { save_all_pending: true });
      assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
      const release = await operation(session, { operation: 'release', target: session.target });
      session.connected = false;
      assert.equal(release.close_document, false, JSON.stringify(release));
      assert.equal(await evaluate(session.capability, "wp.data.select('core/editor').isPostAutosavingLocked()"), false);
    },
    'template_roundtrip': () => roundtrip('wp_template'),
    'template_part_roundtrip': () => roundtrip('wp_template_part'),
    'navigation_roundtrip': () => roundtrip('wp_navigation'),
    async 'saved_record_changed'() {
      const session = await open('stale');
      await edit(session, 'Must never replace the external edit.');
      const external = await fixtureControl(descriptor, 'external_edit', 'stale');
      const rejected = await save(session);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error, 'saved_record_changed', JSON.stringify(rejected));
      assert.equal(
        (await fixtureControl(descriptor, 'snapshot', 'stale')).content,
        external.content,
      );
    },
    async 'foreign_lock'() {
      const session = await open('lock');
      await edit(session, 'Must never save over another editor.');
      const locked = await fixtureControl(descriptor, 'lock', 'lock');
      current.injected_lock = locked;
      assert.equal(
        locked.other_lock_user_id,
        descriptor.state.accounts.editor,
        'Fixture did not establish the competing lock.',
      );
      const rejected = await save(session);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error, 'post_locked', JSON.stringify(rejected));
      await close(session);
      const after = await fixtureControl(descriptor, 'snapshot', 'lock');
      assert.equal(after.content, locked.content);
      assert.equal(after.lock, locked.lock, 'Cleanup changed the other editor lock.');
    },
    async 'same_account_concurrency'() {
      const first = await open('roundtrip');
      const second = await open('roundtrip');
      const winner = `First editor wins. ${report.run_id.slice(0, 8)}`;
      await edit(first, winner);
      await edit(second, 'Second editor must not overwrite the first.');
      const saved = await save(first);
      assert.equal(saved.ok, true, JSON.stringify(saved));
      assert.equal(saved.persistence, 'verified');
      const rejected = await save(second);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error, 'saved_record_changed', JSON.stringify(rejected));
      const persisted = await fixtureControl(descriptor, 'snapshot');
      assert.ok(persisted.content.includes(winner));
      assert.ok(!persisted.content.includes('Second editor must not overwrite'));
    },
    async 'session_revocation'() {
      const session = await open('revocation');
      await edit(session, 'Must never save after session revocation.');
      const before = await fixtureControl(descriptor, 'revoke', 'revocation');
      const rejected = await save(session);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error, 'reauthorization_required', JSON.stringify(rejected));
      assert.equal(
        (await fixtureControl(descriptor, 'snapshot', 'revocation')).content,
        before.content,
      );
      account = undefined;
    },
    'reauthorization_recovery': () => roundtrip('revocation', 'admin', true),
    'author_own_post': () => roundtrip('permission', 'author'),
    async 'permission_revocation'() {
      const session = await open('permission', 'author');
      await edit(session, 'Must never save after capability removal.');
      const before = await fixtureControl(descriptor, 'restrict', 'permission', 'author');
      const rejected = await save(session);
      assert.equal(rejected.ok, false);
      assert.equal(
        (await fixtureControl(descriptor, 'snapshot', 'permission')).content,
        before.content,
      );
      assert.ok(before.session_count > 0, 'Role change unexpectedly invalidated the session.');
      assert.notEqual(
        rejected.error,
        'reauthorization_required',
        'An authenticated permission denial must be distinct from an expired session.',
      );
    },
  };

  return {
    names: Object.keys(cases),
    report,
    async run(name) {
      assert.ok(Object.hasOwn(cases, name), 'Unknown desktop integration case.');
      assert.ok(
        !report.cases.some((result) => result.name === name),
        'Start a fresh fixture before rerunning a mutating case.',
      );
      current = { name, status: 'passed', cleanup: [], trace: [], receipts: [] };
      trace = current.trace;
      const started = performance.now();

      try {
        await cases[name]();
      } catch (error) {
        current.status = 'failed';
        current.failure = error.message;
        current.failure_kind = trace.some((entry) => entry.operation !== 'release')
          ? 'behavior'
          : 'setup';
      } finally {
        for (const session of sessions) {
          try {
            await close(session);
          } catch (error) {
            current.status = 'failed';
            current.cleanup.push({ ok: false, error: error.message });
          }
        }

        if (current.cleanup.some((result) => !result.ok)) {
          current.status = 'failed';
          current.failure ??= 'Owned editor cleanup failed.';
          current.failure_kind ??= 'cleanup';
        }

        current.duration_ms = performance.now() - started;
        report.cases.push(current);
        await writeFile(join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
      }

      return current;
    },
  };
}
