import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { source, target, changes, copy, outsideDebug, fixture, linkFixture, patternSectionFixture, filledFixture } from './helpers/editor-fixture.mjs';

test('connect resolves the signed-in identity and inspects the exact live draft', async () => {
  const f = fixture();
  f.blocks[0].attributes.content = 'Pending human draft';
  f.dirty = true;
  const before = copy(f.blocks);
  const expected = { site_url: target.site_url, post_id: 7, post_type: 'page' };
  const connected = await f.call('connect', { target: expected, workflow: 'attached', blocks: { client_id: 'a' } });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.deepEqual(copy(connected.target), target);
  assert.deepEqual(copy(connected.user), { id: 5, name: 'Test user', slug: 'test' });
  assert.equal(connected.blocks[0].attributes.content, 'Pending human draft');
  assert.deepEqual(f.blocks, before);
  assert.equal(f.dirty, true);
  assert.equal(f.saves, 0);
  assert.equal(f.requests.every(({ method }) => ['GET', 'OPTIONS'].includes(method)), true);
  assert.equal(f.autosaveLocks.size, 0);
  f.user_id = 6;
  const refused = await f.call('connect', { target: expected, workflow: 'attached' });
  assert.equal(refused.error, 'user_mismatch');
  assert.equal(f.saves, 0);
});

test('background connect accepts only the native untouched auto-draft title', async () => {
  // WordPress stores the placeholder in the site's language.
  for (const [reopened, placeholder] of [[false, 'Auto Draft'], [true, 'Auto Draft'], [false, 'Automatisch gespeicherter Entwurf'], [true, 'Automatisch gespeicherter Entwurf']]) {
    const f = fixture();
    f.blocks = [];
    f.syncContent();
    Object.assign(f.post, { status: 'auto-draft', slug: '', title: { raw: placeholder } });
    f.loadedPost = { ...copy(f.post), title: '' };
    f.postEdits = reopened ? { title: placeholder } : {};
    f.dirty = reopened;
    const result = await f.call('connect');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.saves, 0);
    assert.equal(f.dirty, reopened);
    assert.deepEqual(f.postEdits, reopened ? { title: placeholder } : {});
    assert.equal(f.autosaveLocks.size, 1);
    f.post.meta = { another_writer: 'changed' };
    const refused = await f.call('connect');
    assert.equal(refused.error, 'saved_record_changed');
    assert.deepEqual(copy(refused.diagnostics.fields), ['meta.another_writer']);
    assert.equal(f.saves, 0);
  }

  for (const patch of [{ title: 'Human title' }, { excerpt: 'Human excerpt' }, { status: 'draft' }, { meta: { human: true } }]) {
    const f = fixture();
    f.blocks = [];
    f.syncContent();
    Object.assign(f.post, { status: 'auto-draft', slug: '', title: { raw: 'Auto Draft' } });
    f.loadedPost = { ...copy(f.post), title: '' };
    f.postEdits = patch;
    f.dirty = true;
    const refused = await f.call('connect');
    assert.equal(refused.error, 'editor_not_clean', JSON.stringify(refused));
    assert.equal(f.window.__blockwork_editor, undefined);
    assert.equal(f.autosaveLocks.size, 0);
    assert.equal(f.saves, 0);
  }
});

test('background connect admits only the template Gutenberg inserts into a new post', async () => {
  const template = [['core/paragraph', { content: 'Template text' }]];
  const setup = ({ status = 'auto-draft', settings = { template } } = {}) => {
    const f = fixture();
    f.blocks = [];
    f.syncContent();
    Object.assign(f.post, { status, slug: '', title: { raw: 'Auto Draft' } });
    f.loadedPost = { ...copy(f.post), title: status === 'auto-draft' ? '' : f.post.title.raw };
    f.window.wp.data.select('core/editor').getEditorSettings = () => settings;
    // Like setupEditor, the template is applied without a pending edit.
    f.blocks = f.window.wp.blocks.synchronizeBlocksWithTemplate([], template);
    f.dirty = false;
    f.api = ({ path }) => path.includes('status=any&slug=') ? [] : undefined;

    return f;
  };

  const f = setup();
  const connected = await f.call('connect');
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.equal(connected.blocks.length, 1);
  assert.equal(f.saves, 0);
  // The saved record stays the baseline; the template is pending content.
  assert.equal((await f.call('edit', { post: { title: 'Book', slug: 'new-book', status: 'draft' } })).ok, true);
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(f.post.content.raw, f.window.wp.blocks.serialize(f.blocks));
  assert.match(f.post.content.raw, /Template text/);

  const refusals = [
    [setup({ settings: {} }), [], true],
    [setup({ status: 'draft' }), [], true],
    [setup(), [], true, (g) => { g.blocks[0].attributes.content = 'Changed'; }],
    [setup(), ['excerpt'], false, (g) => { g.postEdits = { excerpt: 'Human excerpt' }; g.dirty = true; }],
  ];

  for (const [g, fields, contentChanged, change] of refusals) {
    change?.(g);
    const refused = await g.call('connect');
    assert.equal(refused.error, 'editor_not_clean', JSON.stringify(refused));
    assert.equal(refused.next, 'report_pending_changes');
    assert.deepEqual(copy(refused.diagnostics), { fields, content_changed: contentChanged });
    assert.doesNotMatch(refused.hint, /fresh background editor/);
    assert.equal(g.window.__blockwork_editor, undefined);
    assert.equal(g.saves, 0);
  }
});

test('connect rejects malformed, mismatched and expired targets before acquiring an editor session', async () => {
  const expected = { site_url: target.site_url, post_id: 7, post_type: 'page' };

  for (const [patch, error] of [
    [{ post_id: 0 }, 'invalid_connection'],
    [{ user_id: 5 }, 'invalid_connection'],
    [{ post_id: 8 }, 'target_mismatch'],
    [{ post_type: 'post' }, 'target_mismatch'],
    [{ site_url: 'https://other.test' }, 'target_mismatch'],
  ]) {
    const f = fixture();
    const result = await f.call('connect', { target: { ...expected, ...patch }, workflow: 'attached' });
    assert.equal(result.error, error, JSON.stringify(result));
    assert.equal(result.operation, 'connect');
    assert.ok(result.hint.length > 20);
    assert.equal(f.window.__blockwork_editor, undefined);
    assert.equal(f.saves, 0);

    if (error === 'invalid_connection') assert.equal(f.requests.length, 0);
  }

  const login = fixture('page', 'https://example.test/wp-login.php?redirect_to=https%3A%2F%2Fexample.test%2Fwp-admin%2F&reauth=1');
  const signedOut = await login.call('connect', { target: expected, workflow: 'background' });
  assert.equal(signedOut.error, 'reauthorization_required');
  assert.equal(signedOut.next, 'reauthorize_site');
  assert.match(signedOut.hint, /user to sign in.*wait_for_sign_in/);
  assert.match(signedOut.hint, /Never sign in for the user/);
  assert.equal(login.requests.length, 0);

  const f = fixture();
  f.auth = false;
  const expired = await f.call('connect', { target: expected, workflow: 'attached' });
  assert.equal(expired.error, 'reauthorization_required');
  assert.equal(outsideDebug(expired).includes('secret'), false);
  assert.equal(f.window.__blockwork_editor, undefined);

  const invalid = fixture();
  const preview = await invalid.call('connect', { target: expected, workflow: 'background', unsaved_preview: true });
  assert.equal(preview.error, 'invalid_connection');
  assert.equal(preview.issues[0].path, 'unsaved_preview');
  assert.equal(invalid.requests.length, 0);
  const missing = await invalid.call('connect', { target: { site_url: target.site_url, post_id: 7 }, workflow: 'attached' });
  assert.equal(missing.issues[0].path, 'target.post_type');
  assert.match(missing.hint, /Omit user_id/);
  assert.equal(invalid.requests.length, 0);
});

test('connect waits for an editor that is still starting, and reports what a different one shows', async () => {
  const expected = { site_url: target.site_url, post_id: 7, post_type: 'page' };
  const starting = fixture();
  const editor = starting.window.wp.data.select('core/editor');
  let checks = 0;
  editor.getCurrentPostId = () => (++checks < 3 ? null : starting.post.id);
  const connected = await starting.call('connect', { target: expected, workflow: 'attached' });
  assert.equal(connected.ok, true, JSON.stringify(connected));

  // The post is set up, but the block editor has not received its blocks yet.
  const syncing = fixture();
  const blockEditor = syncing.window.wp.data.select('core/block-editor');
  const getBlocks = blockEditor.getBlocks;
  let syncChecks = 0;
  blockEditor.getBlocks = (root) => (!root && ++syncChecks < 3 ? [] : getBlocks(root));
  const synced = await syncing.call('connect', { target: expected, workflow: 'background' });
  assert.equal(synced.ok, true, JSON.stringify(synced));
  assert.deepEqual(copy(synced.blocks).map(({ client_id }) => client_id), ['a', 'b', 'c']);

  const unsynced = fixture();
  unsynced.window.wp.data.select('core/block-editor').getBlocks = () => {
    unsynced.elapsedMs = (unsynced.elapsedMs ?? 0) + 4000;

    return [];
  };

  const unsyncedResult = await unsynced.call('connect', { target: expected, workflow: 'background' });
  assert.deepEqual(copy(unsyncedResult.diagnostics), { stage: 'block_sync', waited_ms: 10000 });

  // A post with no blocks needs no sync, so it connects without waiting.
  const empty = fixture();
  empty.blocks = [];
  empty.syncContent();
  empty.window.wp.data.select('core/block-editor').getBlocks = () => {
    empty.elapsedMs = (empty.elapsedMs ?? 0) + 4000;

    return [];
  };

  const emptyResult = await empty.call('connect', { target: expected, workflow: 'attached' });
  assert.equal(emptyResult.ok, true, JSON.stringify(emptyResult));

  const stalled = fixture();
  // Each check finds no post and moves the clock 4 seconds.
  stalled.window.wp.data.select('core/editor').getCurrentPostId = () => {
    stalled.elapsedMs = (stalled.elapsedMs ?? 0) + 4000;

    return null;
  };

  const unavailable = await stalled.call('connect', { target: expected, workflow: 'attached' });
  assert.equal(unavailable.error, 'editor_unavailable', JSON.stringify(unavailable));
  assert.deepEqual(copy(unavailable.diagnostics), { stage: 'editor_start', waited_ms: 10000 });
  assert.match(unavailable.hint, /native loading finishes/);
  assert.equal(stalled.requests.length, 0);

  // Slow REST reads leave about 100ms of the operation; a silent Heartbeat
  // then fails inside that budget and the half-made session is removed.
  const late = fixture();
  const apiFetch = late.window.wp.apiFetch;
  late.window.wp.apiFetch = (options) => {
    late.elapsedMs = 37900;

    return apiFetch(options);
  };

  late.window.wp.heartbeat.connectNow = () => {};

  const started = Date.now();
  const timedOut = await late.call('connect', { target: expected, workflow: 'background' });
  assert.equal(timedOut.error, 'heartbeat_timeout', JSON.stringify(timedOut));
  assert.ok(Date.now() - started < 2000);
  assert.equal(late.window.__blockwork_editor, undefined);
  assert.equal(late.autosaveLocks.size, 0);

  // The record read hangs until its signal aborts, reported as WordPress's
  // apiFetch does. Connect names the request and can simply run again.
  const hanging = fixture();
  const hangingFetch = hanging.window.wp.apiFetch;
  hanging.window.wp.apiFetch = (options) => {
    hanging.elapsedMs = 37950;

    return String(options.path).startsWith('/wp/v2/pages/7?')
      ? new Promise((resolve, reject) => options.signal.addEventListener('abort', () =>
        reject({ code: 'fetch_error', message: 'Could not get a valid response from the server.' })))
      : hangingFetch(options);
  };

  const unanswered = await hanging.call('connect', { target: expected, workflow: 'background' });
  assert.deepEqual([unanswered.error, unanswered.next, unanswered.diagnostics?.request], ['request_timeout', 'retry', 'GET /wp/v2/pages/:id'], JSON.stringify(unanswered));
  assert.equal(hanging.window.__blockwork_editor, undefined);

  const other = fixture();
  const mismatch = await other.call('connect', { target: { ...expected, post_id: 8 }, workflow: 'attached' });
  assert.equal(mismatch.error, 'target_mismatch');
  assert.deepEqual(copy(mismatch.diagnostics), { editor: { post_id: 7, post_type: 'page' } });
});

test('connect refuses WordPress older than 7.0, or an unnamed version, before any request', async () => {
  for (const [bodyClass, version] of [['wp-admin branch-6-9 version-6-9-1', '6.9.1'], ['wp-admin', null]]) {
    const f = fixture();
    f.bodyClass = bodyClass;
    const refused = await f.call('connect');
    assert.deepEqual([refused.error, refused.diagnostics?.wordpress_version, refused.diagnostics?.minimum_version],
      ['wordpress_unsupported', version, '7.0'], JSON.stringify(refused));
    assert.equal(f.requests.length, 0);
  }

  const f = fixture();
  f.bodyClass = 'wp-admin branch-7-0 version-7-0';
  assert.equal((await f.call('connect')).ok, true);
});

test('a signed-in account without permission gets a permission error, not a sign-in request', async () => {
  const f = fixture();
  await f.edit();
  f.api = () => { throw { code: 'rest_forbidden_context', message: 'secret', data: { status: 403 } }; };

  const denied = await f.save();
  assert.deepEqual([denied.error, denied.next, denied.diagnostics?.wordpress_error, denied.diagnostics?.status],
    ['permission_denied', 'correct_request', 'rest_forbidden_context', 403], JSON.stringify(denied));
  assert.match(denied.hint, /Signing in again does not fix a missing permission/);
  assert.equal(outsideDebug(denied).includes('secret'), false);

  f.api = () => { throw { code: 'rest_forbidden', data: { status: 401 } }; };

  const signedOut = await f.save();
  assert.deepEqual([signedOut.error, signedOut.next], ['reauthorization_required', 'reauthorize_site'], JSON.stringify(signedOut));
  assert.equal(f.saves, 0);
});

test('the document limit measures stored content, not the rendered response', async () => {
  const rendered = fixture();
  rendered.post.content.rendered = 'x'.repeat(600 * 1024);
  const connected = await rendered.call('connect');
  assert.equal(connected.ok, true, JSON.stringify(connected).slice(0, 300));

  const large = fixture();
  large.post.content.raw = `<!-- wp:paragraph --><p>${'x'.repeat(256 * 1024)}</p><!-- /wp:paragraph -->`;
  const refused = await large.call('connect');
  assert.equal(refused.error, 'content_too_large', JSON.stringify(refused).slice(0, 300));
  assert.equal(refused.diagnostics.limit_bytes, 256 * 1024);
  assert.ok(refused.diagnostics.content_bytes > 256 * 1024);

  // WordPress can grow stored bytes while saving; verification must still settle the save.
  const grown = fixture();
  const actions = grown.window.wp.data.dispatch('core/editor');
  const nativeSave = actions.savePost;
  actions.savePost = async () => { await nativeSave(); grown.post.content.raw = grown.post.content.raw.replace('{', `{${' '.repeat(8 * 1024)}`); };

  await grown.edit([{ ...changes[0], attributes: { content: 'x'.repeat(255 * 1024) } }]);
  const settled = await grown.save();
  assert.equal(settled.persistence, 'verified', JSON.stringify(settled).slice(0, 300));

  const growing = fixture();
  await growing.edit();
  growing.blocks[0].attributes.content = 'x'.repeat(256 * 1024);
  const save = await growing.save();
  assert.deepEqual([save.error, save.persistence], ['content_too_large', 'not_attempted'], JSON.stringify(save).slice(0, 300));
  assert.equal(growing.saves, 0);
});

test('a parent check reads only the parent chain, not rendered content', async () => {
  const f = fixture();
  const parent = { id: 9, type: 'page', parent: 0 };
  const rendered = { ...parent, content: { rendered: 'x'.repeat(300 * 1024) } };
  f.api = ({ path, method }) => method === 'GET' && path.startsWith('/wp/v2/pages/9?')
    ? path.includes('_fields=') ? parent : rendered
    : undefined;
  await f.call('connect');
  const edited = await f.call('edit', { post: { parent_id: 9 } });
  assert.equal(edited.ok, true, JSON.stringify(edited).slice(0, 300));
  assert.ok(f.requests.some(({ path }) => path === '/wp/v2/pages/9?context=edit&_fields=id,type,parent'));
});

test('search covers every rich-text attribute, including nested cells', async () => {
  const f = fixture();
  f.registrations['example/card'].attributes = {
    ...f.registrations['example/card'].attributes,
    citation: { type: 'rich-text' },
    body: { type: 'array', source: 'query', query: { content: { type: 'rich-text' } } },
  };
  f.blocks[1].attributes = { ...f.blocks[1].attributes, citation: 'Quoted person', body: [{ content: 'Cell text' }] };
  f.syncContent();
  await f.call('connect');

  for (const search of ['Quoted person', 'Cell text']) {
    const found = await f.call('read', { blocks: { search } });
    assert.equal(found.selection.total, 1, JSON.stringify(found));
  }
});

test('background release retains autosave protection while a native save is running', async () => {
  const f = fixture();
  await f.call('connect');
  f.locked = true; f.saving = true;
  assert.equal((await f.call('release')).error, 'cleanup_pending');
  assert.equal(f.autosaveLocks.size, 1);
  assert.ok(f.window.__blockwork_editor);
  f.saving = false;
  assert.equal((await f.call('release')).cleanup, 'not_owned');
  assert.equal(f.autosaveLocks.size, 0);
  assert.equal(f.releases, 0);
});

test('the browser expression accepts JSON arguments and refuses malformed requests', async () => {
  for (const request of [null, { operation: 'publish', target }, { operation: 'read', target: { ...target, user_id: '5' } }]) {
    const result = await runInNewContext(`${source}(${JSON.stringify(request)})`, { window: {} });
    assert.equal(result.ok, false);
    assert.equal(result.error, request?.operation === 'read' ? 'invalid_read' : 'invalid_request');
    assert.equal(result.persistence, 'not_attempted');
    assert.ok(result.hint.length > 20);
  }
});

test('mixed-content inspection reports unsupported and invalid blocks without losing the tree', async () => {
  const f = fixture();
  f.blocks.push(
    { name: 'core/html', attributes: { content: '<p>Keep raw content.</p>' }, clientId: 'html', innerBlocks: [], isValid: true },
    { name: 'core/navigation', attributes: { ref: 10 }, clientId: 'nav', innerBlocks: [], isValid: true },
    { name: 'plugin/unavailable', attributes: {}, clientId: 'missing', innerBlocks: [], isValid: false },
    { name: 'core/paragraph', attributes: { content: 'Invalid' }, clientId: 'invalid', innerBlocks: [], isValid: false },
  );
  f.syncContent();
  const result = await f.call('connect');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.blocks.length, 7);
  assert.equal(result.validity.unsupported.length, 2);
  assert.equal(result.validity.invalid.length, 1);
  assert.equal(result.validity.valid, false);
  assert.equal(result.blocks[3].editable, false);
  assert.equal(result.blocks[0].attributes, undefined);
  assert.equal(f.saves, 0);
});

test('inspection returns live attribute guidance, contextual insertion rules, and registered pattern names', async () => {
  const f = fixture();
  f.patterns = [{ name: 'example/section', title: 'Example section', content: 'Do not return full markup' }];
  const result = await f.call('connect', { attribute_guide: { client_id: 'b' }, insertion: {}, patterns: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Array.from(result.attribute_guide.attributes[0].enum), ['plain', 'accent']);
  assert.equal(result.attribute_guide.attributes[0].editable, true);
  assert.equal(result.insertion.items.find((item) => item.name === 'core/html').allowed, false);
  assert.equal(result.patterns.items[0].name, 'example/section');
  assert.equal(result.patterns.items[0].content, undefined);
  f.templateLock = 'all';
  const locked = await f.call('connect', { insertion: {} });
  assert.equal(locked.insertion.template_lock, 'all');
  assert.equal(locked.insertion.items.some((item) => item.allowed), false);
  delete f.window.wp.data.resolveSelect;
  assert.equal((await f.call('connect', { patterns: true })).patterns.available, false);
});

test('read clamps depth and limit above their maximums and reports omitted descendants', async () => {
  const f = fixture();
  f.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, isValid: true, innerBlocks: [
    { name: 'core/paragraph', clientId: 'nested', attributes: { content: 'Nested' }, innerBlocks: [], isValid: true },
  ] };
  f.syncContent();
  await f.call('connect', { workflow: 'attached' });
  const clamped = await f.call('read', { blocks: { client_id: 'group', depth: 20, limit: 200 } });
  assert.equal(clamped.ok, true, JSON.stringify(clamped));
  assert.deepEqual(copy(clamped.selection), { total: 2, returned: 2, truncated: false, depth_limited: false, clamped: { depth: 8, limit: 50 } });
  const shallow = await f.call('read', { blocks: { client_id: 'group', depth: 0 } });
  assert.deepEqual(copy(shallow.selection), { total: 1, returned: 1, truncated: false, depth_limited: true });

  let chain = { name: 'core/group', clientId: 'level-10', attributes: {}, isValid: true, innerBlocks: [] };

  for (let level = 9; level >= 0; level -= 1) chain = { name: 'core/group', clientId: `level-${level}`, attributes: {}, isValid: true, innerBlocks: [chain] };
  const wide = Array.from({ length: 60 }, (_, index) => ({ name: 'core/paragraph', clientId: `wide-${index}`, attributes: { content: `Row ${index}` }, innerBlocks: [], isValid: true }));
  f.blocks.push(chain, { name: 'core/group', clientId: 'wide', attributes: {}, isValid: true, innerBlocks: wide });
  f.syncContent();
  const deep = await f.call('read', { blocks: { client_id: 'level-0', depth: 20 } });
  assert.deepEqual(copy(deep.selection), { total: 9, returned: 9, truncated: false, depth_limited: true, clamped: { depth: 8 } });
  const many = await f.call('read', { blocks: { client_id: 'wide', limit: 200 } });
  assert.deepEqual(copy(many.selection), { total: 61, returned: 50, truncated: true, depth_limited: false, clamped: { limit: 50 } });

  for (const blocks of [{ client_id: 'group', depth: 1.5 }, { client_id: 'group', limit: 0 }]) {
    assert.equal((await f.call('read', { blocks })).error, 'invalid_read', JSON.stringify(blocks));
  }
});

test('search can return bounded attributes across nested blocks without changing its default outlines', async () => {
  const f = fixture();
  f.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, isValid: true, innerBlocks: [
    { name: 'core/paragraph', clientId: 'nested', attributes: { content: 'Nested CTA' }, innerBlocks: [], isValid: true },
  ] };
  f.syncContent();
  await f.call('connect', { workflow: 'attached' });
  const outlines = await f.call('connect', { workflow: 'attached', blocks: { search: 'core/paragraph' } });
  assert.equal(outlines.blocks.length, 3);
  assert.ok(outlines.blocks.every(block => block.attributes === undefined));
  const detailed = await f.call('connect', { workflow: 'attached', blocks: { search: 'core/paragraph', attributes: true, limit: 2 } });
  assert.equal(detailed.ok, true, JSON.stringify(detailed));
  assert.deepEqual(copy(detailed.selection), { total: 3, returned: 2, truncated: true });
  assert.equal(detailed.blocks[1].client_id, 'nested');
  assert.equal(detailed.blocks[1].attributes.content, 'Nested CTA');
  assert.equal(f.dirty, false);
  assert.equal(f.saves, 0);
});

test('search and previews use decoded text, and any space matches a non-breaking one', async () => {
  const f = fixture();
  f.blocks[0].attributes.content = 'Every&nbsp;Room &amp; &lt;b&gt;Hall&lt;/b&gt; <em>now</em>';
  f.syncContent();
  await f.call('connect', { workflow: 'attached' });
  const found = await f.call('connect', { workflow: 'attached', blocks: { search: 'every room & <b>hall</b> now' } });
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.deepEqual(copy(found.blocks.map(block => [block.client_id, block.preview])), [['a', 'Every Room & <b>Hall</b> now']]);
  const edited = await f.call('edit', { edits: [{ op: 'update', client_id: 'c', attributes: { content: 'Keep&nbsp;together' } }] });
  assert.equal(edited.changed[0].preview, 'Keep together');
});

test('detailed search keeps the response budget and validates its shape before session acquisition', async () => {
  const f = fixture();
  const invalid = await f.call('connect', { blocks: { search: 'core', attributes: 'all' } });
  assert.equal(invalid.error, 'invalid_connection');
  assert.equal(f.window.__blockwork_editor, undefined);
  f.blocks[0].attributes.content = 'x'.repeat(65536);
  f.syncContent();
  const large = await f.call('connect', { blocks: { search: 'core/paragraph', attributes: true } });
  assert.equal(large.error, 'inspection_too_large');
  assert.equal(large.diagnostics.max_bytes, 65536);
  assert.equal(f.dirty, false);
  assert.equal(f.saves, 0);
});

test('selector shape errors precede session acquisition and explain the offending field', async () => {
  const invalid = [
    [{ op: 'remove', path: [0], client_id: 'a', name: 'core/paragraph' }, 'edits.0.client_id'],
    [{ op: 'remove', name: 'core/paragraph' }, 'edits.0.client_id'],
    [{ op: 'insert', parent: [], parent_client_id: 'a', block: { name: 'core/paragraph' } }, 'edits.0.parent_client_id'],
  ];

  for (const [edit, path] of invalid) {
    const f = fixture();
    const result = await f.call('edit', { edits: [edit] });
    assert.equal(result.validation_source, 'request', JSON.stringify(result));
    assert.equal(result.issues.some(issue => issue.path === path), true);
    assert.match(result.issues[0].hint, /client_id/);
    assert.equal(f.requests.length, 0);
    assert.equal(f.dirty, false);
  }
});

test('a subtree read lists the attachments it references, but not links', async () => {
  const f = fixture();
  f.registrations['example/media'] = { name: 'example/media', attributes: { id: { type: 'number' }, url: { type: 'string' },
    mediaId: { type: 'number' }, mediaUrl: { type: 'string' } } };
  f.registrations['example/link'] = { name: 'example/link', attributes: { id: { type: 'number' }, url: { type: 'string' } } };
  const uploads = 'https://example.test/wp-content/uploads/2026/10/';
  f.blocks = [{ name: 'core/group', clientId: 'section', isValid: true,
    attributes: { style: { background: { backgroundImage: { id: 9, url: `${uploads}bg.jpg` } } } }, innerBlocks: [
      { name: 'example/media', clientId: 'm', isValid: true, innerBlocks: [],
        attributes: { id: 7, url: `${uploads}photo.jpg`, mediaId: 9, mediaUrl: `${uploads}bg-300x200.jpg` } },
      { name: 'example/link', clientId: 'l', isValid: true, innerBlocks: [], attributes: { id: 12, url: 'https://example.test/about/' } },
    ] }];
  f.syncContent();
  await f.call('connect');

  const read = await f.call('read', { blocks: { client_id: 'section', depth: 0, media: true } });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.deepEqual(copy(read.media), [
    { id: 9, url: `${uploads}bg.jpg`, paths: [{ path: [0], name: 'core/group', attribute: 'style.background.backgroundImage.id' },
      { path: [0, 0], name: 'example/media', attribute: 'mediaId' }] },
    { id: 7, url: `${uploads}photo.jpg`, paths: [{ path: [0, 0], name: 'example/media', attribute: 'id' }] },
  ]);

  // A copy rewrites exactly the listed places, so none may be left out.
  f.registrations['example/gallery'] = { name: 'example/gallery', attributes: { items: { type: 'array' } } };
  f.blocks = [{ name: 'example/gallery', clientId: 'g', isValid: true, innerBlocks: [],
    attributes: { items: Array.from({ length: 25 }, () => ({ id: 7, url: `${uploads}photo.jpg` })) } }];
  f.syncContent();
  await f.call('connect');
  const gallery = await f.call('read', { blocks: { client_id: 'g', depth: 0, media: true } });
  assert.equal(gallery.media[0].paths.length, 25);
  assert.equal(gallery.media[0].paths[24].attribute, 'items.24.id');
});

test('map_links reads locked source markup without granting creation permission', async () => {
  const f = linkFixture();
  const source = 'https://source.test';
  const url = `${source}/source/`;
  const destination = `${target.site_url}/destination/`;
  await f.call('connect');
  const before = copy(f.blocks);
  const markup = f.window.wp.blocks.serialize([{
    name: 'core/group', attributes: { lock: { move: true } }, innerBlocks: [{
      name: 'example/link', attributes: { url }, innerBlocks: [],
    }],
  }]);
  const mapped = await f.call('map_links', {
    markup, source_site_url: source, overrides: [{ source_url: url, target_url: destination }],
  });
  assert.equal(mapped.ok, true, JSON.stringify(mapped));
  assert.equal(mapped.link_map.urls[url], destination);
  assert.deepEqual(f.blocks, before);
  assert.equal(f.dirty, false);
  const refused = await f.call('edit', { edits: [{ op: 'insert', markup }] });
  assert.equal(refused.error, 'unsupported_attribute', JSON.stringify(refused));
  assert.deepEqual(f.blocks, before);
  assert.equal(f.saves, 0);
});

test('read reports a native removal refusal independently of attribute editability', async () => {
  const f = fixture();
  f.removeLocked = true;
  await f.call('connect');
  const read = await f.call('read', { blocks: { client_id: 'a' } });
  assert.equal(read.blocks[0].editable, true);
  assert.equal(read.blocks[0].removable, false);
  assert.equal(read.blocks[0].removal_restriction.reason, 'block_locked');
  const removed = await f.call('edit', { edits: [{ op: 'remove', client_id: 'a' }] });
  assert.equal(removed.error, 'block_locked', JSON.stringify(removed));
  assert.equal(f.dirty, false);
});

test('section opening validates the option before a session or native action', async () => {
  for (const open_pattern_section of [true, {}, { section_client_id: 7 }, { section_client_id: '' },
    { section_client_id: 'section', bypass: true }]) {
    const f = patternSectionFixture();
    const result = await f.call('edit', { open_pattern_section, edits: changes });
    assert.equal(result.error, 'invalid_edit', JSON.stringify(result));
    assert.equal(result.validation_source, 'request');
    assert.match(result.issues[0].path, /^open_pattern_section/);
    assert.equal(f.window.__blockwork_editor, undefined);
    assert.deepEqual(f.sectionOpens, []);
  }
});

test('background connect shows the visual editor without saving the preference', async () => {
  const f = fixture();
  const saved = { core: { editorMode: 'text', fixedToolbar: true }, 'core/edit-post': { welcomeGuide: false } };
  const layers = [];
  let mode = 'text';
  f.window.wp.data.select('core/editor').getEditorMode = () => mode;
  const { apiFetch } = f.window.wp;
  f.window.wp.apiFetch = (options) => options.path.includes('_fields=meta')
    ? Promise.resolve({ meta: { persisted_preferences: saved } })
    : apiFetch(options);
  const { dispatch } = f.window.wp.data;
  f.window.wp.data.dispatch = (name) => name === 'core/preferences'
    ? { setPersistenceLayer: async (layer) => {
      layers.push(layer);
      mode = (await layer.get()).core.editorMode;
    } }
    : dispatch(name);

  const connected = await f.call('connect', { workflow: 'background' });

  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.equal(connected.editor_mode, undefined);
  assert.equal(mode, 'visual');
  assert.equal(layers.length, 1);
  // The engine runs in its own realm, so compare by value.
  assert.deepEqual(JSON.parse(JSON.stringify(await layers[0].get())), {
    core: { editorMode: 'visual', fixedToolbar: true },
    'core/edit-post': { welcomeGuide: false },
  });
  assert.equal(layers[0].set(saved), undefined);
  assert.equal(saved.core.editorMode, 'text');
});

test('background connect leaves template children unread until the agent reads them', async () => {
  const f = filledFixture();
  const connected = await f.call('connect', { workflow: 'background' });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.deepEqual(JSON.parse(JSON.stringify(connected.template_fills)), {
    blocks: [{ client_id: 'group', name: 'core/group', path: [1] }],
    block_count: 1,
  });

  const edited = await f.call('edit', { edits: [{ op: 'update', client_id: f.blocks[0].clientId, attributes: { content: 'After' } }] });
  assert.equal(edited.ok, true, JSON.stringify(edited));

  const refused = await f.save();
  assert.equal(refused.error, 'unexpected_editor_change', JSON.stringify(refused));
  assert.deepEqual(JSON.parse(JSON.stringify(refused.diagnostics.blocks.map((block) => block.client_id))), ['group', 'filled']);
  assert.equal(f.saves, 0);

  const read = await f.call('read', { blocks: { client_id: 'group', depth: 2 } });
  assert.equal(read.ok, true, JSON.stringify(read));
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(f.post.content.raw, f.window.wp.blocks.serialize(f.blocks));
});

test('reconnect keeps template children unread', async () => {
  const f = filledFixture();
  assert.equal((await f.call('connect', { workflow: 'background' })).ok, true);
  assert.equal((await f.call('connect', { workflow: 'background' })).ok, true);
  assert.equal((await f.call('read', { blocks: { client_id: 'group', depth: 0 } })).ok, true);
  const edited = await f.call('edit', { edits: [{ op: 'update', client_id: f.blocks[0].clientId, attributes: { content: 'After' } }] });
  assert.equal(edited.ok, true, JSON.stringify(edited));

  const refused = await f.save();
  assert.equal(refused.error, 'unexpected_editor_change', JSON.stringify(refused));
  assert.deepEqual(JSON.parse(JSON.stringify(refused.diagnostics.blocks.map((block) => block.client_id))), ['filled']);

  assert.equal((await f.call('read', { blocks: { client_id: 'filled' } })).ok, true);
  assert.equal((await f.save()).persistence, 'verified');
});

test('a change during the lock request refuses a background connect', async () => {
  const f = filledFixture();
  f.onPulse = () => { f.blocks[0].attributes.content = 'Changed'; };

  const refused = await f.call('connect', { workflow: 'background' });
  assert.equal(refused.error, 'editor_not_clean', JSON.stringify(refused));
  assert.equal(f.window.__blockwork_editor, undefined);
  assert.equal(f.autosaveLocks.size, 0);
});

test('a template fill beside any other difference still refuses a background connect', async () => {
  const changed = filledFixture();
  changed.blocks[0].attributes.content = 'Pending';
  assert.equal((await changed.call('connect', { workflow: 'background' })).error, 'editor_not_clean');

  const populated = fixture();
  populated.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, innerBlocks: [
    { name: 'core/paragraph', clientId: 'saved', attributes: { content: 'Saved' }, innerBlocks: [] },
  ] };
  populated.syncContent();
  populated.blocks[1].innerBlocks.push({ name: 'core/paragraph', clientId: 'added', attributes: { content: '' }, innerBlocks: [] });
  assert.equal((await populated.call('connect', { workflow: 'background' })).error, 'editor_not_clean');

  const dirty = filledFixture();
  dirty.dirty = true;
  assert.equal((await dirty.call('connect', { workflow: 'background' })).error, 'editor_not_clean');
});

test('status remains available while a native edit is running', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached' });
  const dispatch = f.window.wp.data.dispatch;
  const actions = dispatch('core/block-editor');
  f.window.wp.data.dispatch = name => name === 'core/block-editor' ? actions : dispatch(name);
  const update = actions.updateBlockAttributes;
  let finish;
  actions.updateBlockAttributes = async (...args) => {
    await new Promise(resolve => { finish = resolve; });
    update(...args);
  };

  const pending = f.call('edit', { request_id: 'running-edit', edits: changes });
  await Promise.race([
    (async () => { while (!finish) await new Promise(resolve => setImmediate(resolve)); })(),
    pending.then(result => assert.fail('Edit did not reach native update: ' + JSON.stringify(result))),
  ]);

  try {
    const status = await f.call('status');
    assert.equal(status.ok, true);
    assert.equal(status.busy, true);
    assert.deepEqual(copy(status.last_request), { id: 'running-edit', operation: 'edit', outcome: 'running' });
    assert.equal((await f.call('read')).error, 'operation_in_progress');
    assert.equal((await f.call('status')).busy, true);
  } finally { finish(); }

  assert.equal((await pending).editor_result, 'applied');
  const status = await f.call('status');
  assert.equal(status.busy, false);
  assert.equal(status.last_request.outcome, 'applied');
});

test('request validation identifies repairable fields before acquiring a session', async () => {
  for (const [operation, request, error, path] of [
    ['connect', { workflow: 'background', unsaved_preview: true }, 'invalid_connection', 'unsaved_preview'],
    ['read', { blocks: { client_id: 'a', depth: 1.5 } }, 'invalid_read', 'blocks.depth'],
    ['edit', { edits: [{ op: 'insert' }] }, 'invalid_edit', 'edits.0.block'],
    ['edit', { edits: [{ op: 'update', client_id: 'a', attributes: {} }] }, 'invalid_edit', 'edits.0.attributes'],
    ['measure', { blocks: ['a'], properties: ['private input value'] }, 'invalid_measure', 'properties.0'],
    ['prepare_save', { save_all_pending: 'yes' }, 'invalid_request', 'save_all_pending'],
    ['status', { extra: 'private input value' }, 'invalid_request', 'extra'],
  ]) {
    const f = fixture();
    const refused = await f.call(operation, request);
    assert.equal(refused.error, error, JSON.stringify(refused));
    assert.equal(refused.validation_source, 'request');
    const issue = refused.issues.find(issue => issue.path === path);
    assert.ok(issue, JSON.stringify(refused.issues));
    assert.ok(issue.expected.length > 0);
    assert.ok(issue.hint.length > 20);
    assert.equal(JSON.stringify(refused).includes('private input value'), false);
    assert.equal(f.requests.length, 0);
    assert.equal(f.window.__blockwork_editor, undefined);
    assert.equal(f.saves, 0);
  }
});

test('a refused reconnect leaves a running operation busy', async () => {
  const f = fixture();
  await f.call('connect');
  f.window.__blockwork_editor.busy = true;
  assert.equal((await f.call('connect')).error, 'operation_in_progress');
  assert.equal(f.window.__blockwork_editor.busy, true);
});

test('status confirms a release whose response was lost', async () => {
  const f = fixture();
  await f.call('connect');
  assert.equal((await f.call('release')).ok, true);
  const status = await f.call('status');
  assert.equal(status.released, true, JSON.stringify(status));
  assert.equal(status.last_request.outcome, 'released');
  assert.equal(status.busy, false);
});

test('concurrent first connections install one session', async () => {
  const f = fixture();
  const results = await Promise.all([f.call('connect'), f.call('connect')]);
  assert.deepEqual(results.map((result) => result.ok ?? false).sort(), [false, true], JSON.stringify(results));
  assert.equal(results.find((result) => !result.ok).error, 'operation_in_progress');
});

test('read copies another saved page through this editor without touching the draft', async () => {
  const f = fixture();
  const wp = f.window.wp;
  // WordPress fills an Accordion panel's registered templateLock default when it parses markup.
  f.registrations['example/panel'] = { name: 'example/panel', attributes: { templateLock: { type: ['string', 'boolean'], enum: ['all', 'insert', 'contentOnly', false], default: false } } };
  const other = [{ name: 'core/group', attributes: { className: 'faq' }, clientId: 'x', isValid: true,
    innerBlocks: [{ name: 'core/paragraph', attributes: { content: 'Question' }, clientId: 'y', innerBlocks: [], isValid: true },
      { name: 'example/panel', attributes: { templateLock: false }, clientId: 'z', innerBlocks: [], isValid: true }] }];
  f.api = ({ path }) => {
    if (path.startsWith('/wp/v2/pages/10?')) throw { code: 'rest_post_invalid_id', message: 'Invalid post ID.', data: { status: 404 } };

    return path.startsWith('/wp/v2/pages/9?') ? { ...copy(f.post), id: 9, slug: 'other', title: { raw: 'Other' }, content: { raw: wp.blocks.serialize(other) } } : undefined;
  };

  const connected = await f.call('connect', { workflow: 'attached' });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  const draft = copy(f.blocks);
  const observed = copy(f.window.__blockwork_editor.observed);
  const roots = await f.call('read', { source: { post_id: 9, post_type: 'page' } });
  assert.equal(roots.ok, true, JSON.stringify(roots));
  assert.equal(roots.source.title, 'Other');
  assert.deepEqual(copy(roots.blocks.map((block) => block.name)), ['core/group']);
  assert.equal(roots.blocks[0].editable, undefined);

  const section = await f.call('read', { source: { post_id: 9, post_type: 'page' }, blocks: { client_id: roots.blocks[0].client_id, depth: 1, markup: true } });
  assert.equal(section.ok, true, JSON.stringify(section));
  assert.equal(section.blocks[1].attributes.content, 'Question');
  assert.equal(section.markup, wp.blocks.serialize(other));
  const inserted = await f.call('edit', { edits: [{ op: 'insert', markup: section.markup }] });
  assert.equal(inserted.ok, true, JSON.stringify(inserted));
  assert.equal(f.blocks.at(-1).innerBlocks[0].attributes.content, 'Question');
  assert.equal(f.blocks.at(-1).innerBlocks[1].name, 'example/panel');
  assert.deepEqual(f.blocks.slice(0, 3), draft);
  assert.deepEqual(Object.keys(f.window.__blockwork_editor.observed).filter((id) => !Object.hasOwn(observed, id)).includes('x'), false);

  const mixed = await f.call('read', { source: { post_id: 9, post_type: 'page' }, attribute_guide: { name: 'core/group' } });
  assert.equal(mixed.error, 'source_read_blocks_only', JSON.stringify(mixed));
  assert.deepEqual(copy(mixed.diagnostics.fields), ['attribute_guide']);

  const missing = await f.call('read', { source: { post_id: 10, post_type: 'page' } });
  assert.equal(missing.error, 'source_not_found', JSON.stringify(missing));
  assert.deepEqual(copy(missing.diagnostics), { post_id: 10, post_type: 'page' });
  assert.match(missing.hint, /discover/);
  assert.equal(missing.debug.cause.code, 'rest_post_invalid_id');
  assert.equal(missing.debug.cause.status, 404);
});

test('connect lists insertable custom blocks and where child-only blocks belong', async () => {
  const f = fixture();
  Object.assign(f.registrations['example/card'], { title: 'Card', description: 'A highlighted card.' });
  f.registrations['example/slide'] = { name: 'example/slide', title: 'Slide', parent: ['example/slider'], attributes: {} };
  f.registrations['example/hidden'] = { name: 'example/hidden', title: 'Hidden', supports: { inserter: false }, attributes: {} };
  const connected = await f.call('connect');
  assert.deepEqual(JSON.parse(JSON.stringify(connected.custom_blocks)), [
    { name: 'example/card', title: 'Card', description: 'A highlighted card.' },
    { name: 'example/slide', title: 'Slide', inside: ['example/slider'] },
  ]);
  const live = await f.call('read', { blocks: { client_id: 'b', markup: true } });
  assert.equal(live.markup, f.window.wp.blocks.serialize([f.blocks[1]]));
});

test('source reads confirm the signed-in user first', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached' });
  f.user_id = 6;
  const refused = await f.call('read', { source: { post_id: 7, post_type: 'page' } });
  assert.equal(refused.error, 'user_mismatch', JSON.stringify(refused));
});

test('connect refuses a session left by an older build', async () => {
  const f = fixture();
  f.window.__blockwork_editor = { protocol: 2, workflow: 'attached', preview: {} };
  const refused = await f.call('connect', { workflow: 'attached' });
  assert.equal(refused.error, 'session_from_older_build', JSON.stringify(refused));
  assert.match(refused.hint, /never reload it yourself/);
  assert.equal(f.window.__blockwork_editor.protocol, 2);
});

test('connect and save return the document permalink, and save its editor URL', async () => {
  const f = fixture();
  f.post.link = 'https://example.test/example/';
  const connected = await f.call('connect');
  assert.equal(connected.link, 'https://example.test/example/');
  assert.equal((await f.edit()).ok, true);
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(saved.link, 'https://example.test/example/');
  assert.equal(saved.editor_url, 'https://example.test/wp-admin/post.php?post=7&action=edit');
});

test('a connect that overlaps a running operation says to connect again', async () => {
  const f = fixture();
  await f.call('connect');
  f.window.__blockwork_editor.busy = true;
  const refused = await f.call('connect');
  assert.equal(refused.error, 'operation_in_progress');
  assert.equal(refused.next, 'retry');
  assert.match(refused.hint, /call connect again/);
  f.window.__blockwork_editor.busy = false;
  assert.equal((await f.call('connect')).ok, true);
});
