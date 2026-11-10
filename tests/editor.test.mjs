import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { bundles } from '../tools/bundle.mjs';
import { footnoteRichText, footnoteParagraph, footnoteBodies } from './helpers/footnote-rich-text.mjs';

const source = await readFile(new URL('../skills/blockwork/scripts/editor.js', import.meta.url), 'utf8');
const target = { site_url: 'https://example.test', user_id: 5, post_id: 7, post_type: 'page' };
const changes = [{ op: 'update', path: [0], name: 'core/paragraph', attributes: { content: 'After' } }];
const copy = (value) => structuredClone(value);

// Development builds put the underlying message in debug; nothing else may echo it.
function outsideDebug(result) {
  return JSON.stringify({ ...result, debug: undefined });
}

// Mirror rest_filter_response_fields, including dotted keys and parent precedence.
function restFields(value, path, method) {
  const fields = new URL(path, target.site_url).searchParams.get('_fields')?.split(/[\s,]+/).filter(Boolean);

  if (method !== 'GET' || !fields?.length) return copy(value);
  const hierarchy = new Map();

  for (const field of fields) {
    const parts = field.split('.');
    let node = hierarchy;

    for (let index = 0; index < parts.length; index++) {
      const name = parts[index];

      if (node.get(name) === true) break;

      if (index === parts.length - 1) {
        node.set(name, true);
        break;
      }

      if (!node.has(name)) node.set(name, new Map());
      node = node.get(name);
    }
  }

  const intersect = (record, selected) => Object.fromEntries(Object.entries(record).flatMap(([name, entry]) => {
    if (!selected.has(name)) return [];
    const nested = selected.get(name);

    return [[name, entry instanceof Object && nested instanceof Map ? intersect(entry, nested) : entry]];
  }));

  return copy(Array.isArray(value) ? value.map((record) => intersect(record, hierarchy)) : intersect(value, hierarchy));
}

function stylingFixture() {
  const f = fixture();
  f.window.wp.blockEditor = { __experimentalResponsiveBlockControl() {} };
  Object.assign(f.registrations['core/group'], {
    supports: { spacing: { padding: true, margin: true, blockGap: true }, color: { gradients: true }, typography: { fontSize: true }, layout: true },
    attributes: { ...f.registrations['core/group'].attributes, fontSize: { type: 'string' }, textColor: { type: 'string' }, backgroundColor: { type: 'string' } },
  });
  f.editorSettings = { canEditCSS: true, blockStatesEditingEnabled: true, __experimentalFeatures: {
    viewport: { mobile: '32rem', tablet: '60rem' }, spacing: { padding: true, margin: true, blockGap: true },
    typography: { fontSizes: { theme: [{ slug: 'large', size: '32px' }] }, customFontSize: true },
    color: { palette: { theme: [{ slug: 'accent', color: '#c00' }] }, custom: true },
  } };
  f.blocks = [{ name: 'core/group', clientId: 'a', isValid: true, innerBlocks: [], attributes: {
    className: 'retained', layout: { type: 'flex', orientation: 'horizontal' },
    style: { spacing: { padding: { top: '24px', right: '16px' } }, typography: { fontSize: '20px' },
      '@mobile': { spacing: { padding: { top: '12px', left: '8px' } } },
      '@tablet': { spacing: { padding: { top: '18px' } } }, css: '& strong { color: red; }' },
  } }];
  f.syncContent();

  return f;
}

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

test('saved record refusals name differing fields and meta keys without values', async () => {
  for (const initial of [true, false]) {
    const f = fixture();

    if (!initial) assert.equal((await f.call('connect')).ok, true);
    f.loadedPost = copy(f.post);
    f.post.title.raw = 'private changed title';
    f.post.meta = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`key_${index}`, 'private metadata']));
    const refused = await f.call('connect');
    assert.equal(refused.error, 'saved_record_changed');
    assert.equal(refused.diagnostics.fields.length, 20);
    assert.ok(refused.diagnostics.fields.includes('meta.key_0'));
    assert.equal(JSON.stringify(refused.diagnostics).includes('private'), false);
    assert.match(refused.hint, /diagnostics.fields/);
    assert.match(refused.hint, /only the user decides whether to reload/);
    assert.equal(f.saves, 0);
  }

  const missingMeta = fixture();
  missingMeta.loadedPost = copy(missingMeta.post);
  delete missingMeta.loadedPost.meta;
  missingMeta.post.meta = { added: 'private metadata' };
  const missing = await missingMeta.call('connect');
  assert.equal(missing.error, 'saved_record_changed');
  assert.deepEqual(copy(missing.diagnostics.fields), ['meta.added']);

  // Only an auto-draft's loaded title is blank by design.
  for (const status of ['draft', 'publish']) {
    const f = fixture();
    f.post.status = status;
    f.loadedPost = { ...copy(f.post), title: '' };
    const refused = await f.call('connect');
    assert.equal(refused.error, 'saved_record_changed');
    assert.deepEqual(copy(refused.diagnostics.fields), ['title']);
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

async function styleEdit(f, set = [], unset = []) {
  if (!f.window.__blockwork_editor) {
    const connected = await f.call('connect');
    assert.equal(connected.ok, true, JSON.stringify(connected));
  }

  return f.call('edit', { edits: [{ op: 'update_style', client_id: f.blocks[0].clientId, set, unset }] });
}

function fixture(post_type = 'page', url = 'https://example.test/wp-admin/post.php?post=7&action=edit', engine = source) {
  const f = { saves: 0, releases: 0, pulses: 0, dirty: false, locked: false, auth: true, user_id: 5, requests: [], autosaveLocks: new Set(), savingLocks: new Set(), listeners: new Set() };
  f.notify = () => { for (const listener of f.listeners) listener(); };

  // Native autosave of a draft writes the post itself and updates the editor's record.
  // Autosaving a published post writes only a revision.
  f.autosave = () => {
    f.saving = f.autosaving = true;
    f.notify();

    if (['draft', 'auto-draft'].includes(f.post.status)) {
      f.syncContent();
      f.post.modified_gmt = 'autosaved';
      f.dirty = false;
    }

    f.saving = f.autosaving = false;
    f.notify();
  };

  const registrations = {
    'core/paragraph': { attributes: { content: { type: 'rich-text' }, dropCap: { type: 'boolean' } } },
    'example/card': { attributes: { variant: { type: 'string', enum: ['plain', 'accent'] } } },
    'core/group': { attributes: { className: { type: 'string' }, style: { type: 'object' }, layout: { type: 'object' }, allowedBlocks: { type: 'array' } } },
    'core/html': { attributes: { content: { type: 'string' } } },
    'core/navigation': { attributes: { ref: { type: 'number' } } },
  };

  for (const [name, registration] of Object.entries(registrations)) registration.name = name;

  const plain = (list) => list.map(({ name, attributes, innerBlocks }) => ({ name,
    attributes: Object.fromEntries(Object.entries(attributes).filter(([key]) => registrations[name]?.attributes?.[key]?.role !== 'local')),
    innerBlocks: plain(innerBlocks || []) }));

  const serialize = (list) => plain(list).map((block) => JSON.stringify(block)).join('\n\n');

  const richTextAttributes = (values, schema, convert) => Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const attribute = schema?.[key];

    if (attribute?.type === 'rich-text') return [key, convert(String(value))];

    if (attribute?.source === 'query' && Array.isArray(value)) {
      return [key, value.map((entry) => richTextAttributes(entry, attribute.query, convert))];
    }

    return [key, value];
  }));

  const parse = (text) => {
    let index = 0;

    const restore = (list) => list.map((block) => {
      const legacy = block.name === 'example/legacy' && block.attributes.old !== undefined;
      const migrated = legacy && registrations[block.name]?.deprecated?.length;

      return { ...block, attributes: migrated ? { content: block.attributes.old } : richTextAttributes(block.attributes, registrations[block.name]?.attributes, (value) => value.replaceAll('\u00a0', '&nbsp;').replace(/&(?![A-Za-z][A-Za-z0-9]*;|#[0-9]+;|#[xX][0-9A-Fa-f]+;)/g, '&amp;')), originalContent: JSON.stringify(block),
        clientId: `parsed-${index++}`, isValid: !f.invalidParse && (!legacy || !!migrated || !!f.legacyValid), innerBlocks: restore(block.innerBlocks) };
    });

    return restore(text ? text.split('\n\n').map((value) => JSON.parse(value)) : []);
  };

  f.blocks = [
    { name: 'core/paragraph', attributes: { content: 'Before' }, clientId: 'a', innerBlocks: [], isValid: true },
    { name: 'example/card', attributes: { variant: 'plain' }, clientId: 'b', innerBlocks: [], isValid: true },
    { name: 'core/paragraph', attributes: { content: 'Preserve' }, clientId: 'c', innerBlocks: [], isValid: true },
  ];
  f.post = { id: 7, type: post_type, status: 'draft', slug: 'example', title: { raw: 'Test' }, excerpt: { raw: '' },
    content: { raw: serialize(f.blocks) }, template: '', parent: 0, menu_order: 0, featured_media: 0, meta: {}, modified_gmt: 'before', date: 'before', date_gmt: 'before' };
  const handlers = new Map();
  const runningHooks = new Set();

  const hooks = {
    addAction(event, namespace, callback) {
      assert.match(namespace, /^[a-zA-Z][a-zA-Z0-9_.\-/]*$/);

      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push({ namespace, callback });
    },
    removeAction(event, namespace) {
      const list = handlers.get(event) ?? [];

      // WordPress removes every match and adjusts active dispatch indices.
      for (let index = list.length - 1; index >= 0; index--) {
        if (list[index].namespace !== namespace) continue;
        list.splice(index, 1);

        for (const run of runningHooks) {
          if (run.event === event && run.index >= index) run.index--;
        }
      }
    },
    emit(event, data) {
      const list = handlers.get(event) ?? [];
      const run = { event, index: 0 };
      runningHooks.add(run);

      try {
        while (run.index < list.length) {
          list[run.index].callback(data);
          run.index++;
        }
      } finally {
        runningHooks.delete(run);
      }
    },
  };

  const editor = {
    getCurrentPost: () => copy(f.loadedPost ?? f.post),
    getCurrentPostId: () => f.post.id, getCurrentPostType: () => f.post.type,
    getEditedPostAttribute: (name) => f.postEdits?.[name] ?? (f.post[name]?.raw ?? f.post[name]),
    getEditedPostContent: () => serialize(f.blocks), getEditorBlocks: () => f.blocks,
    isEditedPostDirty: () => f.dirty, isSavingPost: () => !!f.saving, isAutosavingPost: () => !!f.autosaving,
    isPostLocked: () => f.locked, isPostLockTakeover: () => false,
    getActivePostLock: () => '100:5', getEditorSettings: () => ({ postLockUtils: { ajaxUrl: '/wp-admin/admin-ajax.php', unlockNonce: 'test-only' } }),
    isEditedPostSaveable: () => true, isPostSavingLocked: () => f.savingLocks.size > 0,
    isPostAutosavingLocked: () => f.autosaveLocks.size > 0,
    didPostSaveRequestSucceed: () => true, getPostEdits: () => f.postEdits ?? {},
  };

  const blockEditor = { getBlocks: (root) => root ? find(f.blocks).find((block) => block.clientId === root).innerBlocks : f.blocks, canEditBlock: () => !f.disabled,
    getSettings: () => ({ __experimentalBlockBindingsSupportedAttributes: { 'core/paragraph': ['content'] }, ...f.editorSettings }),
    getSelectionStart: () => f.selectionStart ?? {}, getSelectionEnd: () => f.selectionEnd ?? {},
    getSelectedBlocksInitialCaretPosition: () => f.caret ?? null,
    getBlockEditingMode: () => f.mode || 'default',
    getTemplateLock: () => f.templateLock || false,
    getBlockListSettings: () => f.missingContext ? undefined : {},
    canRemoveBlocks: () => !f.removeLocked, canMoveBlock: () => !f.moveLocked, canInsertBlocks: () => !f.insertLocked,
    canInsertBlockType: (name, parent) => !f.insertLocked && !f.templateLock && name !== 'core/html' && parent !== 'blocked-parent',
    getInserterItems: () => Object.keys(registrations).map((name) => ({ name, title: name, isDisabled: name === 'core/html' })) };

  const actions = { lockPostAutosaving: (key) => { f.autosaveLocks.add(key); f.autosaveLocked = true; },
    unlockPostAutosaving: (key) => { f.autosaveLocks.delete(key); f.autosaveLocked = f.autosaveLocks.size > 0; },
    lockPostSaving: (key) => { f.savingLocks.add(key); }, unlockPostSaving: (key) => { f.savingLocks.delete(key); }, updatePostLock: () => {},
    editPost(values) {
      f.postEdits = { ...f.postEdits };

      for (const [name, value] of Object.entries(values)) {
        const next = name === 'meta' ? { ...(f.postEdits.meta ?? f.post.meta), ...copy(value) } : copy(value);
        const saved = f.post[name]?.raw ?? f.post[name];

        if (value === undefined || JSON.stringify(next) === JSON.stringify(saved)) delete f.postEdits[name];
        else f.postEdits[name] = next;
      }

      f.dirty = editor.getEditedPostContent() !== f.post.content.raw || Object.keys(f.postEdits).length > 0;
    },
    async savePost() {
      f.saves++;
      f.saving = true;
      f.notify();

      if (f.post.wp_id === 0) { f.post.wp_id = 51; f.post.source = 'custom'; f.post.author = f.user_id; }

      const editedDate = f.postEdits?.date_gmt;

      for (const [key, value] of Object.entries(f.postEdits ?? {})) {
        if (['content', 'blocks', 'selection'].includes(key)) continue;
        f.post[key] = ['title', 'excerpt'].includes(key) ? { raw: value } : copy(value);
      }

      f.postEdits = {};
      f.post.content.raw = serialize(f.post.type === 'wp_navigation' ? f.blocks[0].innerBlocks : f.blocks);
      f.post.date = f.post.modified_gmt = 'after';
      f.post.date_gmt = editedDate ?? 'after';
      f.dirty = false;

      if (f.metaBoxBody !== undefined) {
        try {
          const response = await f.window.fetch(f.metaBoxUrl ?? f.window._wpMetaBoxUrl, { method: 'POST', body: f.metaBoxBody, credentials: 'include' });

          if (!response.ok) throw new Error('Meta box save failed');
          f.metaBoxResponse = response;
        } catch (error) {
          // Core reports meta box failures separately from the document save.
          f.metaBoxError = error;
        }
      }

      await f.duringSave?.();

      f.saving = false;
      f.notify();

      if (f.interruptSave) throw new Error('connection-lost');

      if (f.statusAfterSave) f.post.status = f.statusAfterSave;
    } };

  let nextId = 0;
  const find = (list) => list.flatMap((block) => [block, ...find(block.innerBlocks || [])]);
  const listFor = (id) => id ? find(f.blocks).find((block) => block.clientId === id).innerBlocks : f.blocks;

  const parentFor = (id, list = f.blocks) => {
    if (list.some((block) => block.clientId === id)) return list;

    for (const block of list) { const found = parentFor(id, block.innerBlocks || []);

 if (found) return found; }
  };

  const wp = {
    element: { flushSync(callback) { callback(); } },
    htmlEntities: { decodeEntities: (html) => html.replace(/&(nbsp|amp|lt|gt);/g, (_, name) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>' })[name]) },
    hooks,
    heartbeat: {
      enqueue() {}, dequeue() {},
      connectNow() {
        f.pulses++;
        f.onPulse?.();
        queueMicrotask(() => hooks.emit('heartbeat.tick', { 'wp-refresh-post-lock': f.takeover
          ? { lock_error: { name: 'Other editor' } } : { new_lock: '101:5' } }));
      },
    },
    blocks: { getBlockType: (name) => registrations[name], getBlockTypes: () => Object.values(registrations), serialize, parse,
      __unstableSerializeAndClean: (blocks) => blocks.length === 1 && wp.blocks.isUnmodifiedDefaultBlock(blocks[0]) ? '' : wp.blocks.serialize(blocks),
      isUnmodifiedDefaultBlock: (block) => block.name === 'core/paragraph' &&
        Object.entries(registrations[block.name].attributes).every(([key, definition]) => {
          const value = block.attributes[key];

          if (Object.hasOwn(definition, 'default')) return value === definition.default;

          return definition.type === 'rich-text' ? !value?.length : value === undefined;
        }),
      createBlock: (name, attributes = {}, innerBlocks = []) => ({ name,
        // Gutenberg wraps top-level rich text and decodes &nbsp;; query values stay strings.
        attributes: Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key,
          registrations[name]?.attributes?.[key]?.type === 'rich-text' ? String(value).replaceAll('&nbsp;', '\u00a0') : value])), innerBlocks, clientId: `new-${nextId++}`, isValid: true }),
      createBlocksFromInnerBlocksTemplate: (items) => items.map(([name, attributes, children = []]) => wp.blocks.createBlock(name, attributes, wp.blocks.createBlocksFromInnerBlocksTemplate(children))),
      // Gutenberg keeps blocks that match the template by position and name.
      synchronizeBlocksWithTemplate: (blocks, items) => !items ? blocks : items.map(([name, attributes, children], index) => blocks[index]?.name === name
        ? { ...blocks[index], innerBlocks: wp.blocks.synchronizeBlocksWithTemplate(blocks[index].innerBlocks, children) }
        : wp.blocks.createBlock(name, attributes, wp.blocks.synchronizeBlocksWithTemplate([], children))),
      getBlockStyles: (name) => registrations[name]?.styles ?? [],
      getBlockVariations: (name) => registrations[name]?.variations ?? [],
      cloneBlock: (block, attributes, innerBlocks) => ({ ...block, attributes: { ...block.attributes, ...attributes }, innerBlocks }) },
    data: { resolveSelect: () => ({ getBlockPatterns: async () => f.patterns ?? [], getCurrentTheme: async () => ({ stylesheet: 'theme' }),
      canUser: async (...args) => {
        const result = f.resolveCanUser ? await f.resolveCanUser(...args) : false;

        if (args[1]?.kind === 'root' && args[1]?.name === 'site') f.siteCanRead = result;

        return result;
      },
      getEntityRecord: async (...args) => {
        const result = f.resolveEntity ? await f.resolveEntity(...args) : undefined;

        if (args[0] === 'root' && args[1] === 'site') f.siteRecord = result;

        return result;
      },
      getTaxonomies: async (...args) => f.resolveTaxonomies ? f.resolveTaxonomies(...args) : [],
      getEntityRecords: async (...args) => f.resolveRecords ? f.resolveRecords(...args) : [] }), subscribe(callback) {
      f.listeners.add(callback);

      return () => f.listeners.delete(callback);
    },
      select: (name) => name === 'core/editor' ? editor : name === 'core/edit-post' ? {
        hasMetaBoxes: () => !!f.hasMetaBoxes,
        isSavingMetaBoxes: () => !!f.savingMetaBoxes,
      } : name === 'core' ? {
        canUser: () => f.siteCanRead ?? false,
        getEntityRecord: () => f.siteRecord,
        getEntityRecordEdits: () => f.siteEdits ?? {},
        __experimentalGetDirtyEntityRecords: () => copy(f.dirtyEntities ?? []),
        hasResolvingSelectors: () => !!f.resolving,
        getLastEntitySaveError: () => f.saveError,
        getEntityRecordNonTransientEdits: () => Object.fromEntries(Object.entries(f.postEdits ?? {}).filter(([key]) => !['blocks', 'selection'].includes(key))),
        getEditedEntityRecord: () => ({ blocks: f.blocks, content: f.postEdits?.content ?? f.post.content.raw, meta: f.postEdits?.meta ?? f.post.meta }),
      } : name === 'core/blocks' ? { getBlockStyles: (name) => registrations[name]?.styles ?? [] } : blockEditor,
      dispatch: (name) => name === 'core/editor' ? actions : name === 'core' ? {
        editEntityRecord(kind, type, id, edits, options) {
          assert.equal(kind, 'postType'); assert.equal(type, f.post.type); assert.equal(id, f.post.id);
          assert.equal(options.undoIgnore, true);
          assert.deepEqual(Object.keys(edits), ['content']);

          if (edits.content === undefined) delete f.postEdits.content;
          else f.postEdits.content = edits.content;
          f.dirty = editor.getEditedPostContent() !== f.post.content.raw || Object.keys(f.postEdits).length > 0;
        },
      } : {
        selectBlock(id) {
          if (f.selectionStart?.clientId !== id) f.selectionStart = { clientId: id };

          if (f.selectionEnd?.clientId !== id) f.selectionEnd = { clientId: id };
          f.caret = null; f.onSelect?.(id);
        },
        resetSelection(start, end, position) { f.selectionStart = start; f.selectionEnd = end; f.caret = position; f.onSelectionRestore?.(); },
        insertBlocks(blocks, index, parent) { listFor(parent).splice(index, 0, ...copy(blocks)); f.dirty = true; f.afterInsert?.(); },
        replaceBlocks(ids, blocks) { const list = parentFor(ids[0]); list.splice(list.findIndex((block) => block.clientId === ids[0]), 1, ...copy(blocks)); f.dirty = true; },
        removeBlocks(ids) {
          const list = parentFor(ids[0]);
          list.splice(list.findIndex((block) => block.clientId === ids[0]), 1);

          if (f.ensureDefaultBlock && !f.blocks.length) f.blocks.push(wp.blocks.createBlock('core/paragraph', { content: '' }));
          f.dirty = true;
        },
        moveBlocksToPosition(ids, from, to, index) { const list = listFor(from); const [block] = list.splice(list.findIndex((block) => block.clientId === ids[0]), 1); listFor(to).splice(index, 0, block); f.dirty = true; },
        replaceInnerBlocks(id, blocks) { find(f.blocks).find(b => b.clientId === id).innerBlocks = copy(blocks); f.dirty = true; },
        resetBlocks(blocks) {
          f.blocks = copy(blocks);
          f.dirty = editor.getEditedPostContent() !== f.post.content.raw || Object.keys(f.postEdits ?? {}).length > 0;

          if (f.nativeContentMarker) {
            f.postEdits = { ...f.postEdits, content: () => wp.blocks.__unstableSerializeAndClean(f.blocks) };
            f.dirty = true;
          }

          // Native RESET_BLOCKS only retains selections present at the root.
          if (f.selectionStart?.clientId && !blocks.some((block) => block.clientId === f.selectionStart.clientId)) {
            f.selectionStart = f.selectionEnd = {};
          }
        },
        updateBlockAttributes(id, attributes) {
          const find = (list) => list.flatMap((block) => [block, ...find(block.innerBlocks || [])]);
          Object.assign(find(f.blocks).find((block) => block.clientId === id).attributes, attributes);
          f.dirty = true;
        },
      } },
    async apiFetch(options) {
      const { path, method = 'GET' } = options;
      f.requests.push({ path, method });

      if (!f.auth) throw { code: 'rest_cookie_invalid_nonce', message: 'secret' };

      if (path.includes('/users/me')) return { id: f.user_id, name: 'Test user', slug: 'test' };

      if (path === '/?_fields=url') return { url: f.site_url ?? target.site_url };

      if (f.api) {
        const value = await f.api(options);

        if (value !== undefined) return restFields(value, path, method);
      }

      if (path.startsWith('/wp/v2/types/')) return { slug: post_type, rest_base: post_type === 'page' ? 'pages' : post_type === 'post' ? 'posts' : 'books',
        rest_namespace: post_type === 'book' ? 'library/v1' : 'wp/v2', supports: { editor: true, title: true, 'custom-fields': true } };

      if (path.startsWith('/wp/v2/taxonomies')) return {};

      if (method === 'OPTIONS') {
        const raw = { type: 'object', properties: { raw: { type: 'string' } } };

        const properties = { id: { type: ['integer', 'string'], readonly: true }, type: { type: 'string', readonly: true },
          modified: { type: ['string', 'null'], readonly: true }, modified_gmt: { type: ['string', 'null'], readonly: true },
          date: { type: ['string', 'null'] }, link: { type: 'string', readonly: true },
          permalink_template: { type: 'string', readonly: true }, generated_slug: { type: 'string', readonly: true },
          author: { type: 'integer' }, password: { type: 'string' }, comment_status: { type: 'string' }, ping_status: { type: 'string' },
          sticky: { type: 'boolean' }, format: { type: 'string' }, categories: { type: 'array', items: { type: 'integer' } }, tags: { type: 'array', items: { type: 'integer' } },
          theme: { type: 'string' }, area: { type: 'string' }, wp_id: { type: 'integer', readonly: true }, source: { type: 'string', readonly: true },
          origin: { type: 'string', readonly: true }, has_theme_file: { type: 'boolean', readonly: true },
          title: raw, excerpt: raw, content: raw, slug: { type: 'string' }, status: { type: 'string', enum: ['draft', 'publish', 'pending', 'private', 'future'] },
          meta: { type: 'object', properties: { note: { type: 'string' }, count: { type: 'integer' }, footnotes: { type: 'string' } } },
          date_gmt: { type: ['string', 'null'], format: 'date-time', required: false },
          template: { type: 'string' }, parent: { type: 'integer' }, menu_order: { type: 'integer' }, featured_media: { type: 'integer' },
          ...f.schema };

        return { schema: { properties }, endpoints: [{ methods: ['POST', 'PUT', 'PATCH'], args: properties }] };
      }

      return restFields(f.post, path, method);
    },
  };

  f.window = { wp, scrollX: 0, scrollY: 0, fetch: () => Promise.resolve(new Response()) };
  f.registrations = registrations;
  f.syncContent = () => { f.post.content.raw = serialize(f.blocks); };

  // Browser invocation decodes JSON in the engine's realm, including nested patches.
  // A test moves the tab, as a redirect to the login page would, through f.location.
  f.location = new URL(url);
  const invoke = runInNewContext(`const invoke = ${engine}; (json) => invoke(JSON.parse(json))`, { window: f.window, location: f.location,
    URL, URLSearchParams, Response, TextEncoder, crypto, AbortSignal, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return Date.now() + (f.elapsedMs ?? 0); } },
    document: { body: { get className() { return f.bodyClass ?? 'wp-admin branch-7-1 version-7-1-2'; } }, createElement: () => ({ set innerHTML(html) { this.html = html.replaceAll('\u00a0', '&nbsp;').replace(/\s>\s/g, ' &gt; '); }, get innerHTML() { return this.html; } }), getElementById: (id) => f.isRendered?.(id) === false ? null : {}, querySelector: () => {
      f.canvasReads = (f.canvasReads ?? 0) + 1;

      return f.frame ?? null;
    } },
    fetch: async (url) => {
      if (String(url).startsWith('blob:')) {
        f.blobReads = (f.blobReads ?? 0) + 1;

        return { ok: true, text: async () => f.canvasHtml };
      }

      f.releases++;

      return { ok: true, text: async () => '1' };
    } });

  f.call = (operation, extra = {}) => {
    const identity = { ...target, post_type };

    if (operation === 'connect') delete identity.user_id;

    const request = { operation, target: identity };

    if (operation === 'connect') request.workflow = 'background';

    return invoke(JSON.stringify({ ...request, ...extra }));
  };

  f.edit = async (edits = changes) => {
    if (!f.window.__blockwork_editor) {
      const connected = await f.call('connect');
      assert.equal(connected.ok, true, JSON.stringify(connected));
    }

    return f.call('edit', { edits: edits.map((edit) => ({ op: 'update', ...edit })) });
  };

  f.save = async (extra = {}) => {
    const prepared = await f.call('prepare_save', extra);

    if (!prepared.ok || !prepared.receipt) return prepared;

    return f.call('save', { ...extra, receipt: prepared.receipt });
  };

  return f;
}

test('union arrays require a protected preview for attached neighboring edits', async () => {
  for (const value of [[], ['x']]) {
    const f = fixture();
    f.registrations['example/card'].attributes.config = { type: ['object', 'array'] };
    f.blocks[1].attributes.config = value;
    f.syncContent();
    assert.equal((await f.call('connect', { workflow: 'attached' })).ok, true);
    assert.equal((await f.call('read', { blocks: 'all' })).ok, true);
    const refused = await f.edit([{ client_id: 'b', attributes: { variant: 'accent' } }]);
    assert.equal(refused.error, 'ambiguous_union_attribute');
    assert.deepEqual(copy(refused.diagnostics.path), [1]);
    assert.equal(refused.diagnostics.attribute, 'config');
    assert.ok(refused.hint);
    assert.equal((await f.edit()).error, 'ambiguous_union_attribute');
    assert.equal(f.dirty, false);
    assert.equal((await f.call('connect', { workflow: 'attached', unsaved_preview: true })).ok, true);
    assert.equal((await f.edit()).editor_result, 'applied');
    assert.equal(f.autosaveLocks.size, 1);
    assert.equal(f.savingLocks.size, 1);
    assert.equal((await f.call('prepare_save', { save_all_pending: true })).error, 'unsaved_preview_save_forbidden');
    assert.equal(f.saves, 0);
  }
});

test('a native empty paragraph can be edited, reverted and saved', async () => {
  for (const workflow of ['attached', 'background']) {
    for (const structural of [false, true]) {
      const f = fixture();
      const wp = f.window.wp;
      f.ensureDefaultBlock = true;
      f.nativeContentMarker = true;
      f.blocks = [wp.blocks.createBlock('core/paragraph', { content: '' })];
      f.post.content.raw = '';
      const original = copy(f.blocks);
      const editor = wp.data.select('core/editor');
      const content = editor.getEditedPostContent;
      const placeholder = wp.blocks.serialize(f.blocks);
      editor.getEditedPostContent = () => content() === placeholder ? '' : content();
      const connected = await f.call('connect', { workflow });
      assert.equal(connected.ok, true, JSON.stringify(connected));
      const edits = structural ? [
        { op: 'remove', client_id: f.blocks[0].clientId },
        { op: 'insert', block: { name: 'core/group', inner_blocks: [{ name: 'core/paragraph', attributes: { content: 'New page' } }] } },
      ] : [{ op: 'update', client_id: f.blocks[0].clientId, attributes: { content: 'New page' } }];
      const edited = await f.call('edit', { edits });
      assert.equal(edited.editor_result, 'applied', JSON.stringify(edited));
      assert.equal(f.saves, 0);
      assert.equal((structural ? f.blocks[0].innerBlocks[0] : f.blocks[0]).attributes.content, 'New page');
      assert.equal((await f.call('revert')).ok, true);
      assert.deepEqual(f.blocks, original);
      assert.equal(f.dirty, false);
      assert.equal(editor.getEditedPostContent(), '');
      assert.equal((await f.call('edit', { edits })).ok, true);
      assert.equal((await f.save({ save_all_pending: workflow === 'attached' })).persistence, 'verified');
      assert.equal((await f.call('release')).ok, true);
    }
  }
});

test('blank-content edits refuse changed or unproved default blocks', async () => {
  for (const variant of ['text', 'style', 'children', 'multiple', 'missing_api', 'nonblank']) {
    const f = fixture();
    const wp = f.window.wp;
    f.blocks = [wp.blocks.createBlock('core/paragraph', { content: '' })];
    f.post.content.raw = variant === 'nonblank' ? ' ' : '';

    if (variant === 'text') f.blocks[0].attributes.content = 'Human text';

    if (variant === 'style') f.blocks[0].attributes.dropCap = true;

    if (variant === 'children') f.blocks[0].innerBlocks = [wp.blocks.createBlock('core/paragraph', { content: 'Child' })];

    if (variant === 'multiple') f.blocks.push(wp.blocks.createBlock('core/paragraph', { content: '' }));

    if (variant === 'missing_api') delete wp.blocks.isUnmodifiedDefaultBlock;
    wp.data.select('core/editor').getEditedPostContent = () => f.post.content.raw;
    const original = copy(f.blocks);
    const inspected = await f.call('connect', { workflow: 'attached' });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const edited = await f.call('edit', { edits: [{
      op: 'update', client_id: inspected.blocks[0].client_id, name: 'core/paragraph',
      attributes: { content: 'New page' },
    }] });
    assert.equal(edited.error, 'initial_serialization_changed', variant);
    assert.equal(edited.persistence, 'not_attempted');
    assert.equal(edited.editor_result, 'not_applied');
    assert.equal(edited.next, 'ask_user');
    assert.match(edited.diagnostics.editor_url, /\/wp-admin\/post\.php\?post=\d+&action=edit$/);
    assert.match(edited.hint, /re-saving it fixes this/);
    assert.match(edited.hint, /opens the editor for them with Save ready/);
    assert.deepEqual(f.blocks, original);
    assert.equal(f.saves, 0);
  }
});

test('attached editing preserves the human draft and pending settings without saving', async () => {
  const f = fixture();
  f.blocks[2].attributes.content = 'Human draft'; f.dirty = true;
  f.postEdits = { title: 'Human title', meta: { note: 'Human note' } };
  const connected = await f.call('connect', { workflow: 'attached', settings: true });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.equal((await f.edit()).editor_result, 'applied');
  assert.equal(f.blocks[0].attributes.content, 'After');
  assert.equal(f.blocks[2].attributes.content, 'Human draft');
  assert.deepEqual(f.postEdits, { title: 'Human title', meta: { note: 'Human note' } });
  assert.equal(f.saves, 0); assert.equal(f.autosaveLocks.size, 0);
  assert.equal((await f.call('release')).close_document, false);
  assert.equal(f.releases, 0);
});

test('attached saving requires whole-document acknowledgment at both page steps', async () => {
  const f = fixture();
  f.postEdits = { title: 'Human title' }; f.dirty = true;
  await f.call('connect', { workflow: 'attached' });
  assert.equal((await f.edit()).editor_result, 'applied');
  assert.equal((await f.call('prepare_save')).error, 'save_all_pending_required');
  const prepared = await f.call('prepare_save', { save_all_pending: true });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(f.saves, 0);
  assert.equal((await f.call('save', { receipt: prepared.receipt })).error, 'save_all_pending_required');
  const saved = await f.call('save', { receipt: prepared.receipt, save_all_pending: true });
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(saved.saved_all_pending, true);
  assert.equal(f.post.title.raw, 'Human title');
  assert.equal(f.saves, 1);
  assert.equal((await f.edit([{ ...changes[0], attributes: { content: 'Again' } }])).ok, true);
});

test('attached saving reports pending entities without saving their drafts', async () => {
  const f = fixture();
  f.dirtyEntities = [{ kind: 'postType', name: 'wp_block', key: 77 }];
  await f.call('connect', { workflow: 'attached' });
  await f.edit();
  const saved = await f.save({ save_all_pending: true });
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(saved.saved_all_pending, false);
  assert.equal(saved.pending_entity_count, 1);
  assert.deepEqual(f.dirtyEntities, [{ kind: 'postType', name: 'wp_block', key: 77 }]);
});

test('attached session supports follow-up edits and exposes native selection targets', async () => {
  const f = fixture();
  f.selectionStart = { clientId: 'a', attributeKey: 'content', offset: 1 };
  f.selectionEnd = { clientId: 'a', attributeKey: 'content', offset: 4 };
  const first = await f.call('connect', { workflow: 'attached' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.native_selection.blocks[0].client_id, 'a');
  assert.equal(first.native_selection.start.offset, 1);
  const edited = await f.call('edit', { edits: changes });
  assert.equal(edited.editor_result, 'applied');
  const second = await f.call('connect', { workflow: 'attached' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.editor_instance, first.editor_instance);
  assert.equal((await f.call('edit', { edits: [{ client_id: 'a', op: 'update', attributes: { content: 'Second edit' } }] })).edit_count, 2);
  assert.equal(f.selectionStart.offset, 1);
});

test('attached revert restores native dirty state without clearing an original human draft', async () => {
  for (const dirty of [false, true]) {
    const f = fixture();
    f.nativeContentMarker = true;

    if (dirty) { f.blocks[2].attributes.content = 'Earlier human draft'; f.dirty = true; }

    await f.call('connect', { workflow: 'attached' });
    await f.call('edit', { edits: changes });

    const reverted = await f.call('revert');
    assert.equal(reverted.ok, true, JSON.stringify(reverted));
    assert.equal(f.dirty, dirty);
    assert.equal(f.blocks[2].attributes.content, dirty ? 'Earlier human draft' : 'Preserve');
    assert.equal(f.saves, 0);
  }
});

test('revert and prepared save refuse intervening typing', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached' });
  await f.edit();
  const prepared = await f.call('prepare_save', { save_all_pending: true });
  f.blocks[2].attributes.content = 'Human typing';
  assert.equal((await f.call('revert')).error, 'intervening_editor_change');
  assert.equal((await f.call('save', { receipt: prepared.receipt, save_all_pending: true })).error, 'intervening_editor_change');
  assert.equal(f.blocks[2].attributes.content, 'Human typing');
  assert.equal(f.saves, 0);
});

test('unsaved preview holds both native locks until exact restoration', async () => {
  for (const dirty of [false, true]) {
    const f = fixture();

    if (dirty) { f.blocks[2].attributes.content = 'Pending typing'; f.dirty = true; }

    const original = copy(f.blocks);
    const connected = await f.call('connect', { workflow: 'attached', unsaved_preview: true });
    assert.equal(connected.unsaved_preview, true);
    assert.equal(f.autosaveLocks.size, 1); assert.equal(f.savingLocks.size, 1);
    assert.equal((await f.edit()).ok, true);
    assert.equal((await f.call('prepare_save', { save_all_pending: true })).error, 'unsaved_preview_save_forbidden');
    assert.equal(f.savingLocks.size, 1);
    assert.equal((await f.call('revert')).ok, true);
    assert.deepEqual(f.blocks, original);
    assert.equal((await f.edit()).ok, true);
    assert.equal((await f.call('release')).close_document, false);
    assert.deepEqual(f.blocks, original);
    assert.equal(f.dirty, dirty);
    assert.equal(f.autosaveLocks.size, 0); assert.equal(f.savingLocks.size, 0);
    assert.equal(f.window.__blockwork_editor, undefined);
    assert.equal(f.saves, 0);
  }
});

test('unsaved preview refuses release after human typing, pending settings, or saved changes', async () => {
  for (const changed of ['typing', 'settings', 'saved']) {
    const f = fixture();
    const inspected = await f.call('connect', { workflow: 'attached', unsaved_preview: true });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));

    if (changed === 'typing') { f.blocks[2].attributes.content = 'Later human typing'; f.dirty = true; }

    if (changed === 'settings') { f.postEdits = { title: 'Later human title' }; f.dirty = true; }

    if (changed === 'saved') f.post.modified_gmt = 'another editor saved';
    const released = await f.call('release');
    assert.equal(released.error, changed === 'saved' ? 'unsaved_preview_saved_changed' : 'unsaved_preview_pending');
    assert.equal(f.autosaveLocks.size, 1);
    assert.equal(f.savingLocks.size, 1);
    assert.equal(f.saves, 0);

    if (changed === 'typing') assert.equal(f.blocks[2].attributes.content, 'Later human typing');

    if (changed === 'settings') assert.equal(f.postEdits.title, 'Later human title');
  }
});

test('unsaved preview releases only its own native lock keys', async () => {
  const f = fixture();
  f.autosaveLocks.add('another-owner'); f.savingLocks.add('another-owner');
  const inspected = await f.call('connect', { workflow: 'attached', unsaved_preview: true });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  const released = await f.call('release');
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.deepEqual([...f.autosaveLocks], ['another-owner']);
  assert.deepEqual([...f.savingLocks], ['another-owner']);
});

test('unsaved preview refuses missing or lost native save protection before mutation', async () => {
  for (const missing of ['capability', 'lock']) {
    const f = fixture();
    const actions = f.window.wp.data.dispatch('core/editor');

    if (missing === 'capability') delete actions.lockPostSaving;
    const inspected = await f.call('connect', { workflow: 'attached', unsaved_preview: true });

    if (missing === 'capability') {
      assert.equal(inspected.error, 'unsaved_preview_unavailable');
      assert.equal(f.autosaveLocks.size, 0);
    } else {
      f.savingLocks.clear();
      const edited = await f.call('edit', { edits: changes });

      assert.equal(edited.error, 'unsaved_preview_lock_lost');
      assert.equal(f.blocks[0].attributes.content, 'Before');
    }

    assert.equal(f.saves, 0);
  }
});

test('attached inspection handles native raw strings and optional undefined fields after autosave', async () => {
  const f = fixture();
  f.loadedPost = { ...copy(f.post), title: 'Test', content: f.post.content.raw, excerpt: '', preview_link: undefined, date_gmt: 'old-draft-date' };
  const inspected = await f.call('connect', { workflow: 'attached' });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
});

test('attached rendering preserves a user selection made during native initialization', async () => {
  const f = fixture();
  f.selectionStart = { clientId: 'a', attributeKey: 'content', offset: 1 };
  f.selectionEnd = { clientId: 'a', attributeKey: 'content', offset: 3 };
  await f.call('connect', { workflow: 'attached' });
  const humanSelection = { clientId: 'c', attributeKey: 'content', offset: 2 };
  f.onSelect = () => { f.selectionStart = f.selectionEnd = copy(humanSelection); };

  const applied = await f.call('edit', { edits: [{ op: 'insert', block: { name: 'example/card' } }] });
  assert.equal(applied.ok, false);
  assert.deepEqual(f.selectionStart, humanSelection);
  assert.deepEqual(f.selectionEnd, humanSelection);
  assert.equal(f.autosaveLocked, false);
});

test('attached initialization accepts native retained text selection in an affected block', async () => {
  const f = fixture();
  f.selectionStart = { clientId: 'a', attributeKey: 'content', offset: 0 };
  f.selectionEnd = { clientId: 'a', attributeKey: 'content', offset: 3 };
  const before = copy(f.selectionStart);
  await f.call('connect', { workflow: 'attached' });
  const edited = await f.call('edit', { edits: [...changes, { op: 'insert', block: { name: 'example/card' } }] });

  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.deepEqual(copy(f.selectionStart), before);
  assert.equal(f.selectionEnd.offset, 3);
  assert.equal(f.autosaveLocked, false);
});

test('style guide uses effective per-block settings, live presets, and normalized viewport ranges', async () => {
  const f = stylingFixture();
  f.editorSettings.__experimentalFeatures.blocks = { 'core/group': { spacing: { margin: false } } };
  const inspected = await f.call('connect', { style_guides: [{ client_id: 'a' }] });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  const guide = inspected.style_guides[0];
  assert.equal(inspected.style_rules.responsive.states['@mobile'], 'width <= 32rem');
  assert.equal(inspected.style_rules.responsive.states['@tablet'], '32rem < width <= 60rem');
  assert.equal(guide.responsive, undefined);
  assert.equal(guide.controls.some((control) => control.property.join('.') === 'style.spacing.margin'), false);
  assert.ok(guide.controls.some((control) => control.property.join('.') === 'style.color.text'));
  assert.equal(guide.controls.some((control) => 'enabled' in control), false);
  assert.equal(guide.custom_css, true);
  assert.equal(inspected.style_rules.custom_css.can_edit_css, true);
  assert.equal(inspected.style_rules.custom_css.document_has_custom_css, true);
  delete f.window.wp.blockEditor;
  const unknown = await f.call('connect', { style_guides: [{ client_id: 'a' }] });
  assert.equal(unknown.style_rules.responsive.available, false);
  assert.deepEqual(Object.keys(unknown.style_rules.responsive.states), []);
});

test('a block type with its own viewport ranges carries its own responsive rules in any guide order', async () => {
  const f = stylingFixture();
  f.editorSettings.__experimentalFeatures.blocks = { 'core/group': { viewport: { tablet: '50rem' } } };

  for (const order of [[{ client_id: 'a' }, { name: 'core/paragraph' }], [{ name: 'core/paragraph' }, { client_id: 'a' }]]) {
    const inspected = await f.call('connect', { style_guides: order });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    assert.equal(inspected.style_rules.responsive.states['@tablet'], '32rem < width <= 60rem');
    const group = inspected.style_guides.find((guide) => guide.name === 'core/group');
    const paragraph = inspected.style_guides.find((guide) => guide.name === 'core/paragraph');
    assert.equal(group.responsive.states['@tablet'], '32rem < width <= 50rem');
    assert.equal(paragraph.responsive, undefined);
  }
});

test('compact style inspection shares usable preset catalogs across guides without changing the draft', async () => {
  for (const workflow of ['background', 'attached']) {
    const f = stylingFixture();
    const palette = Array.from({ length: 60 }, (_, index) => ({
      name: `Theme color ${index}`, slug: `theme-color-${index}`, color: '#445566',
    }));
    f.editorSettings.__experimentalFeatures.color.palette.theme = palette;
    f.registrations['core/group'].supports.typography.__experimentalFontFamily = true;
    f.editorSettings.__experimentalFeatures.typography.fontFamilies = { theme: [{
      name: 'Body', slug: 'body', fontFamily: 'Body, sans-serif',
      fontFace: [{ src: 'font-file-'.repeat(1000) }],
    }] };
    const before = copy(f.blocks);
    const inspected = await f.call('connect', { workflow, style_guides: [
      { client_id: 'a' }, ...Array.from({ length: 5 }, () => ({ name: 'core/group' })),
    ] });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    assert.ok(Buffer.byteLength(JSON.stringify(inspected)) < 32 * 1024);
    assert.equal(inspected.style_guides.length, 6);
    const text = inspected.style_guides[0].controls.find(control => control.property.join('.') === 'style.color.text');
    const catalog = inspected.style_catalogs[text.preset_catalog];
    assert.equal(catalog.preset_type, 'color');
    assert.deepEqual(JSON.parse(JSON.stringify(catalog.items)), palette);
    assert.equal(inspected.style_catalogs.filter(item => item.preset_type === 'color').length, 1);
    const font = inspected.style_guides[0].controls.find(control => control.preset_type === 'font-family');
    assert.deepEqual(JSON.parse(JSON.stringify(inspected.style_catalogs[font.preset_catalog].items)), [
      { name: 'Body', slug: 'body', fontFamily: 'Body, sans-serif' },
    ]);
    assert.deepEqual(copy(f.blocks), before);
    assert.equal(f.dirty, false);
    const edit = { op: 'update_style', path: [0], name: 'core/group',
      set: [{ property: ['style', 'color', 'text'], value: 'var:preset|color|theme-color-59' }] };
    const edited = await f.call('edit', { edits: [edit] });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    assert.equal(f.saves, 0);
  }
});

test('invalid style property prefixes fail before acquiring an editor session', async () => {
  const f = fixture();
  const result = await f.call('connect', { style_guides: [{ name: 'core/group', properties: [['']] }] });
  assert.equal(result.error, 'invalid_connection');
  assert.equal(result.issues[0].path, 'style_guides.0.properties.0.0');
  assert.match(result.hint, /key arrays/);
  assert.equal(f.window.__blockwork_editor, undefined);
  assert.equal(f.saves, 0);
});

test('inspection response budget identifies oversized sections without exposing their values', async () => {
  const f = stylingFixture();
  f.blocks[0].attributes.style.css = 'PRIVATE_STYLE_VALUE'.repeat(4000);
  f.syncContent();
  const before = copy(f.blocks);
  const result = await f.call('connect', { workflow: 'attached', style_guides: [{ client_id: 'a' }] });
  assert.equal(result.error, 'inspection_too_large');
  assert.equal(result.diagnostics.stage, 'inspection_response');
  assert.equal(result.diagnostics.max_bytes, 64 * 1024);
  assert.ok(result.diagnostics.response_bytes > result.diagnostics.max_bytes);
  assert.ok(result.diagnostics.section_bytes.style_guides > result.diagnostics.max_bytes);
  assert.equal(result.diagnostics.guide_bytes[0].guide_index, 0);
  assert.ok(result.diagnostics.guide_bytes[0].bytes > result.diagnostics.max_bytes);
  assert.match(result.hint, /style_guides\[index\].properties/);
  assert.match(result.hint, /do not raise/);
  assert.equal(JSON.stringify(result).includes('PRIVATE_STYLE_VALUE'), false);
  assert.deepEqual(copy(f.blocks), before);
  assert.equal(f.saves, 0);
});

test('responsive style patch preserves sibling values, CSS, classes and base styles through a verified save', async () => {
  const f = stylingFixture();
  const before = copy(f.blocks[0].attributes);
  const edited = await styleEdit(f, [{ property: ['style', '@mobile', 'spacing', 'padding', 'top'], value: '10px' }]);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.deepEqual(copy(edited.changed[0].properties), ['style.@mobile.spacing.padding.top']);
  assert.equal(f.dirty, true);
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  const expected = copy(before);
  expected.style['@mobile'].spacing.padding.top = '10px';
  assert.deepEqual(copy(f.blocks[0].attributes), expected);
  assert.equal(f.post.status, 'draft');
});

test('unsetting a responsive property restores inheritance and preserves other ranges', async () => {
  const f = stylingFixture();
  const edited = await styleEdit(f, [], [['style', '@tablet', 'spacing', 'padding', 'top']]);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks[0].attributes.style['@tablet'], undefined);
  assert.equal(f.blocks[0].attributes.style.spacing.padding.top, '24px');
  assert.equal(f.blocks[0].attributes.style['@mobile'].spacing.padding.left, '8px');
});

test('preset and custom representations switch without retaining the competing base value', async () => {
  for (const custom of [false, true]) {
    const f = stylingFixture();

    if (custom) { f.blocks[0].attributes.fontSize = 'large'; delete f.blocks[0].attributes.style.typography; f.syncContent(); }

    const set = custom ? [{ property: ['style', 'typography', 'fontSize'], value: '28px' }]
      : [{ property: ['fontSize'], value: 'large' }];
    const edited = await styleEdit(f, set);
    assert.equal(edited.ok, true, JSON.stringify(edited));
    const saved = await f.save();
    assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
    assert.equal(f.blocks[0].attributes.fontSize, custom ? undefined : 'large');
    assert.equal(f.blocks[0].attributes.style.typography?.fontSize, custom ? '28px' : undefined);
    assert.equal(f.blocks[0].attributes.style.css, '& strong { color: red; }');
  }
});

test('style patches reject unsupported states, properties, presets and conflicting requests', async () => {
  const cases = [
    [[{ property: ['style', '@desktop', 'spacing', 'padding', 'top'], value: '2px' }], [], 'unsupported_style_state'],
    [[{ property: ['metadata', 'name'], value: 'hidden mutation' }], [], 'unsupported_style_property'],
    [[{ property: ['style', '__proto__', 'polluted'], value: 'yes' }], [], 'unsupported_style_property'],
    [[{ property: ['fontSize'], value: 'missing' }], [], 'style_preset_unavailable'],
    [[{ property: ['style', 'spacing', 'padding', 'top'], value: '2px' }], [['style', 'spacing', 'padding']], 'overlapping_style_properties'],
    [[{ property: ['fontSize'], value: 'large' }, { property: ['style', 'typography', 'fontSize'], value: '2px' }], [], 'competing_style_properties'],
  ];

  for (const [set, unset, error] of cases) {
    const f = stylingFixture();
    const result = await styleEdit(f, set, unset);
    assert.equal(result.ok, false);
    assert.equal(result.error, error, JSON.stringify(result));
    assert.equal(f.dirty, false);
    assert.equal(f.saves, 0);
  }
});

test('style patches protect existing native CSS from a save without edit_css permission', async () => {
  const f = stylingFixture();
  f.editorSettings.canEditCSS = false;
  const edited = await styleEdit(f, [{ property: ['style', 'spacing', 'padding', 'top'], value: '30px' }]);
  assert.equal(edited.ok, false);
  assert.equal(edited.error, 'custom_css_permission_required');
  assert.equal(f.saves, 0);
  assert.equal(f.dirty, false);

  delete f.blocks[0].attributes.style.css;
  f.blocks.push({ name: 'core/group', clientId: 'neighbor', isValid: true, innerBlocks: [], attributes: { style: { css: 'color: red;' } } });
  f.syncContent();
  const neighbor = await styleEdit(f, [{ property: ['style', 'spacing', 'padding', 'top'], value: '30px' }]);
  assert.equal(neighbor.error, 'custom_css_permission_required');
  assert.equal(f.saves, 0);
});

test('ordered style patches beside unsupported content retain its exact bytes through save', async () => {
  const f = stylingFixture();
  f.blocks.push({ name: 'core/html', attributes: { content: '<p>Preserve raw bytes.</p>' }, clientId: 'raw', innerBlocks: [], isValid: true });
  f.syncContent();
  const originalRaw = f.window.wp.blocks.serialize([f.blocks[1]]);
  await f.call('connect', { style_guides: [{ client_id: 'a' }] });
  const edits = ['top', 'right'].map((side) => ({ op: 'update_style', path: [0], name: 'core/group',
    set: [{ property: ['style', 'spacing', 'padding', side], value: '32px' }] }));
  const edited = await f.call('edit', { edits });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(saved.preservation_status, 'verified_after_read');
  assert.equal(f.window.wp.blocks.serialize([f.blocks[1]]), originalRaw);
  assert.equal(f.blocks[0].attributes.style.spacing.padding.top, '32px');
  assert.equal(f.blocks[0].attributes.style.spacing.padding.right, '32px');
});

test('native CSS accepts child selectors while custom-value and responsive editing restrictions refuse', async () => {
  const f = stylingFixture();
  const css = '& > p { color: red; }';
  const edited = await styleEdit(f, [{ property: ['style', 'css'], value: css }]);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks[0].attributes.style.css, css);

  const g = stylingFixture();
  g.editorSettings.__experimentalFeatures.typography.customFontSize = false;
  assert.equal((await styleEdit(g, [{ property: ['style', 'typography', 'fontSize'], value: '2px' }])).error, 'custom_style_disabled');
  g.editorSettings.responsiveEditingEnabled = false;
  assert.equal((await styleEdit(g, [{ property: ['style', '@mobile', 'spacing', 'padding', 'top'], value: '2px' }])).error, 'style_state_editing_disabled');
});

test('style guides restrict side patches to the registration and give exact preset value formats', async () => {
  const f = stylingFixture();
  f.registrations['core/group'].supports.spacing.margin = ['top', 'bottom'];
  const read = await f.call('connect', { style_guides: [{ client_id: 'a' }] });
  const margin = read.style_guides[0].controls.find((control) => control.property.join('.') === 'style.spacing.margin');
  assert.deepEqual(copy(margin.edges), ['top', 'bottom']);
  assert.equal(margin.requires_edge, true);
  const font = read.style_guides[0].controls.find((control) => control.preset_attribute === 'fontSize');
  assert.equal(font.preset_value_format, 'var:preset|font-size|SLUG');
  const wrongSide = await styleEdit(f, [{ property: ['style', 'spacing', 'margin', 'left'], value: '2px' }]);
  assert.equal(wrongSide.error, 'unsupported_style_property');
  const shorthand = await styleEdit(f, [{ property: ['style', 'spacing', 'margin'], value: '2px' }]);
  assert.equal(shorthand.error, 'style_side_required');

  f.editorSettings.__experimentalFeatures.typography.defaultFontSizes = false;
  f.editorSettings.__experimentalFeatures.typography.fontSizes.default = [{ slug: 'hidden', size: '16px' }];
  const hidden = await styleEdit(f, [{ property: ['fontSize'], value: 'hidden' }]);
  assert.equal(hidden.error, 'style_preset_unavailable');
});

test('resetting the last style property removes the attribute while a responsive preset retains the base', async () => {
  const f = stylingFixture();
  f.blocks[0].attributes.style = { spacing: { padding: { top: '24px' } } };
  f.syncContent();
  const edited = await styleEdit(f, [], [['style', 'spacing', 'padding', 'top']]);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(f.blocks[0].attributes.style, undefined);

  const g = stylingFixture();
  g.blocks[0].attributes.fontSize = 'large';
  delete g.blocks[0].attributes.style.typography;
  g.syncContent();
  const plan = await styleEdit(g, [{ property: ['style', '@mobile', 'typography', 'fontSize'], value: 'var:preset|font-size|large' }]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await g.save()).persistence, 'verified');
  assert.equal(g.blocks[0].attributes.fontSize, 'large');
  assert.equal(g.blocks[0].attributes.style['@mobile'].typography.fontSize, 'var:preset|font-size|large');
});

test('document settings and content share one verified native save', async () => {
  const f = fixture('book');
  f.post.meta = { note: 'before', count: 3 };
  const inspected = await f.call('connect', { settings: true });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));

  const edited = await f.call('edit', { edits: changes,
    post: { title: 'A book', slug: 'a-book', status: 'private' }, settings: { meta: { note: 'after' } } });

  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(f.saves, 0);
  assert.equal(f.post.title.raw, 'Test');
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(f.saves, 1);
  assert.equal(f.post.title.raw, 'A book');
  assert.equal(f.post.status, 'private');
  assert.deepEqual(f.post.meta, { note: 'after', count: 3 });
  delete f.window.__blockwork_editor;
});

test('settings-only plans reject unknown metadata and preserve unrelated fields', async () => {
  const f = fixture();
  await f.call('connect');
  const bad = await f.call('edit', { settings: { meta: { private_field: 'no' } } });
  assert.equal(bad.ok, false);
  assert.equal(f.saves, 0);
  const edited = await f.call('edit', { post: { title: 'Only title' } });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const original = f.post.content.raw;
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(f.post.content.raw, original);
  assert.equal(f.post.status, 'draft');
});

test('a metadata key named raw remains part of the complete metadata object', async () => {
  const f = fixture();
  f.post.meta = { raw: 'Preserve raw', note: 'Before' };
  f.schema = { meta: { type: 'object', properties: { raw: { type: 'string' }, note: { type: 'string' } } } };
  await f.call('connect');
  const plan = await f.call('edit', { settings: { meta: { note: 'After' } } });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.deepEqual(f.post.meta, { raw: 'Preserve raw', note: 'After' });
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

test('meta box forms save without a readable document change and respect native busy and lock state', async () => {
  for (const blocked of [undefined, 'busy', 'locked']) {
    const f = fixture();
    f.hasMetaBoxes = true;
    f.window._wpMetaBoxUrl = '/wp-admin/post.php';
    f.metaBoxBody = 'value=Form-only';
    f.window.fetch = () => Promise.resolve(new Response(null, { status: 200 }));
    await f.call('connect', { workflow: 'attached' });
    const original = f.post.content.raw;
    f.savingMetaBoxes = blocked === 'busy';
    f.locked = blocked === 'locked';
    const result = await f.save({ save_all_pending: true });

    if (blocked) {
      assert.equal(result.error, blocked === 'busy' ? 'save_in_progress' : 'post_locked', JSON.stringify(result));
      assert.equal(f.saves, 0);
    } else {
      assert.equal(result.persistence, 'verified', JSON.stringify(result));
      assert.equal(result.meta_boxes, 'saved');
      assert.equal(f.saves, 1);
      assert.equal(f.post.content.raw, original);
    }
  }
});

test('meta box redirects become OK responses and restore fetch in both workflows', async () => {
  for (const workflow of ['attached', 'background']) {
    const f = fixture();
    f.window._wpMetaBoxUrl = '/wp-admin/post.php?nonce=original';
    f.metaBoxUrl = f.window._wpMetaBoxUrl + '&_locale=user';
    f.metaBoxBody = new URLSearchParams({ value: 'After' });
    const requests = [];
    const originalFetch = (...args) => {
      requests.push(args);

      return Promise.resolve({ type: 'opaqueredirect', ok: false });
    };

    f.window.fetch = originalFetch;
    await f.call('connect', { workflow });
    await f.edit();
    const result = await f.save(workflow === 'attached' ? { save_all_pending: true } : {});
    assert.equal(result.persistence, 'verified', JSON.stringify(result));
    assert.equal(result.meta_boxes, 'saved');
    assert.equal(f.metaBoxResponse.ok, true);
    assert.equal(f.metaBoxResponse.status, 200);
    assert.equal(requests[0][0], f.metaBoxUrl);
    assert.equal(requests[0][1].body, f.metaBoxBody);
    assert.deepEqual({ ...requests[0][1], body: undefined }, { method: 'POST', body: undefined, credentials: 'include', redirect: 'manual' });
    assert.equal(f.window.fetch, originalFetch);
  }
});

test('meta box OK, HTTP failure and rejection preserve document verification', async () => {
  for (const outcome of ['ok', 'http_failure', 'rejection']) {
    const f = fixture();
    f.window._wpMetaBoxUrl = '/wp-admin/post.php';
    f.metaBoxBody = 'value=After';
    const response = new Response(null, { status: outcome === 'http_failure' ? 500 : 200 });
    const originalFetch = () => outcome === 'rejection' ? Promise.reject(new Error('network failed')) : Promise.resolve(response);
    f.window.fetch = originalFetch;
    await f.edit();
    const result = await f.save();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.persistence, 'verified');
    assert.equal(result.meta_boxes, outcome === 'ok' ? 'saved' : 'failed');
    assert.equal(Boolean(f.metaBoxError), outcome !== 'ok');

    if (outcome === 'ok') assert.equal(f.metaBoxResponse, response);
    assert.equal(f.window.fetch, originalFetch);
  }
});

test('a meta box can write a key this save left alone, never one it requested', async () => {
  for (const requested of [false, true]) {
    const f = fixture();
    f.window._wpMetaBoxUrl = '/wp-admin/post.php';
    f.metaBoxBody = 'value=form';
    f.window.fetch = () => Promise.resolve(new Response(null, { status: 200 }));
    f.post.meta = { note: 'stored' };
    await f.call('connect', { settings: true });
    const edited = await f.call('edit', requested ? { settings: { meta: { note: 'requested' } } } : { post: { title: 'Changed' } });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    f.duringSave = () => { f.post.meta = { note: 'from form' }; };

    const result = await f.save();
    assert.equal(result.meta_boxes ?? result.diagnostics?.meta_boxes, 'saved', JSON.stringify(result));
    assert.equal(result.persistence, requested ? 'applied_with_differences' : 'verified', JSON.stringify(result));
  }
});

test('a slug WordPress generates when a draft stops being a draft still verifies', async () => {
  const f = fixture();
  Object.assign(f.post, { status: 'draft', slug: '' });
  await f.call('connect');
  assert.equal((await f.call('edit', { post: { status: 'publish' } })).ok, true);
  f.duringSave = () => { f.post.slug = 'generated-by-wordpress'; };

  const result = await f.save();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.persistence, 'verified');
});

test('a slug that appears while a draft stays a draft is a real difference', async () => {
  const f = fixture();
  Object.assign(f.post, { status: 'draft', slug: '' });
  await f.call('connect');
  assert.equal((await f.call('edit', { post: { title: 'Changed' } })).ok, true);
  f.duringSave = () => { f.post.slug = 'set-by-a-plugin'; };

  const result = await f.save();
  assert.notEqual(result.persistence, 'verified', JSON.stringify(result));
});

test('saves without meta box POSTs report none and restore fetch even on a throw', async () => {
  for (const interruptSave of [false, true]) {
    const f = fixture();
    const originalFetch = () => Promise.resolve(new Response());
    f.window.fetch = originalFetch;
    f.interruptSave = interruptSave;
    await f.edit();
    const result = await f.save();
    assert.equal(interruptSave ? result.persistence : result.meta_boxes, interruptSave ? 'uncertain' : 'none');
    assert.equal(f.window.fetch, originalFetch);
  }
});

test('a fetch replacement installed during a save survives guarded restoration', async () => {
  const f = fixture();
  f.window._wpMetaBoxUrl = '/wp-admin/post.php';
  const promise = Promise.resolve(new Response());
  let receivedOptions;
  const originalFetch = (input, options) => {
    receivedOptions = options;

    return promise;
  };

  f.window.fetch = originalFetch;
  let replacement;
  f.duringSave = () => {
    const chained = f.window.fetch;
    replacement = (...args) => chained(...args);
    f.window.fetch = replacement;
  };

  await f.edit();
  assert.equal((await f.save()).meta_boxes, 'none');
  assert.equal(f.window.fetch, replacement);
  const options = { method: 'POST' };
  assert.equal(f.window.fetch(f.window._wpMetaBoxUrl, options), promise);
  assert.equal(receivedOptions, options);
});

test('save fetch matches middleware query additions and passes other requests through unchanged', async () => {
  const f = fixture();
  f.window._wpMetaBoxUrl = '/wp-admin/post.php?nonce=old';
  const response = new Response();
  const promise = Promise.resolve(response);
  const requests = [];
  f.window.fetch = (...args) => {
    requests.push(args);

    return promise;
  };

  f.duringSave = async () => {
    const unchanged = [
      ['/wp-json/wp/v2/pages/7', { method: 'POST', body: 'rest' }],
      [f.window._wpMetaBoxUrl, { method: 'GET' }],
      [new Request(new URL(f.window._wpMetaBoxUrl, f.location), { method: 'POST' })],
      ['/wp-admin/post.php?nonce=different&action=edit&_locale=user', { method: 'POST' }],
      ['/wp-admin/post.php?nonce=new&_locale=user', { method: 'POST' }],
      ['https://other.test/wp-admin/post.php?nonce=new&action=edit', { method: 'POST' }],
      ['/other.php?nonce=new&action=edit', { method: 'POST' }],
    ];
    f.window._wpMetaBoxUrl = '/wp-admin/post.php?nonce=new&action=edit';
    unchanged.push(['/wp-admin/post.php?nonce=old', { method: 'POST' }], ['/wp-admin/post.php?nonce=new&action=edit&action=plugin-task', { method: 'POST' }]);

    for (const args of unchanged) {
      assert.equal(f.window.fetch(...args), promise);
      assert.equal(requests.at(-1).length, args.length);

      for (let index = 0; index < args.length; index++) assert.equal(requests.at(-1)[index], args[index]);
    }

    const input = new URL(f.window._wpMetaBoxUrl, f.location);
    input.searchParams.set('_locale', 'user');
    input.searchParams.set('middleware', 'extra');
    assert.equal(await f.window.fetch(input, { method: 'pOsT' }), response);
    assert.equal(requests.at(-1)[0], input);
    assert.deepEqual({ ...requests.at(-1)[1] }, { method: 'pOsT', redirect: 'manual' });
  };

  await f.edit();
  assert.equal((await f.save()).meta_boxes, 'saved');
});

test('save fetch keeps its receiver and reports a synchronous meta box failure', async () => {
  const f = fixture();
  f.window._wpMetaBoxUrl = '/wp-admin/post.php';
  f.metaBoxBody = 'value=After';
  const receivers = [];
  f.window.fetch = function (input) {
    receivers.push(this);

    if (input === f.window._wpMetaBoxUrl) throw new TypeError('replacement failed');

    return Promise.resolve(new Response());
  };

  f.duringSave = () => f.window.fetch('/wp-json/wp/v2/pages/7', { method: 'GET' });
  await f.edit();
  const result = await f.save();
  assert.equal(result.persistence, 'verified', JSON.stringify(result));
  assert.equal(result.meta_boxes, 'failed');
  assert.equal(receivers.length, 2);

  for (const receiver of receivers) assert.equal(receiver, f.window);
});

test('an accessor fetch that captures assignments keeps its delegate across a save', async () => {
  const f = fixture();
  f.window._wpMetaBoxUrl = '/wp-admin/post.php';
  f.metaBoxBody = 'value=After';
  const sent = [];
  const native = (input, options) => {
    sent.push(options);

    return Promise.resolve({ type: 'opaqueredirect', ok: false });
  };

  // A site plugin's SEOPress schema sync installs this shape: the getter always
  // returns its proxy, and the setter swaps the delegate the proxy calls.
  let delegate = native;
  const proxy = (input, options) => delegate(input, options);
  const get = () => proxy;
  const set = (next) => { delegate = next; };

  Object.defineProperty(f.window, 'fetch', { configurable: true, enumerable: true, get, set });
  await f.edit();
  const result = await f.save();
  assert.equal(result.persistence, 'verified', JSON.stringify(result));
  assert.equal(result.meta_boxes, 'saved');
  assert.equal(sent[0].redirect, 'manual');
  assert.equal(delegate, native);
  const descriptor = Object.getOwnPropertyDescriptor(f.window, 'fetch');
  assert.equal(descriptor.get, get);
  assert.equal(descriptor.set, set);
});

test('a fetch that cannot be swapped back saves natively and reports unobserved', async () => {
  const f = fixture();
  f.window._wpMetaBoxUrl = '/wp-admin/post.php';
  f.metaBoxBody = 'value=After';
  const sent = [];
  const fetch = (input, options) => {
    sent.push(options);

    return Promise.resolve(new Response());
  };

  Object.defineProperty(f.window, 'fetch', { configurable: false, writable: true, value: fetch });
  await f.edit();
  const result = await f.save();
  assert.equal(result.persistence, 'verified', JSON.stringify(result));
  assert.equal(result.meta_boxes, 'unobserved');
  assert.equal(sent[0].redirect, undefined);
  assert.equal(f.window.fetch, fetch);
});

test('a failed meta box POST wins over a later successful POST', async () => {
  const f = fixture();
  f.window._wpMetaBoxUrl = '/wp-admin/post.php';
  f.metaBoxBody = 'value=After';
  let calls = 0;
  f.window.fetch = () => Promise.resolve(new Response(null, { status: calls++ === 0 ? 500 : 200 }));
  f.duringSave = () => f.window.fetch(f.window._wpMetaBoxUrl, { method: 'POST' });
  await f.edit();
  const result = await f.save();
  assert.equal(result.persistence, 'verified');
  assert.equal(result.meta_boxes, 'failed');
});

test('a refused save reports the WordPress error code and stays uncertain', async () => {
  const f = fixture();
  const actions = f.window.wp.data.dispatch('core/editor');
  const editor = f.window.wp.data.select('core/editor');
  await f.edit();
  actions.savePost = async () => { f.saves++; f.saving = true; f.notify(); f.saveError = { code: 'rest_cannot_publish', message: 'secret', data: { status: 403 } }; f.saving = false; f.notify(); };

  editor.didPostSaveRequestSucceed = () => false;
  const result = await f.save();
  assert.deepEqual([result.error, result.persistence, result.next, result.diagnostics?.wordpress_error],
    ['save_uncertain', 'uncertain', 'recover_save_do_not_replay', 'rest_cannot_publish'], JSON.stringify(result));
  assert.ok(result.receipt);
  assert.equal(outsideDebug(result).includes('secret'), false);

  // A pre-save hook, such as ACF's validation, can stop savePost before its
  // request. Nothing was sent, even with an earlier error left in place.
  const stale = fixture();
  await stale.edit();
  stale.window.wp.data.dispatch('core/editor').savePost = async () => { stale.saves++; };

  stale.window.wp.data.select('core/editor').didPostSaveRequestSucceed = () => false;
  stale.saveError = { code: 'rest_cannot_publish', data: { status: 403 } };
  const unsent = await stale.save();
  assert.deepEqual([unsent.error, unsent.persistence, unsent.next, unsent.receipt], ['save_not_sent', 'not_attempted', 'ask_user', undefined], JSON.stringify(unsent));
  assert.ok(unsent.hint);
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

test('a verified save links the latest revision for undo', async () => {
  const f = fixture();
  await f.edit();
  f.post._links = { 'predecessor-version': [{ id: 91, href: 'https://example.test/wp-json/wp/v2/pages/7/revisions/91' }],
    'version-history': [{ count: 3, href: 'https://example.test/wp-json/wp/v2/pages/7/revisions' }] };
  const saved = await f.save();
  assert.deepEqual(copy(saved.revisions), { latest_id: 91, url: 'https://example.test/wp-admin/revision.php?revision=91' }, JSON.stringify(saved));

  const unrevised = fixture();
  await unrevised.edit();
  assert.equal((await unrevised.save()).revisions, null);
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

test('a new post names the default term WordPress gives an empty taxonomy', async () => {
  const setup = (stored) => {
    const f = fixture('post', 'https://example.test/wp-admin/post-new.php?post_type=post');
    Object.assign(f.post, { status: 'auto-draft', categories: [], sticky: false });
    const tax = { slug: 'category', rest_namespace: 'wp/v2', rest_base: 'categories', types: ['post'], hierarchical: true };
    f.api = ({ path }) => path === '/wp/v2/taxonomies?context=edit' ? { category: tax }
      : path.startsWith('/wp/v2/taxonomies/category') ? tax : path.includes('status=any&slug=') ? [] : undefined;
    const actions = f.window.wp.data.dispatch('core/editor');
    const save = actions.savePost;
    actions.savePost = async () => { await save(); Object.assign(f.post, stored); };

    return f;
  };

  const post = { title: 'Post', slug: 'new-post', status: 'draft' };

  for (const settings of [undefined, { taxonomies: { category: [] } }]) {
    const f = setup({ categories: [1] });
    await f.call('connect');
    const plan = await f.call('edit', { post, settings });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    const saved = await f.save();
    assert.equal(saved.persistence, 'applied_with_differences', JSON.stringify(saved));
    assert.deepEqual(copy(saved.diagnostics.fields), ['categories']);
    assert.equal(saved.next, 'inspect_stored_fields');
    assert.match(saved.hint, /default term/);
  }

  // Any other unrequested change still fails verification.
  const other = setup({ categories: [1], sticky: true });
  await other.call('connect');
  assert.equal((await other.call('edit', { post })).ok, true);
  assert.equal((await other.save()).error, 'verification_mismatch');
});

test('an acknowledged filtered metadata save settles persistence with value-free field paths', async () => {
  const f = fixture();
  f.post.meta = { kept: 'Same', note: 'Before' };
  f.schema = { meta: { type: 'object', properties: { kept: { type: 'string' }, note: { type: 'string' } } } };
  const actions = f.window.wp.data.dispatch('core/editor');
  const save = actions.savePost;
  actions.savePost = async () => { await save(); f.post.meta = { ...f.post.meta, note: 'Filtered' }; };

  await f.call('connect');
  await f.call('edit', { settings: { meta: { note: '<strong>After</strong>' } } });
  const result = await f.save();
  assert.equal(result.error, 'stored_with_field_differences', JSON.stringify(result));
  assert.equal(result.outcome, 'stored_with_field_differences');
  assert.equal(result.meta_boxes, 'none');
  assert.equal(result.persistence, 'applied_with_differences');
  assert.deepEqual(copy(result.diagnostics.fields), ['meta.note']);
  assert.equal(result.diagnostics.fields_truncated, false);
  assert.equal(result.next, 'inspect_stored_fields');
  assert.match(result.hint, /Content blocks and every other requested field matched/);
  assert.match(result.hint, /user's intent/);
  assert.match(result.hint, /never replay/i);
  assert.equal(JSON.stringify(result.diagnostics).includes('Filtered'), false);
  const status = await f.call('status');
  assert.equal(status.persistence, 'applied_with_differences');
  assert.equal(status.receipt, undefined);
  assert.equal(status.revert_available, false);
  assert.equal(status.last_request.outcome, 'stored_with_field_differences');
  assert.deepEqual(copy(f.window.__blockwork_editor.requested), {});
  assert.equal(f.window.__blockwork_editor.persisted.meta.note, 'Filtered');
  assert.equal(f.window.__blockwork_editor.baseline.meta.note, 'Filtered');
  assert.equal((await f.call('prepare_save')).persistence, 'unchanged');
  assert.equal((await f.call('release')).persistence, 'applied_with_differences');
  assert.equal(f.saves, 1);
});

test('unrequested custom object and array changes remain verification mismatches', async () => {
  for (const [original, changed, schema] of [
    [{ raw: 'Keep', mode: 'Before' }, { raw: 'Keep', mode: 'After' }, { type: 'object', properties: { raw: { type: 'string' }, mode: { type: 'string' } } }],
    [[2, 1], [1, 2], { type: 'array', items: { type: 'integer' } }],
  ]) {
    const f = fixture();
    f.post.custom = original;
    f.schema = { custom: schema };
    const actions = f.window.wp.data.dispatch('core/editor');
    const save = actions.savePost;
    actions.savePost = async () => { await save(); f.post.custom = changed; };

    await f.call('connect');
    const plan = await f.call('edit', { post: { title: 'Changed title' } });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    const result = await f.save();
    assert.equal(result.error, 'verification_mismatch');
    assert.equal(result.diagnostics.meta_boxes, 'none');
    assert.equal(result.persistence, 'uncertain');
    assert.deepEqual(copy(result.diagnostics.fields), ['custom']);
    assert.equal(f.saves, 1);
  }
});

test('a lost settings save cannot adopt or overwrite a foreign metadata change', async () => {
  for (const extra of [{}, Object.fromEntries(Array.from({ length: 63 }, (_, index) => [`key_${index}`, 'Same'])), { 'https://private.example/value': 'Private' }]) {
    const f = fixture();
    f.post.meta = { note: 'Before', kept: 'Original', ...extra };
    f.loadedPost = copy(f.post);
    f.schema = { meta: { type: 'object', properties: Object.fromEntries(Object.keys(f.post.meta).map((key) => [key, { type: 'string' }])) } };
    await f.call('connect');
    assert.equal((await f.call('edit', { settings: { meta: { note: 'Requested' } } })).ok, true);
    const prepared = await f.call('prepare_save');
    f.window.wp.data.dispatch('core/editor').savePost = async () => { f.saves++; throw new Error('connection-lost'); };

    const lost = await f.call('save', { receipt: prepared.receipt });
    assert.equal(lost.persistence, 'uncertain');
    f.post.meta.kept = 'Foreign work';
    const recovered = await f.call('recover', { target: { site_url: target.site_url, user_id: 5 }, receipt: prepared.receipt });
    assert.equal(recovered.error, 'saved_record_different', JSON.stringify(recovered));
    assert.equal(recovered.persistence, 'different');
    assert.equal((await f.call('connect')).error, 'saved_record_changed');
    assert.equal(f.window.__blockwork_editor.baseline.meta.kept, 'Original');
    assert.equal((await f.save()).error, 'save_unresolved');
    assert.equal(f.saves, 1);
    assert.equal(f.post.meta.kept, 'Foreign work');
    assert.equal(f.postEdits.meta.kept, 'Original');
  }
});

test('save verification refuses a foreign field even when a requested field was stored differently', async () => {
  for (const extra of [{}, Object.fromEntries(Array.from({ length: 63 }, (_, index) => [`key_${index}`, 'Same'])), { 'https://private.example/value': 'Private' }]) {
    const f = fixture();
    f.post.meta = { note: 'Before', kept: 'Original', ...extra };
    f.schema = { meta: { type: 'object', properties: Object.fromEntries(Object.keys(f.post.meta).map((key) => [key, { type: 'string' }])) } };
    const actions = f.window.wp.data.dispatch('core/editor');
    const save = actions.savePost;
    actions.savePost = async () => { await save(); f.post.meta = { ...f.post.meta, note: 'Filtered', kept: 'Foreign work' }; };

    await f.call('connect');
    await f.call('edit', { settings: { meta: { note: 'Requested' } } });
    const saved = await f.save();
    assert.equal(saved.error, 'verification_mismatch', JSON.stringify(saved));
    assert.equal(saved.persistence, 'uncertain');
    const recovered = await f.call('recover', { target: { site_url: target.site_url, user_id: 5 }, receipt: saved.receipt });
    assert.equal(recovered.error, 'saved_record_different', JSON.stringify(recovered));
  }
});

test('a requested field still at its original value does not qualify as applied with differences', async () => {
  const f = fixture();
  f.post.meta = { note: 'Before' };
  const actions = f.window.wp.data.dispatch('core/editor');
  const save = actions.savePost;
  actions.savePost = async () => { await save(); f.post.meta.note = 'Before'; };

  await f.edit();
  await f.call('edit', { settings: { meta: { note: 'Requested' } } });
  const saved = await f.save();
  assert.equal(saved.error, 'verification_mismatch', JSON.stringify(saved));
  assert.equal(saved.persistence, 'uncertain');
  const recovered = await f.call('recover', { target: { site_url: target.site_url, user_id: 5 }, receipt: saved.receipt });
  assert.equal(recovered.error, 'saved_record_different', JSON.stringify(recovered));
  assert.equal((await f.call('connect')).error, 'saved_record_changed');
});

test('live save compares requested dates with the record read at preparation', async () => {
  const f = fixture();
  f.post.date_gmt = '2026-10-01T12:00:00';
  await f.edit();
  const edited = await f.call('edit', { post: { status: 'future', date_gmt: '2099-01-01T12:00:00' } });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const originalDate = '2026-10-02T12:00:00';
  f.post.date_gmt = originalDate;
  const actions = f.window.wp.data.dispatch('core/editor');
  const save = actions.savePost;
  actions.savePost = async () => { await save(); f.post.date_gmt = originalDate; };

  const saved = await f.save();
  assert.equal(saved.error, 'verification_mismatch', JSON.stringify(saved));
  assert.deepEqual(copy(saved.diagnostics.fields), ['date_gmt']);
  assert.equal(saved.persistence, 'uncertain');
});

test('lost filtered saves keep the old recovery outcomes and uncertain session', async () => {
  for (const reserialized of [false, true]) {
    const f = fixture();
    f.post.meta = { note: 'Before' };
    f.blocks[1].attributes.layout = {};
    f.syncContent();
    const actions = f.window.wp.data.dispatch('core/editor');
    const save = actions.savePost;
    actions.savePost = async () => {
      await save();
      f.post.meta.note = 'Stored answer';

      if (reserialized) f.post.content.raw = f.post.content.raw.replaceAll('{}', '[]');
      throw new Error('connection-lost');
    };

    await f.edit();
    await f.call('edit', { settings: { meta: { note: '<strong>Requested answer</strong>' } } });
    const lost = await f.save();
    assert.equal(lost.persistence, 'uncertain', JSON.stringify(lost));
    const request = { target: { site_url: target.site_url, user_id: 5 }, receipt: lost.receipt };
    const parse = f.window.wp.blocks.parse;
    f.window.wp.blocks.parse = undefined;
    const withoutParser = await f.call('recover', request);
    assert.equal(withoutParser.error, 'saved_record_different', JSON.stringify(withoutParser));
    f.window.wp.blocks.parse = parse;
    const recovered = await f.call('recover', request);
    assert.equal(recovered.error, 'saved_record_different', JSON.stringify(recovered));
    assert.equal(recovered.outcome, 'different');
    assert.equal(recovered.persistence, 'different');
    assert.equal((await f.call('status')).persistence, 'uncertain');
    assert.equal((await f.call('release')).persistence, 'uncertain');
    // Recovery stays conservative in a fresh wp-admin caller.
    const fresh = await f.call('recover', request);
    assert.equal(fresh.error, recovered.error, JSON.stringify(fresh));
    assert.deepEqual(copy(fresh.diagnostics), copy(recovered.diagnostics));
    assert.equal(f.saves, 1);
  }
});

test('requested metadata diagnostics stay bounded and omit values', async () => {
  const f = fixture();
  const keys = Array.from({ length: 25 }, (_, index) => `key_${index}`);
  f.post.meta = Object.fromEntries(keys.map((key) => [key, 'Private before']));
  f.schema = { meta: { type: 'object', properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])) } };
  const actions = f.window.wp.data.dispatch('core/editor');
  const save = actions.savePost;
  actions.savePost = async () => { await save(); f.post.meta = Object.fromEntries(keys.map((key) => [key, 'Private stored'])); };

  await f.call('connect');
  await f.call('edit', { settings: { meta: Object.fromEntries(keys.map((key) => [key, 'Private requested'])) } });
  const saved = await f.save();
  assert.equal(saved.error, 'stored_with_field_differences', JSON.stringify(saved));
  assert.equal(saved.diagnostics.fields.length, 20);
  assert.equal(saved.diagnostics.fields_truncated, true);
  assert.ok(saved.diagnostics.fields.every((path) => path.startsWith('meta.key_')));
  assert.equal(JSON.stringify(saved.receipt).includes('Private'), false);
  assert.equal(JSON.stringify(saved.diagnostics).includes('Private'), false);
});

test('an unchanged original record is not classified as an applied save with field differences', async () => {
  const f = fixture();
  await f.call('connect');
  await f.call('edit', { post: { title: 'Requested' } });
  const prepared = await f.call('prepare_save');
  const recovered = await f.call('recover', { target: { site_url: target.site_url, user_id: 5 }, receipt: prepared.receipt });
  assert.equal(recovered.error, 'save_not_applied', JSON.stringify(recovered));
  assert.equal(recovered.outcome, 'unchanged_original');
  assert.equal(f.saves, 0);
  f.window.wp.data.dispatch('core/editor').savePost = async () => { f.saves++; f.saving = true; f.notify(); f.saving = false; f.notify(); };

  const saved = await f.call('save', { receipt: prepared.receipt });
  assert.equal(saved.error, 'verification_mismatch', JSON.stringify(saved));
  assert.equal(saved.persistence, 'uncertain');
  assert.equal(f.saves, 1);
});

test('wide metadata and non-identifier keys use full values and sanitized save diagnostics', async () => {
  for (const key of ['note', 'https://private.example/value']) {
    const f = fixture();
    f.post.meta = { kept: 'Original', ...Object.fromEntries(Array.from({ length: 63 }, (_, index) => [`key_${index}`, 'Same'])), [key]: 'Before' };
    f.schema = { meta: { type: 'object', properties: Object.fromEntries(Object.keys(f.post.meta).map((name) => [name, { type: 'string' }])) } };
    const actions = f.window.wp.data.dispatch('core/editor');
    const save = actions.savePost;
    actions.savePost = async () => { await save(); f.post.meta[key] = 'Filtered'; };

    await f.call('connect');
    await f.call('edit', { settings: { meta: { [key]: 'Requested' } } });
    const saved = await f.save();
    assert.equal(saved.error, 'stored_with_field_differences', JSON.stringify(saved));
    assert.deepEqual(copy(saved.diagnostics.fields), [key === 'note' ? 'meta.note' : 'meta.<key>']);
    assert.equal(JSON.stringify(saved.diagnostics).includes('private.example'), false);
    assert.equal(saved.diagnostics.fields_truncated, false);
    assert.equal((await f.call('status')).receipt, undefined);
  }
});

test('a foreign difference beyond the diagnostic limit still refuses the live save', async () => {
  const f = fixture();
  const keys = Array.from({ length: 25 }, (_, index) => `key_${index}`);
  f.post.meta = { ...Object.fromEntries(keys.map((key) => [key, 'Before'])), kept: 'Original' };
  f.schema = { meta: { type: 'object', properties: Object.fromEntries(Object.keys(f.post.meta).map((key) => [key, { type: 'string' }])) } };
  const actions = f.window.wp.data.dispatch('core/editor');
  const save = actions.savePost;
  actions.savePost = async () => { await save(); f.post.meta = { ...Object.fromEntries(keys.map((key) => [key, 'Filtered'])), kept: 'Foreign work' }; };

  await f.call('connect');
  await f.call('edit', { settings: { meta: Object.fromEntries(keys.map((key) => [key, 'Requested'])) } });
  const saved = await f.save();
  assert.equal(saved.error, 'verification_mismatch', JSON.stringify(saved));
  assert.equal(saved.diagnostics.fields.length, 20);
  assert.equal(saved.persistence, 'uncertain');
});

test('only discovered taxonomy assignment arrays ignore native term order', async () => {
  const f = fixture('book');
  f.post.topics = [2, 1];
  f.schema = { topics: { type: 'array', items: { type: 'integer' } } };
  const tax = { slug: 'topic', rest_namespace: 'custom/v1', rest_base: 'topics', types: ['book'] };
  f.api = ({ path }) => path === '/wp/v2/taxonomies?context=edit' ? { topic: tax } : undefined;
  const actions = f.window.wp.data.dispatch('core/editor');
  const save = actions.savePost;
  actions.savePost = async () => { await save(); f.post.topics = [1, 2]; };

  await f.call('connect');
  const plan = await f.call('edit', { post: { title: 'Changed title' } });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await f.save()).persistence, 'verified');
});

test('a template change blocks later structural edits and requires reopening after save', async () => {
  const other = fixture();
  await other.call('connect');
  // Core builds no editor settings from these fields.
  const settled = await other.call('edit', { settings: { featured_media: 0, meta: { note: 'x' } } });
  assert.equal(settled.ok, true, JSON.stringify(settled));
  assert.equal((await other.call('edit', { edits: [{ op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'New' } } }] })).ok, true);

  const f = fixture();
  await f.call('connect');
  assert.equal((await f.call('edit', { post: { template: 'landing' } })).ok, true);
  const edits = [{ op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'New' } } }];
  const refused = await f.call('edit', { edits });
  assert.equal(refused.error, 'settings_before_structure');
  assert.deepEqual(copy(refused.diagnostics.fields), ['template']);
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal((await f.call('edit', { edits })).error, 'reopen_required');
  await f.call('release');
  // Reopening loads a fresh editor page; a released background tab refuses.
  assert.equal((await f.call('connect')).error, 'document_released');
  delete f.window.__blockwork_release;
  await f.call('connect');
  assert.equal((await f.call('edit', { edits })).ok, true);
});

test('native auto-draft creation requires explicit identity and status before saving', async () => {
  const f = fixture('book', 'https://example.test/wp-admin/post-new.php?post_type=book');
  f.post.status = 'auto-draft';
  f.api = ({ path }) => path.includes('status=any&slug=') ? [] : undefined;
  await f.call('connect');
  const incomplete = await f.call('edit', { post: { title: 'Book' } });
  assert.equal(incomplete.error, 'creation_fields_required');
  const plan = await f.call('edit', { post: { title: 'Book', slug: 'new-book', status: 'draft' } });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(f.post.status, 'draft');
  assert.equal(f.saves, 1);
});

test('explicit scheduling verifies the requested GMT date rather than ignoring date changes', async () => {
  const f = fixture();
  await f.call('connect');
  const refused = await f.call('edit', { post: { status: 'future' } });
  assert.equal(refused.error, 'future_date_required');
  const invalidDate = await f.call('edit', { post: { status: 'future', date_gmt: '2099-02-31T12:00:00' } });
  assert.equal(invalidDate.ok, false);
  const plan = await f.call('edit', { post: { status: 'future', date_gmt: '2099-01-01T12:00:00' } });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await f.save()).persistence, 'verified');
});

test('the shapes agents reach for first are accepted', async () => {
  const f = fixture();
  const { blocks } = await f.call('connect');
  const client_id = blocks[0].client_id;
  const tree = await f.call('read', { blocks: { depth: 1 } });
  assert.equal(tree.ok, true, JSON.stringify(tree));
  assert.ok(tree.blocks.length > 0 && tree.blocks.every((block) => block.path.length === 1 && block.attributes));
  assert.equal((await f.call('read', { blocks: { depth: 1, markup: true } })).error, 'invalid_read');
  assert.equal((await f.call('measure', { client_id, blocks: [client_id] })).error, 'invalid_measure');
  assert.notEqual((await f.call('measure', { client_id })).error, 'invalid_measure');
  const unset = await f.call('edit', { edits: [{ op: 'update', client_id: blocks[1].client_id, unset: ['variant'] }] });
  assert.equal(unset.ok, true, JSON.stringify(unset));
});

test('a guessed field name gets its replacement in the main hint', async () => {
  const f = fixture();
  const { blocks } = await f.call('connect');
  const guessed = await f.call('edit', { edits: [{ op: 'update', client_id: blocks[0].client_id, attribute: { content: 'x' } }] });
  assert.equal(guessed.error, 'invalid_edit', JSON.stringify(guessed));
  assert.match(guessed.hint, /attribute is attributes/);
  assert.match(guessed.issues[0].hint, /Use attributes, not attribute/);
});

test('a less-than sign that opens no tag stays in the text', async () => {
  for (const [text, stored] of [
    ['if a<b then c', 'if a&lt;b then c'],
    ['1 < 2', '1 &lt; 2'],
    ['<strong>Bold</strong>', '<strong>Bold</strong>'],
    ['<a title="x>y" href="/z">Link</a>', '<a title="x>y" href="/z">Link</a>'],
    ['for (i=0;i<n;i++) a->b', 'for (i=0;i&lt;n;i++) a->b'],
    ['Line<br/>two <!-- it\'s --> end', 'Line<br/>two <!-- it\'s --> end'],
    ['Note <!-- x < y --> end', 'Note <!-- x &lt; y --> end'],
    ['Note <!-- x > y', 'Note &lt;!-- x > y'],
  ]) {
    const f = fixture();
    const { blocks } = await f.call('connect');
    const result = await f.call('edit', { edits: [{ op: 'update', client_id: blocks[0].client_id, attributes: { content: text } }] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.blocks[0].attributes.content, stored);
  }
});

test('a single-use block refuses a second copy, and a replace of itself passes', async () => {
  const f = fixture();
  f.registrations['example/card'].supports = { multiple: false };
  const { blocks } = await f.call('connect');
  const card = blocks.find((block) => block.name === 'example/card');
  const refused = await f.call('edit', { edits: [{ op: 'insert', block: { name: 'example/card' } }] });
  assert.equal(refused.error, 'insertion_refused', JSON.stringify(refused));
  assert.equal(refused.diagnostics.constraint, 'single_use_block');
  const replaced = await f.call('edit', { edits: [{ op: 'replace', client_id: card.client_id, block: { name: 'example/card', attributes: { variant: 'other' } } }] });
  assert.notEqual(replaced.error, 'insertion_refused', JSON.stringify(replaced));
});

test('an explicit unlock on the nearest group lifts an outer lock, but not contentOnly', async () => {
  for (const [outer, allowed] of [['all', true], ['insert', true], ['contentOnly', false]]) {
    const f = fixture();
    f.registrations['core/group'] ??= { name: 'core/group', attributes: {} };
    f.registrations['core/group'].attributes = { ...f.registrations['core/group'].attributes, templateLock: { type: ['string', 'boolean'] } };
    f.blocks = [{ name: 'core/group', clientId: 'outer', isValid: true, attributes: { templateLock: outer }, innerBlocks: [
      { name: 'core/group', clientId: 'inner', isValid: true, attributes: { templateLock: false }, innerBlocks: [] },
    ] }];
    f.syncContent();
    await f.call('connect');
    const result = await f.call('edit', { edits: [{ op: 'insert', parent_client_id: 'inner', block: { name: 'core/paragraph', attributes: { content: 'x' } } }] });
    assert.notEqual(result.error === 'template_locked', allowed, JSON.stringify(result));
  }
});

test('a new block with a literal greater-than matches its parsed spelling', async () => {
  const f = fixture();
  await f.call('connect');
  const result = await f.call('edit', { edits: [{ op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'a > b' } } }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const found = await f.call('read', { blocks: { search: 'a > b' } });
  assert.equal(found.selection.total, 1, JSON.stringify(found));
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

test('a new document refuses a slug claimed after preparation', async () => {
  const f = fixture('book', 'https://example.test/wp-admin/post-new.php?post_type=book');
  f.post.status = 'auto-draft';
  let duplicates = [];
  f.api = ({ path }) => path.includes('status=any&slug=') ? duplicates : undefined;
  await f.call('connect');
  const plan = await f.call('edit', { post: { title: 'Book', slug: 'new-book', status: 'draft' } });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  duplicates = [{ id: 99, slug: 'new-book' }];
  assert.equal((await f.save()).error, 'slug_already_exists');
  assert.equal(f.saves, 0);
});

test('taxonomy keys cannot disappear during request validation', async () => {
  const f = fixture();
  await f.call('connect');
  const settings = JSON.parse('{"taxonomies":{"__proto__":[11]}}');
  const plan = await f.call('edit', { post: { title: 'Requested' }, settings });
  assert.equal(plan.ok, false);
  assert.equal(f.saves, 0);
});

test('taxonomy assignments validate native terms and preserve unordered IDs through save', async () => {
  const f = fixture('book');
  f.post.topics = []; f.schema = { topics: { type: 'array', items: { type: 'integer' } } };
  const taxonomy = { slug: 'topic', rest_namespace: 'custom/v1', rest_base: 'topics', types: ['book'], hierarchical: false };
  f.api = ({ path }) => path.startsWith('/wp/v2/taxonomies/topic') ? taxonomy : path.startsWith('/custom/v1/topics/11') ? { id: 11, taxonomy: 'topic', name: 'Topic' } : undefined;
  await f.call('connect');
  assert.equal((await f.call('edit', { settings: { taxonomies: { topic: [11] } } })).ok, true);
  assert.equal((await f.save()).persistence, 'verified');
  assert.deepEqual(f.post.topics, [11]);
});

test('media bindings refuse stale tokens before editing and use native file URLs', async () => {
  const f = fixture();
  f.registrations['core/file'] = { name: 'core/file', attributes: { id: { type: 'integer' }, href: { type: 'string' } } };
  f.blocks = [{ name: 'core/file', attributes: {}, clientId: 'file', isValid: true, innerBlocks: [] }]; f.syncContent();
  const media = { id: 20, media_type: 'file', mime_type: 'application/pdf', source_url: 'https://example.test/file.pdf', media_details: {}, alt_text: '' };
  f.api = ({ path }) => path.startsWith('/wp/v2/media/20') ? media : undefined;
  const attachment = await f.call('inspect_media', { target: { site_url: target.site_url, user_id: 5 }, id: 20 });
  await f.call('connect');
  const request = { media_bindings: [{ path: [0], name: 'core/file', media_id: 20, media_token: attachment.record.edit_token, bind: { id: 'id', url: 'href' } }] };
  media.source_url = 'https://example.test/replaced.pdf';
  assert.equal((await f.call('edit', request)).error, 'stale_media');
  assert.deepEqual(f.blocks[0].attributes, {});
  media.source_url = 'https://example.test/file.pdf';
  assert.equal((await f.call('edit', request)).ok, true);
  assert.deepEqual(copy(f.blocks[0].attributes), { id: 20, href: media.source_url });
  media.source_url = 'https://example.test/changed-before-save.pdf';
  assert.equal((await f.save()).error, 'stale_reference');
  assert.equal(f.saves, 0);
  media.source_url = 'https://example.test/file.pdf';
  assert.equal((await f.save()).persistence, 'verified');
});

test('core post-meta bindings check native context and permissions, then save only the backing field', async () => {
  const f = fixture();
  f.registrations['core/paragraph'].attributes.metadata = { type: 'object' };
  f.blocks[0].attributes.metadata = { bindings: { content: { source: 'core/post-meta', args: { key: 'note' } } } };
  f.post.meta = { note: 'Original field' };
  f.syncContent();
  f.resolveCanUser = (action, resource) => action === 'update' && resource.kind === 'postType';
  f.window.wp.blocks.getBlockBindingsSource = () => ({ canUserEditValue: ({ context }) =>
    context.postId === target.post_id && context.postType === target.post_type });
  const original = f.post.content.raw;
  await f.call('connect');

  const plan = await f.call('edit', { binding_writes: [{ path: [0], name: 'core/paragraph', attribute: 'content', value: 'Updated field' }] });

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.post.meta.note, 'Updated field');
  assert.equal(f.post.content.raw, original);
});

test('a binding inside a query cannot write the edited post metadata', async () => {
  const f = fixture();
  f.registrations['core/paragraph'].attributes.metadata = { type: 'object' };
  f.blocks[0].attributes.metadata = { bindings: { content: { source: 'core/post-meta', args: { key: 'note' } } } };
  f.post.meta = { note: 'Original field' };
  f.syncContent();
  f.registrations['core/group'].providesContext = { queryId: 'queryId' };
  f.blocks = [{ name: 'core/group', attributes: {}, clientId: 'query-context', innerBlocks: f.blocks }];
  f.syncContent();
  f.resolveCanUser = () => true;
  f.window.wp.blocks.getBlockBindingsSource = () => ({ canUserEditValue: () => true });
  await f.call('connect');

  const plan = await f.call('edit', { binding_writes: [{ path: [0, 0], name: 'core/paragraph', attribute: 'content', value: 'No' }] });

  assert.equal(plan.error, 'binding_context_unavailable');
  assert.equal(f.saves, 0);
});

for (const post_type of ['post', 'page']) {
  test(`edits a ${post_type} while preserving its publication status`, async () => {
    for (const status of ['draft', 'publish', 'private', 'pending', 'future', 'custom-review']) {
      const f = fixture(post_type);
      f.post.status = status;
      const plan = await f.edit();
      assert.equal(plan.ok, true, JSON.stringify(plan));
      const saved = await f.save();
      assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
      assert.equal(f.post.status, status);
      assert.equal(JSON.parse(f.post.content.raw.split('\n\n')[0]).attributes.content, 'After');
      assert.equal(f.saves, 1);
    }
  });
}

test('REST GET fixture selects top-level, nested and link fields with parent precedence', async () => {
  const f = fixture();
  f.post.content = { ...f.post.content, rendered: 'Rendered', protected: true, block_version: 1 };
  f.post._links = { 'predecessor-version': [{ id: 91 }] };
  const get = (fields) => f.window.wp.apiFetch({ path: `/wp/v2/pages/7?context=edit&_fields=${fields}` });
  assert.deepEqual(await get('id,content.raw,_links'), { id: 7, content: { raw: f.post.content.raw }, _links: f.post._links });
  assert.deepEqual(await get('content.raw,content'), { content: f.post.content });
  assert.deepEqual(await get('content,content.raw'), { content: f.post.content });
  Object.assign(f.post, { 'plugin.setting': 'Literal', plugin: { setting: 'Nested', other: 'Kept' } });
  assert.deepEqual(await get('plugin.setting'), { plugin: { setting: 'Nested' } });
  f.api = () => [f.post];
  assert.deepEqual(await get('id,content.raw'), [{ id: 7, content: { raw: f.post.content.raw } }]);
});

test('document connect, preparation, verification and recovery select schema fields and preserve full-record hashes', async () => {
  for (const [type, identity] of [['post', 7], ['page', 7], ['book', 7], ['wp_block', 7], ['wp_navigation', 7], ['wp_template', 'theme//test'], ['wp_template_part', 'theme//part']]) {
    const results = [];

    for (const full of [false, true]) {
      const shared = type.startsWith('wp_');
      const f = shared ? sharedFixture(type, identity) : fixture(type);

      if (type === 'wp_block') f.post.wp_pattern_sync_status = '';
      f.post.content = { ...f.post.content, rendered: 'Rendered content', protected: false, block_version: 1 };
      f.post.title.rendered = 'Rendered title';
      f.post.excerpt.rendered = 'Rendered excerpt';
      Object.assign(f.post, { link: 'https://example.test/example/', modified: 'local before', permalink_template: '/%pagename%/', generated_slug: 'example',
        _links: { 'predecessor-version': [{ id: 91 }] }, custom: { value: 'Kept' } });
      f.schema = { custom: { type: 'object', properties: { value: { type: 'string' } } } };

      if (full) {
        const fetch = f.window.wp.apiFetch;
        f.window.wp.apiFetch = (options) => {
          const url = new URL(options.path, target.site_url);

          // Simulate the former full-record document reads, leaving discovery alone.
          if (url.searchParams.get('context') === 'edit' && url.searchParams.has('_fields')) {
            url.searchParams.delete('_fields');

            return fetch({ ...options, path: url.pathname + url.search });
          }

          return fetch(options);
        };
      }

      const connected = await f.call('connect');
      assert.equal(connected.ok, true, JSON.stringify(connected));
      const session = f.window.__blockwork_editor;
      const baseline = copy(session.baseline);

      if (type === 'wp_block') assert.equal(session.persisted.wp_pattern_sync_status, '');
      assert.deepEqual(copy(session.persisted.content), full ? f.post.content : { raw: f.post.content.raw });
      const scope = shared ? (type === 'wp_block' ? 'all_references' : 'site_wide') : undefined;
      assert.equal((await f.call('edit', { edits: changes, scope })).ok, true);
      const prepared = await f.call('prepare_save');
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      const saved = await f.call('save', { receipt: prepared.receipt });
      assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
      const reads = f.requests.filter(({ path, method }) => method === 'GET' && path.startsWith(`${session.schema.collection}/${identity}?`));
      assert.equal(reads.length, 4, type);
      const recovered = await f.call('recover', { target: { site_url: target.site_url, user_id: 5 }, receipt: prepared.receipt });
      assert.equal(recovered.persistence, 'verified', JSON.stringify(recovered));

      if (!full) {
        const expected = Object.keys(session.schema.properties).map((key) => key === 'content' ? 'content.raw' : key);

        if (type === 'wp_block') expected.push('wp_pattern_sync_status');
        expected.push('_links');
        const recoveryRead = f.requests.at(-1);

        for (const { path } of [...reads, recoveryRead]) {
          const fields = new URL(path, target.site_url).searchParams.get('_fields').split(',');
          assert.deepEqual(fields, expected);
          assert.equal(fields.includes('content'), false);
          assert.equal(fields.includes('content.rendered'), false);
        }
      }

      results.push({ baseline, hashes: Object.fromEntries(Object.entries(prepared.receipt).filter(([name]) => name.endsWith('_hash'))),
        link: saved.link, revisions: copy(saved.revisions), stored: copy(session.baseline) });
    }

    assert.deepEqual(results[0], results[1], type);
  }
});

test('dotted schema property names keep all document reads full-shaped', async () => {
  const f = fixture();
  f.post['plugin.setting'] = 'Literal';
  f.post.content.rendered = 'Rendered';
  f.schema = { 'plugin.setting': { type: 'string' } };
  const connected = await f.call('connect');
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.equal(f.window.__blockwork_editor.persisted.content.rendered, 'Rendered');
  assert.equal(f.window.__blockwork_editor.baseline['plugin.setting'], 'Literal');
  assert.equal((await f.edit()).ok, true);
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  const recovered = await f.call('recover', { target: { site_url: target.site_url, user_id: 5 }, receipt: saved.receipt });
  assert.equal(recovered.persistence, 'verified', JSON.stringify(recovered));
  const reads = f.requests.filter(({ path, method }) => method === 'GET' && path.startsWith('/wp/v2/pages/7?'));
  assert.equal(reads.length, 5);

  for (const { path } of reads) assert.equal(new URL(path, target.site_url).searchParams.has('_fields'), false);
});

test('schema-less baseline fields survive connect, full-shape receipt verification and recovery', async () => {
  const f = fixture('book');
  f.post.menu_order = 7;
  const fetch = f.window.wp.apiFetch;
  let full = false;
  f.window.wp.apiFetch = async (options) => {
    const path = full ? options.path.replace(/&_fields=[^&]*/, '') : options.path;
    const response = await fetch({ ...options, path });

    if (options.method === 'OPTIONS') {
      delete response.schema.properties.menu_order;

      for (const endpoint of response.endpoints) delete endpoint.args.menu_order;
    }

    return response;
  };

  const connected = await f.call('connect');
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.equal(f.window.__blockwork_editor.baseline.menu_order, 7);
  assert.equal((await f.edit()).ok, true);
  full = true;
  const prepared = await f.call('prepare_save');
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  full = false;
  const saved = await f.call('save', { receipt: prepared.receipt });
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  const recovered = await f.call('recover', { target: { site_url: target.site_url, user_id: 5 }, receipt: prepared.receipt });
  assert.equal(recovered.persistence, 'verified', JSON.stringify(recovered));
  assert.equal(f.window.__blockwork_editor.baseline.menu_order, 7);
});

test('document field selection preserves the preview currentness token of a full record', async () => {
  const tokens = [];

  for (const full of [false, true]) {
    const f = fixture();
    Object.assign(f.post.content, { rendered: 'Rendered', protected: true, block_version: 1 });
    f.post.modified = 'local before';

    if (full) {
      const fetch = f.window.wp.apiFetch;
      f.window.wp.apiFetch = (options) => fetch({ ...options, path: options.path.replace(/&_fields=[^&]*/, '') });
    }

    const connected = await f.call('connect', { workflow: 'attached', unsaved_preview: true });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    tokens.push(f.window.__blockwork_editor.preview.saved_token);
    assert.equal((await f.call('release')).ok, true);
  }

  assert.match(tokens[0], /^[a-f0-9]{64}$/);
  assert.equal(tokens[0], tokens[1]);
});

test('document reads retain the undeclared core pattern sync status for validation', async () => {
  for (const connected of [false, true]) {
    const f = sharedFixture();

    if (connected) assert.equal((await f.call('connect')).ok, true);
    f.post.wp_pattern_sync_status = 'unsynced';
    const refused = await f.call(connected ? 'prepare_save' : 'connect');
    assert.equal(refused.error, 'pattern_not_synced');
    assert.equal(f.saves, 0);
  }
});

test('save refuses a stored change after preparation without calling savePost', async () => {
  for (const [field, change] of [
    ['content', f => { f.post.content.raw = 'Other writer'; }],
    ['meta', f => { f.post.meta = { other: 'Other writer' }; }],
    ['modified', f => { f.post.modified = '2026-11-09T12:00:01'; }],
  ]) {
    const f = fixture();
    await f.edit();
    assert.equal((await f.save()).persistence, 'verified');
    f.saves = 0;
    assert.equal((await f.edit([{ ...changes[0], attributes: { content: 'Next edit' } }])).ok, true);
    const prepared = await f.call('prepare_save');
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    change(f);
    const stored = structuredClone(f.post);
    const result = await f.call('save', { receipt: prepared.receipt });
    assert.equal(result.error, 'saved_record_changed', JSON.stringify(result));
    assert.equal(result.persistence, 'not_attempted');
    assert.equal(result.diagnostics.stage, 'before_save');
    assert.equal(result.diagnostics.post_id, 7);
    assert.equal(result.diagnostics.saved_token_changed, true);

    if (field !== 'modified') assert.ok(result.diagnostics.fields.some(name => name.startsWith(field)));
    assert.match(result.hint, /overwrite saved changes/);
    assert.match(result.hint, /fresh editor/);
    assert.ok(result.next);
    assert.equal(f.saves, 0);
    assert.deepEqual(f.post, stored);
    const status = await f.call('status');
    assert.equal(status.last_request.outcome, 'failed');
    assert.equal(f.window.__blockwork_editor.save.attempted, false);
  }
});

test('save rechecks the draft and native lock after the stored-record read', async () => {
  for (const [change, error] of [
    [f => { f.blocks[0].attributes.content = 'Human typing'; }, 'intervening_editor_change'],
    [f => { f.locked = true; }, 'post_locked'],
  ]) {
    const f = fixture();
    await f.edit();
    const prepared = await f.call('prepare_save');
    f.api = ({ path }) => { if (path.startsWith('/wp/v2/pages/7?')) change(f); };

    const result = await f.call('save', { receipt: prepared.receipt });
    assert.equal(result.error, error, JSON.stringify(result));
    assert.equal(result.persistence, 'not_attempted');
    assert.equal(f.saves, 0);
  }
});

test('save starts the background pulse before its reads finish', async () => {
  const f = fixture();
  assert.equal((await f.edit()).ok, true);
  const pulses = f.pulses;
  let finishRead;
  const held = new Promise((resolve) => { finishRead = resolve; });
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  f.api = async ({ path }) => {
    if (path.startsWith('/wp/v2/pages/7?')) {
      readStarted();
      await held;
    }
  };

  const preparing = f.call('prepare_save');
  await started;
  assert.equal(f.pulses, pulses + 1);
  assert.equal(f.saves, 0);
  finishRead();
  assert.equal((await preparing).ok, true);
});

test('an abandoned save pulse cannot remove the next preparation lock handler', async () => {
  const f = fixture();
  assert.equal((await f.edit()).ok, true);
  let started;
  const secondPulse = new Promise((resolve) => { started = resolve; });
  let pulses = 0;
  f.window.wp.heartbeat.connectNow = () => { if (++pulses === 2) started(); };

  f.api = ({ path }) => { if (path.startsWith('/wp/v2/pages/7?')) throw new Error('read failed'); };

  assert.equal((await f.call('prepare_save')).error, 'operation_failed');
  f.api = undefined;
  const preparing = f.call('prepare_save');
  await secondPulse;
  f.window.wp.hooks.emit('heartbeat.tick', { 'wp-refresh-post-lock': { new_lock: '101:5' } });
  const result = await preparing;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.saves, 0);
});

test('save read failure wins over a simultaneous or later pulse failure without an unhandled rejection', async () => {
  for (const delayed of [false, true]) {
    const f = fixture();
    assert.equal((await f.edit()).ok, true);
    const pulse = f.window.wp.heartbeat.connectNow;
    f.takeover = true;

    if (delayed) f.window.wp.heartbeat.connectNow = () => {};

    f.api = ({ path }) => {
      if (path.startsWith('/wp/v2/pages/7?')) throw new Error('read failed');
    };

    const result = await f.call('prepare_save');
    assert.equal(result.error, 'operation_failed');

    if (delayed) pulse();
    // The test runner fails on an unhandled rejection, including after return.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.saves, 0);
  }
});

for (const [name, mutate, expected] of [
  ['changed persisted content', (f) => { f.post.content.raw = 'changed'; }, 'saved_record_changed'],
  ['changed settings', (f) => { f.post.meta = { a: 1 }; }, 'saved_record_changed'],
  ['changed publication status', (f) => { f.post.status = 'publish'; }, 'saved_record_changed'],
  ['unsaved publication status', (f) => { f.postEdits = { status: 'publish' }; }, 'unexpected_editor_change'],
  ['unsaved user work', (f) => { f.blocks[2].attributes.content = 'Human typing'; f.dirty = true; }, 'unexpected_editor_change'],
  ['other user lock', (f) => { f.locked = true; }, 'post_locked'],
  ['takeover on heartbeat', (f) => { f.takeover = true; }, 'post_locked'],
  ['changed signed-in user', (f) => { f.user_id = 8; }, 'user_mismatch'],
  ['revoked session', (f) => { f.auth = false; }, 'reauthorization_required'],
]) {
  test(`save refuses ${name}`, async () => {
    const f = fixture();
    await f.edit();
    f.loadedPost = copy(f.post);
    mutate(f);
    const result = await f.save();
    assert.equal(result.error, expected, JSON.stringify(result));
    assert.equal(f.saves, 0);
  });
}

for (const [name, edits, expected] of [
  ['wrong name', [{ ...changes[0], name: 'example/card' }], 'block_mismatch'],
  ['negative index', [{ ...changes[0], path: [-1] }], 'invalid_edit'],
  ['invalid enum', [{ path: [1], name: 'example/card', attributes: { variant: 'invalid' } }], 'invalid_attribute_value'],
  ['object attributes', [{ ...changes[0], attributes: { content: {} } }], 'unsupported_attribute_type'],
  ['unknown attribute', [{ ...changes[0], attributes: { unknown: true } }], 'unsupported_attribute'],
]) {
  test(`attribute edits refuse ${name}`, async () => {
    const f = fixture();
    assert.equal((await f.edit(edits)).error, expected);
    assert.equal(f.dirty, false);
    assert.equal(f.saves, 0);
  });
}

test('invalid native parse refuses before any write', async () => {
  const f = fixture();
  f.invalidParse = true;
  assert.equal((await f.edit()).error, 'unsupported_block');
  assert.equal(f.saves, 0);
});

test('cleanup leaves another users lock alone', async () => {
  const f = fixture();
  await f.call('connect');
  f.locked = true;
  assert.equal((await f.call('release')).cleanup, 'not_owned');
  assert.equal(f.releases, 0);
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

test('verification detects a publication status changed by the server', async () => {
  const f = fixture();
  f.post.status = 'publish';
  await f.edit();
  f.statusAfterSave = 'pending';
  const saved = await f.save();
  assert.equal(saved.error, 'verification_mismatch');
  assert.equal(saved.persistence, 'uncertain');
  assert.deepEqual(copy(saved.diagnostics.fields), ['status']);
  assert.equal(f.saves, 1);
});

test('rejects a mismatched site before writing', async () => {
  const f = fixture();
  assert.equal((await f.call('connect', { target: { site_url: 'https://elsewhere.test', post_id: 7, post_type: 'page' } })).error, 'target_mismatch');
  assert.equal(f.saves, 0);
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

test('attribute edits reject arrays used as attribute objects', async () => {
  const f = fixture();
  const result = await f.edit([{ ...changes[0], attributes: ['invalid'] }]);
  assert.equal(result.error, 'invalid_edit');
  assert.equal(f.dirty, false);
  assert.equal(f.saves, 0);
});

test('schema validation preserves every metadata key in saved-record checks', async () => {
  const f = fixture();
  f.post.meta = JSON.parse('{"constructor":"before","__proto__":{"value":1}}');
  await f.edit();
  f.loadedPost = copy(f.post);
  f.post.meta.constructor = 'after';
  const result = await f.save();
  assert.equal(result.error, 'saved_record_changed');
  assert.equal(f.saves, 0);
});

test('malformed WordPress content is refused before editing', async () => {
  const f = fixture();
  f.post.content.raw = 42;
  const result = await f.call('connect');
  assert.equal(result.ok, false);
  assert.equal(f.dirty, false);
  assert.equal(f.saves, 0);
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

test('a name filter finds blocks by exact name, bare name, wildcard, or list, in document order', async () => {
  const f = fixture();
  f.registrations['acme/table'] = { name: 'acme/table', attributes: {} };
  f.blocks = [
    { name: 'core/paragraph', clientId: 'intro', attributes: { content: 'A table of heights' }, innerBlocks: [], isValid: true },
    { name: 'core/group', clientId: 'group', attributes: {}, isValid: true, innerBlocks: [
      { name: 'core/table', clientId: 'first', attributes: {}, innerBlocks: [], isValid: true },
      { name: 'acme/table', clientId: 'custom', attributes: {}, innerBlocks: [], isValid: true },
    ] },
    { name: 'core/table', clientId: 'second', attributes: { caption: 'Heights' }, innerBlocks: [], isValid: true },
  ];
  f.syncContent();
  await f.call('connect');
  const ids = async (blocks) => {
    const read = await f.call('read', { blocks });
    assert.equal(read.ok, true, JSON.stringify(read));

    return copy(read.blocks).map(block => block.client_id);
  };

  assert.deepEqual(await ids({ name: 'core/table' }), ['first', 'second']);
  assert.deepEqual(await ids({ name: 'CORE/Table' }), ['first', 'second']);
  assert.deepEqual(await ids({ name: 'table' }), ['first', 'custom', 'second']);
  assert.deepEqual(await ids({ name: 'wp:table' }), ['first', 'custom', 'second']);
  assert.deepEqual(await ids({ name: 'acme/*' }), ['custom']);
  assert.deepEqual(await ids({ name: '*tab*' }), ['first', 'custom', 'second']);
  assert.deepEqual(await ids({ name: ['core/group', 'acme/table'] }), ['group', 'custom']);
  assert.deepEqual(await ids({ name: 'core/table', client_id: 'group' }), ['first']);
  assert.deepEqual(await ids({ name: 'core/table', search: 'heights' }), ['second']);
  assert.deepEqual(await ids({ name: 'core/image' }), []);
  const detailed = await f.call('read', { blocks: { name: 'core/table', attributes: true } });
  assert.equal(detailed.blocks[1].attributes.caption, 'Heights');
  assert.equal((await f.call('read', { blocks: { name: 'core/table' } })).blocks[1].attributes, undefined);

  for (const blocks of [{ name: [] }, { name: '  ' }, { client_id: 'first', attributes: true }]) {
    const refused = await f.call('read', { blocks });
    assert.equal(refused.error, 'invalid_read', JSON.stringify(refused));
    assert.match(refused.hint, /search and\/or name/);
  }
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

test('native attribute validation identifies the edit and attribute without echoing its value', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached' });
  const result = await f.call('edit', { edits: [{
    op: 'update', path: [1], name: 'example/card', attributes: { variant: 'private-input' },
  }] });
  assert.equal(result.error, 'invalid_attribute_value');
  assert.deepEqual(copy(result.diagnostics), {
    stage: 'prepare_plan', edit_index: 0, edit_operation: 'update', target_path: [1],
    path_space: 'planned', target_origin: 'existing_block', live_path: [1],
    block_name: 'example/card', attribute: 'variant', expected_type: 'string', constraint: 'registered_enum',
  });
  assert.match(result.hint, /attribute_guide/);
  assert.equal(JSON.stringify(result).includes('private-input'), false);
  assert.equal(f.saves, 0);
});

test('serialization refusal identifies a changed native attribute before mutation', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached' });
  const parse = f.window.wp.blocks.parse;
  f.window.wp.blocks.parse = (text) => parse(text).map((block) => {
    delete block.attributes.dropCap;

    return block;
  });
  const edited = await f.call('edit', { edits: [{
    op: 'update', path: [0], name: 'core/paragraph', attributes: { dropCap: true },
  }] });
  assert.equal(edited.error, 'serialization_mismatch');
  assert.equal(edited.diagnostics.stage, 'prepare_round_trip');
  assert.equal(edited.diagnostics.comparison, 'planned_to_parsed');
  assert.deepEqual(copy(edited.diagnostics.mismatches.blocks[0]), {
    path: [0], properties: ['attributes.dropCap'], truncated: false,
    expected_name: 'core/paragraph', actual_name: 'core/paragraph',
  });
  assert.equal(f.blocks[0].attributes.dropCap, undefined);
  assert.equal(f.saves, 0);
});

function defaultRoundTripFixture() {
  const f = fixture();
  f.registrations['core/image'] = { name: 'core/image', attributes: {
    url: { type: 'string' }, isDecorative: { type: 'boolean', default: false },
  } };
  f.blocks[1] = { name: 'core/group', clientId: 'images', attributes: {}, isValid: true, innerBlocks: [
    { name: 'core/image', clientId: 'image', attributes: { url: 'https://example.test/fixture.png' }, isValid: true, innerBlocks: [] },
  ] };
  const serialize = f.window.wp.blocks.serialize;
  f.window.wp.blocks.serialize = (list) => serialize(list).replaceAll(',"isDecorative":false', '');
  const parse = f.window.wp.blocks.parse;
  f.window.wp.blocks.parse = (text) => {
    const list = parse(text);
    const defaults = (blocks) => blocks.forEach((block) => {
      if (block.name === 'core/image') block.attributes.isDecorative ??= false;
      defaults(block.innerBlocks);
    });
    defaults(list);

    return list;
  };

  f.syncContent();

  return f;
}

test('untouched pre-existing native defaults do not block editing or verified saving', async () => {
  for (const shift of [false, true]) {
    const f = defaultRoundTripFixture();
    const before = copy(f.blocks[1]);
    const edits = shift
      ? [{ op: 'insert', parent: [], index: 0, block: { name: 'core/paragraph', attributes: { content: 'Inserted' } } }]
      : changes;
    const edited = await f.edit(edits);
    assert.equal(edited.ok, true, JSON.stringify(edited));
    assert.deepEqual(f.blocks[shift ? 2 : 1], before);
    assert.equal((await f.save()).persistence, 'verified');
  }
});

for (const [name, edits] of [
  ['the block', [{ op: 'update', path: [1, 0], name: 'core/image', attributes: { url: 'https://example.test/new.png' } }]],
  ['an ancestor', [{ op: 'update', path: [1], name: 'core/group', attributes: { className: 'changed' } }]],
  ['the destination subtree', [{ op: 'insert', parent: [1], block: { name: 'core/paragraph', attributes: { content: 'Inserted' } } }]],
]) {
  test(`markup-identical default additions pass when editing ${name}`, async () => {
    const f = defaultRoundTripFixture();
    const edited = await f.edit(edits);
    assert.equal(edited.ok, true, JSON.stringify(edited));
    assert.equal((await f.save()).persistence, 'verified');
  });
}

test('non-default information loss refuses while new markup-identical defaults pass', async () => {
  for (const existingLoss of [false, true]) {
    const f = defaultRoundTripFixture();
    const image = f.blocks[1].innerBlocks[0];

    if (existingLoss) {
      image.attributes.isDecorative = true;
      const parse = f.window.wp.blocks.parse;
      f.window.wp.blocks.parse = (text) => {
        const blocks = parse(text);
        blocks[1].innerBlocks[0].attributes.isDecorative = false;

        return blocks;
      };
    } else {
      const parse = f.window.wp.blocks.parse;
      f.window.wp.blocks.parse = (text) => {
        const blocks = parse(text);

        if (!text.includes('After')) delete blocks[1].innerBlocks[0].attributes.isDecorative;

        return blocks;
      };
    }

    f.syncContent();
    const before = copy(f.blocks);
    const edited = await f.edit();

    if (existingLoss) {
      assert.equal(edited.error, 'serialization_mismatch', JSON.stringify(edited));
      assert.equal(edited.editor_result, 'not_applied');
      assert.deepEqual(f.blocks, before);
      assert.equal(f.saves, 0);
    } else {
      assert.equal(edited.ok, true, JSON.stringify(edited));
      assert.equal((await f.save()).persistence, 'verified');
    }
  }
});

test('markup-identical default additions during native application pass', async () => {
  const f = defaultRoundTripFixture();
  let nativeApplied = false;
  const parse = f.window.wp.blocks.parse;
  f.window.wp.blocks.parse = (text) => {
    const list = parse(text);

    if (!nativeApplied) {
      const clear = (blocks) => blocks.forEach((block) => {
        if (block.name === 'core/image') delete block.attributes.isDecorative;
        clear(block.innerBlocks);
      });
      clear(list);
    }

    return list;
  };

  f.afterInsert = () => { nativeApplied = true; };

  const edited = await f.edit([{ op: 'insert', parent: [], block: { name: 'core/paragraph', attributes: { content: 'Inserted' } } }]);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal((await f.save()).persistence, 'verified');
});

test('round-trip refusals keep whole-document diagnostics bounded', async () => {
  const f = defaultRoundTripFixture();
  const image = f.blocks[1].innerBlocks[0];
  image.attributes.isDecorative = true;
  f.blocks[1].innerBlocks = Array.from({ length: 25 }, (_, index) => ({ ...copy(image), clientId: `image-${index}` }));
  const parse = f.window.wp.blocks.parse;
  f.window.wp.blocks.parse = (text) => {
    const blocks = parse(text);
    blocks[1].innerBlocks.forEach(block => { block.attributes.isDecorative = false; });

    return blocks;
  };

  f.syncContent();
  const edited = await f.edit([{ op: 'update', path: [1], name: 'core/group', attributes: { className: 'changed' } }]);
  assert.equal(edited.error, 'serialization_mismatch', JSON.stringify(edited));
  assert.equal(edited.diagnostics.mismatches.blocks.length, 20);
  assert.equal(edited.diagnostics.mismatches.truncated, true);
  assert.equal(edited.editor_result, 'not_applied');
  assert.equal(f.saves, 0);
});

test('an unavailable default markup proof refuses with bounded debug and no mutation', async () => {
  const f = defaultRoundTripFixture();
  const serialize = f.window.wp.blocks.serialize;
  f.window.wp.blocks.serialize = (list) => {
    if (list.length === 1 && list[0].attributes.isDecorative === false) {
      throw new Error('native default serialization failed nonce=private-value');
    }

    return serialize(list);
  };

  const edited = await f.edit();
  assert.equal(edited.error, 'serialization_mismatch', JSON.stringify(edited));
  assert.equal(edited.diagnostics.stage, 'round_trip_defaults');
  assert.equal(edited.diagnostics.markup_available, false);
  assert.deepEqual(copy(edited.diagnostics.target_path), [1, 0]);
  assert.equal(edited.editor_result, 'not_applied');
  assert.match(edited.debug.cause.message, /native default serialization failed nonce=\[redacted\]/);
  assert.equal(JSON.stringify(edited).includes('private-value'), false);
  assert.equal(f.blocks[0].attributes.content, 'Before');
  assert.equal(f.saves, 0);
});

test('heading level defaults refuse when filling them changes native markup', async () => {
  const f = fixture();
  f.registrations['core/heading'] = { name: 'core/heading', attributes: {
    content: { type: 'rich-text' }, level: { type: 'number', default: 2 },
  } };
  f.blocks[1] = { name: 'core/heading', clientId: 'heading', attributes: { content: 'Synthetic heading.' }, innerBlocks: [], isValid: true };
  const serialize = f.window.wp.blocks.serialize;
  f.window.wp.blocks.serialize = (list) => {
    if (list.length === 1 && list[0].name === 'core/heading') {
      const { content, level } = list[0].attributes;

      return `<!-- wp:heading --><h${level}>${content}</h${level}><!-- /wp:heading -->`;
    }

    return serialize(list);
  };

  const parse = f.window.wp.blocks.parse;
  f.window.wp.blocks.parse = (text) => {
    const blocks = parse(text);
    blocks[1].attributes.level = 2;

    return blocks;
  };

  f.syncContent();
  const before = copy(f.blocks);
  const edited = await f.edit();
  assert.equal(edited.error, 'serialization_mismatch', JSON.stringify(edited));
  assert.deepEqual(copy(edited.diagnostics.mismatches.blocks[0]).properties, ['attributes.level']);
  assert.equal(edited.editor_result, 'not_applied');
  assert.deepEqual(f.blocks, before);
  assert.equal(f.saves, 0);
});

for (const level of [3, 2]) {
  test(`unsetting heading level ${level} restores the default without invalid markup`, async () => {
    const f = fixture();
    f.registrations['core/heading'] = { name: 'core/heading', attributes: {
      content: { type: 'rich-text' }, level: { type: 'number', default: 2 },
    } };
    f.blocks[1] = { name: 'core/heading', clientId: 'heading', attributes: { content: 'Heading', level }, innerBlocks: [], isValid: true };
    const serialize = f.window.wp.blocks.serialize;
    const parse = f.window.wp.blocks.parse;
    let markup;
    f.window.wp.blocks.serialize = (list) => {
      const heading = list.find((block) => block.name === 'core/heading');

      if (heading) markup = `<h${heading.attributes.level}>${heading.attributes.content}</h${heading.attributes.level}>`;

      return serialize(list);
    };

    f.window.wp.blocks.parse = (text) => {
      const blocks = parse(text);

      for (const block of blocks.filter((item) => item.name === 'core/heading')) {
        if (block.attributes.level === undefined) {
          block.attributes.level = 2;
          block.isValid = false;
        }
      }

      return blocks;
    };

    f.syncContent();
    const edited = await f.edit([{ client_id: 'heading', unset: [['level']] }]);
    assert.equal(f.blocks[1].attributes.level, 2);

    // Unsetting the default already in place changes nothing.
    if (level === 2) {
      assert.equal(edited.error, 'no_change', JSON.stringify(edited));

      return;
    }

    assert.equal(edited.editor_result, 'applied', JSON.stringify(edited));
    assert.equal(markup, '<h2>Heading</h2>');
  });
}

test('unsetting whole attributes preserves falsy defaults and clears attributes without defaults', async () => {
  const f = fixture();
  Object.assign(f.registrations['example/card'].attributes, {
    enabled: { type: 'boolean', default: false }, count: { type: 'number', default: 0 },
    label: { type: 'string', default: '' }, options: { type: 'object', default: { color: { text: 'default' } } },
  });
  Object.assign(f.blocks[1].attributes, { enabled: true, count: 1, label: 'label', options: { color: { text: 'red', background: 'blue' } } });
  f.syncContent();
  const edited = await f.edit([{ client_id: 'b', unset: [['enabled'], ['count'], ['label'], ['variant'], ['options', 'color', 'text']] }]);
  assert.equal(edited.editor_result, 'applied', JSON.stringify(edited));
  assert.deepEqual(copy(f.blocks[1].attributes), { variant: undefined, enabled: false, count: 0, label: '', options: { color: { background: 'blue' } } });
});

test('markup-identical sourced defaults remain strict', async () => {
  const f = defaultRoundTripFixture();
  f.registrations['core/image'].attributes.isDecorative.source = 'attribute';
  const edited = await f.edit();
  assert.equal(edited.error, 'serialization_mismatch', JSON.stringify(edited));
  assert.equal(edited.editor_result, 'not_applied');
  assert.equal(f.saves, 0);
});

test('local attributes never block a round trip, because core does not save them', async () => {
  const f = defaultRoundTripFixture();
  f.registrations['core/image'].attributes.isDecorative.role = 'local';
  const edited = await f.edit();
  assert.equal(edited.ok, true, JSON.stringify(edited));
});

function mixedFixture() {
  const f = fixture();
  f.blocks.push({ name: 'core/html', attributes: { content: '<p>Preserve raw bytes.</p>' }, clientId: 'raw', innerBlocks: [], isValid: true });
  f.syncContent();

  return f;
}

for (const [name, mutate, edits, error] of [
  ['unsupported target', () => {}, [{ path: [3], name: 'core/html', attributes: { content: 'Change' } }], 'unsupported_target_or_subtree'],
  ['invalid sibling', (f) => { f.blocks[2].isValid = false; }, changes, 'unsupported_block'],
  ['ambiguous target markup', (f) => { f.blocks[2].attributes.content = 'Before'; }, changes, 'ambiguous_preservation_region'],
  ['ambiguous unsupported markup', (f) => { f.blocks.push({ ...copy(f.blocks[3]), clientId: 'duplicate' }); }, changes, 'ambiguous_preservation_region'],
  ['unsupported descendant', (f) => { f.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, isValid: true, innerBlocks: [f.blocks.pop()] }; }, [{ path: [1], name: 'core/group', attributes: { className: 'changed' } }], 'unsupported_target_or_subtree'],
  ['unsupported ancestor', (f) => { f.blocks[3].innerBlocks.push(f.blocks[0]); }, [{ path: [3, 0], name: 'core/paragraph', attributes: { content: 'Change' } }], 'unsupported_target_or_subtree'],
]) {
  test(`mixed-content edit refuses ${name}`, async () => {
    const f = mixedFixture();
    mutate(f);
    f.syncContent();
    assert.equal((await f.edit(edits)).error, error);
    assert.equal(f.dirty, false);
    assert.equal(f.saves, 0);
  });
}

test('mixed-content edit refuses serializer normalization and unrelated changes', async () => {
  for (const normalize of [true, false]) {
    const f = mixedFixture();
    const native = f.window.wp.blocks.serialize;
    f.window.wp.blocks.serialize = (list) => {
      const text = native(list);

      return normalize || text.includes('After') ? text.replace('Preserve raw bytes.', 'Normalized') : text;
    };

    const result = await f.edit();
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(f.saves, 0);
    assert.equal(f.dirty, false);
  }
});

test('ordered structural edits resolve paths after each edit and save once', async () => {
  const f = fixture();
  const original = f.post.content.raw;

  const plan = await f.edit([
    { op: 'insert', parent: [], index: 1, block: { name: 'core/group', attributes: { layout: { type: 'constrained' } }, inner_blocks: [
      { name: 'core/paragraph', attributes: { content: 'Replace me' } },
      { name: 'core/paragraph', attributes: { content: 'Remove me' } },
    ] } },
    { op: 'move', path: [3], name: 'core/paragraph', parent: [1], index: 1 },
    { op: 'update', path: [1], name: 'core/group', attributes: { style: { spacing: { padding: { top: '2rem' } } }, allowedBlocks: ['core/paragraph', 'example/card'] } },
    { op: 'replace', path: [1, 0], name: 'core/paragraph', block: { name: 'example/card', attributes: { variant: 'accent' } } },
    { op: 'remove', path: [1, 2], name: 'core/paragraph' },
    { op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'New' } }, parent: [1], index: 0 },
    { op: 'update', path: [1, 0], name: 'core/paragraph', attributes: { content: 'Final' } },
    { op: 'update', path: [1, 0], name: 'core/paragraph', attributes: { dropCap: true } },
  ]);

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(f.post.content.raw, original);
  assert.equal(f.dirty, true);
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.deepEqual(f.blocks.map((block) => block.name), ['core/paragraph', 'core/group', 'example/card']);
  assert.equal(f.blocks[1].innerBlocks[0].attributes.content, 'Final');
  assert.equal(f.blocks[1].innerBlocks[0].attributes.dropCap, true);
  assert.equal(f.blocks[1].innerBlocks[1].attributes.variant, 'accent');
  assert.equal(f.blocks[1].innerBlocks[2].attributes.content, 'Preserve');
  assert.equal(f.blocks[2].attributes.variant, 'plain');
  assert.equal(f.saves, 1);
});

test('client ID selectors survive preceding removals and resolve move destinations', async () => {
  const f = fixture();
  f.blocks.push({ name: 'core/group', clientId: 'destination', attributes: {}, innerBlocks: [], isValid: true });
  f.syncContent();
  await f.call('connect', { workflow: 'attached' });
  const edited = await f.call('edit', { edits: [
    { op: 'remove', client_id: 'a', name: 'core/paragraph' },
    { op: 'move', client_id: 'c', name: 'core/paragraph', parent_client_id: 'destination' },
    { op: 'update', client_id: 'c', name: 'core/paragraph', attributes: { content: 'Moved and updated' } },
    { op: 'insert', parent_client_id: 'destination', block: { name: 'core/paragraph', attributes: { content: 'Inserted' } } },
  ] });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(f.blocks[1].clientId, 'destination');
  assert.equal(f.blocks[1].innerBlocks[0].attributes.content, 'Moved and updated');
  assert.equal(f.blocks[1].innerBlocks[1].attributes.content, 'Inserted');
  // Only the moved block's attributes changed; the group gained children and
  // the inserted block is new.
  assert.deepEqual(JSON.parse(JSON.stringify(edited.changed.map(({ preview: _preview, ...block }) => block))), [
    { path: [1], client_id: 'destination', name: 'core/group' },
    { path: [1, 0], client_id: 'c', name: 'core/paragraph', properties: ['content'] },
    { path: [1, 1], client_id: f.blocks[1].innerBlocks[1].clientId, name: 'core/paragraph' },
  ]);
  assert.equal(f.saves, 0);
});

test('missing or removed client IDs refuse edits without retargeting', async () => {
  for (const client_id of ['missing', 'a']) {
    const f = fixture();
    const before = copy(f.blocks);
    const prepared = await f.edit([
      { op: 'remove', client_id: 'a', name: 'core/paragraph' },
      { op: 'update', client_id, name: 'core/paragraph', attributes: { content: 'Wrong target' } },
    ]);
    assert.equal(prepared.error, 'block_identity_missing', JSON.stringify(prepared));
    assert.equal(prepared.diagnostics.edit_index, 1);
    assert.equal(prepared.diagnostics.selector_field, 'client_id');
    assert.equal(prepared.diagnostics.matches, 0);
    assert.deepEqual(f.blocks, before);
    assert.equal(f.saves, 0);
  }
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

test('media_map moves copied blocks to the target site, never maps a value twice, and refuses leftovers', async () => {
  const f = fixture();
  f.registrations['example/media'] = { name: 'example/media', attributes: { id: { type: 'number' }, url: { type: 'string' }, caption: { type: 'string' } } };
  f.registrations['example/link'] = { name: 'example/link', attributes: { id: { type: 'number' }, url: { type: 'string' } } };
  const source = 'https://source.test/wp-content/uploads/2026/10/';
  const target = 'https://example.test/wp-content/uploads/2026/10/';
  const section = (media) => f.window.wp.blocks.serialize([{ name: 'core/group',
    attributes: { style: { background: { backgroundImage: { id: 7, url: `${source}bg.jpg` } } } },
    innerBlocks: [
      { name: 'example/media', attributes: { id: 9, url: `${source}photo.jpg`, ...media }, innerBlocks: [] },
      { name: 'example/link', attributes: { id: 9, url: 'https://source.test/about/' }, innerBlocks: [] },
    ] }]);
  const markup = section({ caption: `<img class="wp-image-9" src="${source}photo-300x200.jpg">` });
  // 9 becomes 7 while 7 becomes 70: a moved value must not move again.
  const mediaMap = { ids: { 7: 70, 9: 7 }, urls: { [`${source}bg.jpg`]: `${target}bg.jpg`, [`${source}photo.jpg`]: `${target}photo.jpg` } };
  await f.call('connect');

  const refused = await f.call('edit', { edits: [{ op: 'insert', index: 0, markup, media_map: mediaMap }] });
  assert.equal(refused.error, 'unmapped_media_url', JSON.stringify(refused));
  assert.deepEqual(copy(refused.diagnostics.references), [{ block_name: 'example/media', path: [0, 0], attribute: 'caption' }]);
  assert.equal(refused.diagnostics.field, 'edits.0.media_map');
  assert.equal(JSON.stringify(refused).includes('photo-300x200'), false);
  assert.equal(f.dirty, false);

  // A URL inside text never changes, even once mapped.
  mediaMap.urls[`${source}photo-300x200.jpg`] = `${target}photo-300x200.jpg`;
  const embedded = await f.call('edit', { edits: [{ op: 'insert', index: 0, markup, media_map: mediaMap }] });
  assert.equal(embedded.error, 'unmapped_media_url', JSON.stringify(embedded));
  assert.match(embedded.hint, /inside text/);

  const inserted = await f.call('edit', { edits: [{ op: 'insert', index: 0, markup: section({}), media_map: mediaMap }] });
  assert.equal(inserted.ok, true, JSON.stringify(inserted));
  const [group] = f.blocks;
  assert.deepEqual(copy(group.attributes.style.background.backgroundImage), { id: 70, url: `${target}bg.jpg` });
  assert.deepEqual(copy(group.innerBlocks[0].attributes), { id: 7, url: `${target}photo.jpg` });
  assert.deepEqual(copy(group.innerBlocks[1].attributes), { id: 9, url: 'https://source.test/about/' });
});

test('media_map replaces only whole mapped URLs and class tokens, and keeps request URLs out of errors', async () => {
  const f = fixture();
  f.registrations['example/media'] = { name: 'example/media', attributes: { id: { type: 'number' }, url: { type: 'string' },
    alt: { type: 'string' }, className: { type: 'string' }, note: { type: 'string' } } };
  const source = 'https://source.test/wp-content/uploads/';
  const target = 'https://example.test/wp-content/uploads/';
  await f.call('connect');
  const insert = (attributes, urls) => f.call('edit', { edits: [{ op: 'insert', index: 0,
    markup: f.window.wp.blocks.serialize([{ name: 'example/media', attributes, innerBlocks: [] }]),
    media_map: { ids: { 9: 7 }, urls: { [`${source}photo.jpg`]: `${target}wp-image-9.jpg`, ...urls } } }] });

  const kept = await insert({ id: 9, url: `${source}photo.jpg`, alt: 'Figure wp-image-9', className: 'wp-image-9 framed',
    note: 'https://source.test/about/?next=/uploads/x' });
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.deepEqual(copy(f.blocks[0].attributes), { id: 7, url: `${target}wp-image-9.jpg`, alt: 'Figure wp-image-9',
    className: 'wp-image-7 framed', note: 'https://source.test/about/?next=/uploads/x' });

  const data = await insert({ note: '<img data-class="wp-image-9">' });
  assert.equal(String(f.blocks[0].attributes.note), '<img data-class="wp-image-9">');
  assert.equal(data.ok, true, JSON.stringify(data));

  for (const leftover of [`${source}photo.jpg.webp`, 'HTTPS://source.test/wp-content/uploads/left.jpg', '//source.test/wp-content/uploads/left.jpg',
    `${source}photo.jpg,other.jpg`, `background:url(${source}photo.jpg(extra).webp)`]) {
    const classed = await insert({ className: `wp-image-9 ${leftover}` });
    assert.equal(classed.error, 'unmapped_media_url', `className ${leftover}`);

    const refused = await insert({ note: leftover });
    assert.equal(refused.error, 'unmapped_media_url', leftover);
  }

  for (const urls of [{ 'https://[bad': `${target}x.jpg` }, { [`${source}secret.jpg?token=private`]: 42 },
    { '//source.test/file?token=private': `${target}x.jpg` }]) {
    const invalid = await insert({}, urls);
    assert.equal(invalid.validation_source, 'request', JSON.stringify(invalid));
    assert.equal(JSON.stringify(invalid).includes('private') || JSON.stringify(invalid).includes('[bad'), false, JSON.stringify(invalid));
  }

  const unregistered = await insert({ 'https://private.test/?token=private': `${source}photo.jpg` });
  assert.equal(unregistered.error, 'unsupported_attribute', JSON.stringify(unregistered));
  assert.equal(unregistered.diagnostics.attribute, '<key>');
  assert.equal(JSON.stringify({ ...unregistered, debug: undefined }).includes('private'), false);
});

function linkFixture(site = target.site_url) {
  const f = fixture('page', `${site}/wp-admin/post.php?post=7&action=edit`);
  f.site_url = site;
  const call = f.call;
  f.call = (operation, extra = {}) => call(operation, { ...extra,
    target: operation === 'connect' ? { site_url: site, post_id: 7, post_type: 'page' }
      : { ...target, site_url: site } });
  f.registrations['example/link'] = { name: 'example/link', attributes: {
    url: { type: 'string' }, href: { type: 'string' }, content: { type: 'string' },
    note: { type: 'string' }, items: { type: 'array' }, id: { type: 'number' } } };

  for (const name of ['core/navigation-link', 'core/navigation-submenu']) {
    f.registrations[name] = { name, attributes: { url: { type: 'string' }, id: { type: 'number' } } };
  }

  f.types = {
    page: { slug: 'page', rest_base: 'pages', viewable: true },
    book: { slug: 'book', rest_namespace: 'library/v1', rest_base: 'books', viewable: true },
    attachment: { slug: 'attachment', rest_base: 'media', viewable: true },
    hidden: { slug: 'hidden', rest_base: 'hidden', viewable: false },
  };
  f.matches = [];
  f.api = ({ path }) => {
    // WordPress reports viewable only in edit context.
    if (path.startsWith('/wp/v2/types?')) {
      return path === '/wp/v2/types?context=edit'
        ? f.types
        : Object.fromEntries(Object.entries(f.types).map(([key, { viewable: _viewable, ...type }]) => [key, type]));
    }

    if (/^\/(wp\/v2\/pages|library\/v1\/books)\?/.test(path)) {
      const url = new URL(path, site);
      assert.equal(url.searchParams.get('status'), 'publish');
      assert.equal(url.searchParams.get('per_page'), '100');

      return f.matches.filter((record) => record.collection === url.pathname && record.slug === url.searchParams.get('slug'));
    }

    if (/^\/wp\/v2\/(media|hidden)\?/.test(path)) assert.fail(`Unexpected type lookup ${path}`);
  };

  f.markup = (attributes, name = 'example/link') => f.window.wp.blocks.serialize([{ name, attributes, innerBlocks: [] }]);

  return f;
}

test('map_links resolves exact hierarchical permalinks on the destination and retains query and fragment', async () => {
  const f = linkFixture();
  const source = 'https://source.test';
  const child = `${source}/services/design/?ref=section&mode=full#details`;
  f.matches = [
    { collection: '/wp/v2/pages', slug: 'design', id: 11, link: `${target.site_url}/other/design/` },
    { collection: '/wp/v2/pages', slug: 'design', id: 12, link: `${target.site_url}/services/design/` },
    { collection: '/library/v1/books', slug: 'book', id: 14, link: `${target.site_url}/books/book/` },
  ];
  await f.call('connect');
  const before = copy(f.blocks);
  f.requests = [];
  const mapped = await f.call('map_links', { source_site_url: source, markup: f.markup({
    url: child, href: `${source}/books/book/`, content: `<a href="${child.replaceAll('&', '&amp;')}">Design</a>`,
  }) });
  assert.equal(mapped.ok, true, JSON.stringify(mapped));
  assert.equal(mapped.operation, 'map_links');
  assert.equal(mapped.persistence, 'not_attempted');
  assert.deepEqual(copy(mapped.link_map), { source_site_url: source,
    urls: { [child]: `${target.site_url}/services/design/?ref=section&mode=full#details`, [`${source}/books/book/`]: `${target.site_url}/books/book/` },
    ids: { [child]: 12, [`${source}/books/book/`]: 14 } });
  assert.deepEqual(copy(mapped.links[0]), { source_url: child, target_url: mapped.link_map.urls[child], post_type: 'page', post_id: 12 });
  assert.deepEqual(f.blocks, before);
  assert.equal(f.dirty, false);
  assert.equal(f.requests.every(({ method, path }) => method === 'GET' && path.startsWith('/')), true);
  assert.equal(f.requests.length, 5); // one type discovery, two types for each distinct URL
  assert.equal(f.saves, 0);
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

test('map_links handles roots, subdirectory installs, overrides, and ignores external and upload links', async () => {
  const f = linkFixture('https://example.test/staging');
  const source = 'https://source.test/local';
  await f.call('connect');
  f.matches = [{ collection: '/wp/v2/pages', slug: 'about', id: 21, link: `${f.site_url}/about/` }];
  const values = [`${source}`, `${source}/?q=yes#top`, `${source}/about/`, `${source}/old/`,
    `${source}/wp-content/uploads/photo.jpg`, `${source}/uploads/photo.jpg`, 'https://external.test/about/',
    'https://source.test/locality/about/', 'https://source.test/elsewhere/', '/about/', '#local'];
  const markup = values.map((url) => f.markup({ url })).join('\n\n');
  const mapped = await f.call('map_links', { markup, source_site_url: source,
    overrides: [{ source_url: `${source}/old/`, target_url: 'https://external.test/archive/?q=1#top' }] });
  assert.equal(mapped.ok, true, JSON.stringify(mapped));
  assert.deepEqual(copy(mapped.link_map.urls), { [source]: `${f.site_url}/`, [`${source}/?q=yes#top`]: `${f.site_url}/?q=yes#top`,
    [`${source}/about/`]: `${f.site_url}/about/`, [`${source}/old/`]: 'https://external.test/archive/?q=1#top' });
  assert.deepEqual(copy(mapped.link_map.ids), { [`${source}/about/`]: 21 });
  assert.equal(mapped.links[0].post_id, null);
  assert.equal(mapped.links[3].post_type, null);
});

test('link_map accepts mapped destination URLs inside the source installation and still refuses source prose', async () => {
  const f = linkFixture('https://example.test/staging');
  const source = target.site_url;
  const from = `${source}/about/?a=1&b=2#team`;
  const to = `${f.site_url}/about/?a=1&b=2#team`;
  f.matches = [{ collection: '/wp/v2/pages', slug: 'about', id: 21, link: `${f.site_url}/about/` }];
  await f.call('connect');
  const markup = f.markup({ url: from, content: `<a href="${from.replaceAll('&', '&amp;')}">Team</a>` });
  const mapped = await f.call('map_links', { markup, source_site_url: source });
  assert.equal(mapped.ok, true, JSON.stringify(mapped));
  const applied = await f.call('edit', { edits: [{ op: 'insert', index: 0, markup, link_map: mapped.link_map }] });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(f.blocks[0].attributes.url, to);
  assert.equal(f.blocks[0].attributes.content, `<a href="${to.replaceAll('&', '&amp;')}">Team</a>`);
  const before = copy(f.blocks);
  const refused = await f.call('edit', { edits: [{ op: 'insert', index: 0, link_map: mapped.link_map,
    block: { name: 'example/link', attributes: { note: `Plain ${from}` } } }] });
  assert.equal(refused.error, 'unmapped_internal_link');
  assert.equal(refused.diagnostics.references[0].attribute, 'note');
  assert.deepEqual(f.blocks, before);
});

test('map_links refuses missing and ambiguous destinations with bounded repair guidance', async () => {
  const f = linkFixture();
  await f.call('connect');
  const source = 'https://source.test';
  const markup = Array.from({ length: 12 }, (_, index) => f.markup({ url: `${source}/page-${index}/` })).join('\n\n');
  const missing = await f.call('map_links', { markup, source_site_url: source });
  assert.equal(missing.error, 'link_resolution_incomplete', JSON.stringify(missing));
  assert.equal(missing.persistence, 'not_attempted');
  assert.equal(missing.diagnostics.links.length, 10);
  assert.equal(missing.diagnostics.truncated, true);
  assert.deepEqual(copy(missing.diagnostics.links[0]), { source_url: `${source}/page-0/`, reason: 'missing' });
  assert.match(missing.hint, /overrides.*publish/);
  f.matches = ['/wp/v2/pages', '/library/v1/books'].map((collection, index) => ({ collection, slug: 'same', id: index + 1, link: `${target.site_url}/same/` }));
  const ambiguous = await f.call('map_links', { markup: f.markup({ url: `${source}/same/` }), source_site_url: source });
  assert.equal(ambiguous.error, 'link_resolution_incomplete');
  assert.equal(ambiguous.diagnostics.links[0].reason, 'ambiguous');
  assert.equal(f.dirty, false);
  assert.equal(f.saves, 0);
});

test('map_links validates shapes, URL bounds and distinct link counts before REST', async () => {
  const f = linkFixture();
  await f.call('connect');
  const source = 'https://source.test';
  const request = { markup: f.markup({ url: `${source}/about/` }), source_site_url: source };

  for (const [patch, field] of [
    [{ source_site_url: `${source}/?query=bad` }, 'source_site_url'],
    [{ markup: 'x'.repeat(256 * 1024 + 1) }, 'markup'],
    [{ overrides: [{ source_url: 'relative', target_url: `${target.site_url}/about/` }] }, 'overrides.0.source_url'],
    [{ overrides: [{ source_url: `${source}/about/`, target_url: 'https://user:secret@example.test/' }] }, 'overrides.0.target_url'],
    [{ overrides: [{ source_url: `${source}/about/`, target_url: 'x'.repeat(2049) }] }, 'overrides.0.target_url'],
    [{ overrides: Array.from({ length: 51 }, (_, i) => ({ source_url: `${source}/${i}/`, target_url: `${target.site_url}/${i}/` })) }, 'overrides'],
    [{ markup: f.markup({ url: `${source}/${'a'.repeat(2048)}` }) }, 'markup.0'],
    [{ markup: Array.from({ length: 51 }, (_, i) => f.markup({ url: `${source}/${i}/` })).join('\n\n') }, 'markup'],
  ]) {
    f.requests = [];
    const invalid = await f.call('map_links', { ...request, ...patch });
    assert.equal(invalid.validation_source, 'request', JSON.stringify(invalid));
    assert.equal(invalid.issues[0].path, field, JSON.stringify(invalid));
    assert.equal(f.requests.length, 0);
  }

  f.requests = [];
  const repeated = await f.call('map_links', { ...request,
    markup: f.markup({ content: Array.from({ length: 51 }, () => `<a href="${source}/">Home</a>`).join(' ') }) });
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  assert.equal(repeated.links.length, 1);
  assert.equal(f.requests.length, 0);
});

test('map_links refuses a full slug result window instead of guessing uniqueness', async () => {
  const f = linkFixture();
  await f.call('connect');
  f.matches = Array.from({ length: 100 }, (_, i) => ({ collection: '/wp/v2/pages', slug: 'child', id: i + 1,
    link: `${target.site_url}/${i === 0 ? '' : `parent-${i}/`}child/` }));
  const failed = await f.call('map_links', { source_site_url: 'https://source.test', markup: f.markup({ url: 'https://source.test/child/' }) });
  assert.equal(failed.error, 'link_resolution_incomplete');
  assert.equal(failed.diagnostics.links[0].reason, 'candidate_limit');
});

test('link_map and media_map share one detached pass for rich text, whole URLs and navigation IDs', async () => {
  const f = linkFixture();
  const source = 'https://source.test';
  const from = `${source}/about/?a=1&b=2#team`;
  const to = `${target.site_url}/about/?a=1&b=2#team`;
  const upload = `${source}/wp-content/uploads/photo.jpg`;
  const targetUpload = `${target.site_url}/wp-content/uploads/photo.jpg`;
  const link_map = { source_site_url: source, urls: { [from]: to, [to]: 'https://elsewhere.test/' }, ids: { [from]: 41 } };
  const media_map = { urls: { [upload]: targetUpload }, ids: { 9: 71 } };
  const content = `<strong><a title='About' href="${from.replaceAll('&', '&amp;')}">Team</a></strong> <a href='https://external.test/'>External</a> <a href="${upload}">File</a>`;
  const markup = f.window.wp.blocks.serialize([{ name: 'core/group', attributes: {}, innerBlocks: [
    { name: 'core/paragraph', attributes: { content }, innerBlocks: [] },
    { name: 'example/link', attributes: { url: from, id: 9 }, innerBlocks: [] },
    { name: 'example/link', attributes: { url: upload, id: 9 }, innerBlocks: [] },
    { name: 'core/navigation-link', attributes: { url: from, id: 9 }, innerBlocks: [] },
    { name: 'core/navigation-submenu', attributes: { url: from }, innerBlocks: [] },
  ] }]);
  await f.call('connect');
  const replaced = await f.call('edit', { edits: [{ op: 'replace', client_id: 'a', markup, media_map, link_map }] });
  // Inline uploads belong to media_map and retain its existing refusal.
  assert.equal(replaced.error, 'unmapped_media_url');
  const withoutInline = markup.replace(`<a href=\\"${upload}\\">File</a>`, '');
  const applied = await f.call('edit', { edits: [{ op: 'replace', client_id: 'a', markup: withoutInline, media_map, link_map }] });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const children = f.blocks[0].innerBlocks;
  assert.equal(children[0].attributes.content, content.replace(from.replaceAll('&', '&amp;'), to.replaceAll('&', '&amp;')).replace(`<a href="${upload}">File</a>`, ''));
  assert.deepEqual(children[1].attributes, { url: to, id: 9 });
  assert.deepEqual(children[2].attributes, { url: targetUpload, id: 71 });
  assert.deepEqual(children[3].attributes, { url: to, id: 41 });
  assert.deepEqual(children[4].attributes, { url: to, id: 41 });

  const overridden = await f.call('edit', { edits: [{ op: 'insert', index: 1,
    block: { name: 'core/navigation-link', attributes: { url: from, id: 9 } },
    link_map: { source_site_url: source, urls: { [from]: 'https://external.test/archive/' }, ids: {} } }] });
  assert.equal(overridden.ok, true, JSON.stringify(overridden));
  assert.equal(f.blocks[1].attributes.id, undefined);
});

test('link_map refuses unmapped URLs before any edit mutates the draft, even when its map is empty', async () => {
  const f = linkFixture();
  await f.call('connect');
  const before = copy(f.blocks);
  const source = 'https://source.test/local';
  const link_map = { source_site_url: source, urls: {}, ids: {} };

  for (const op of ['insert', 'replace']) {
    const failed = await f.call('edit', { edits: [changes[0], { op, ...(op === 'replace' ? { client_id: 'b' } : { index: 0 }),
      block: { name: 'example/link', attributes: { items: [{ content: `<a href="${source}/missing/">Missing</a>` }] } }, link_map }] });
    assert.equal(failed.error, 'unmapped_internal_link', JSON.stringify(failed));
    assert.equal(failed.editor_result, 'not_applied');
    assert.equal(failed.diagnostics.field, 'edits.1.link_map');
    assert.equal(failed.diagnostics.references[0].attribute, 'items.0.content');
    assert.deepEqual(copy(failed.diagnostics.references[0].path), [0]);
    assert.match(failed.hint, /map_links/);
    assert.deepEqual(f.blocks, before);
    assert.equal(f.dirty, false);
  }

  const allowed = await f.call('edit', { edits: [{ op: 'insert', index: 0, link_map, block: { name: 'example/link', attributes: {
    url: `${source}/wp-content/uploads/a.jpg`, content: '<a href="https://external.test/">External</a>',
  } } }] });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
});

test('rich-text non-breaking spaces survive updates, nested inserts and replacements, and query cells', async () => {
  for (const space of ['&nbsp;', '\u00a0']) {
    for (const op of ['update', 'insert', 'replace']) {
      const f = fixture();
      const content = `Every${space}Room`;
      const edit = op === 'update' ? { op, path: [0], attributes: { content } } : {
        op, ...(op === 'replace' ? { path: [0] } : { index: 0 }),
        block: { name: 'core/group', inner_blocks: [{ name: 'core/paragraph', attributes: { content } }] },
      };
      const result = await f.edit([edit]);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal((await f.save()).persistence, 'verified');
      const saved = f.window.wp.blocks.parse(f.post.content.raw)[0];
      assert.equal(String((op === 'update' ? saved : saved.innerBlocks[0]).attributes.content), 'Every&nbsp;Room');
    }

    const f = fixture();
    f.registrations['core/table'] = { name: 'core/table', attributes: { body: { type: 'array', source: 'query', query: {
      cells: { type: 'array', source: 'query', query: { content: { type: 'rich-text' }, tag: { type: 'string' } } },
    } } } };
    const inserted = await f.edit([{ op: 'insert', index: 0, block: { name: 'core/table',
      attributes: { body: [{ cells: [{ content: `Cell${space}text`, tag: 'td' }] }] } } }]);
    assert.equal(inserted.ok, true, JSON.stringify(inserted));
    assert.equal((await f.save()).persistence, 'verified');
    assert.equal(f.window.wp.blocks.parse(f.post.content.raw)[0].attributes.body[0].cells[0].content, 'Cell&nbsp;text');
  }
});

test('a bare & in rich text saves as the entity the editor writes, without escaping entities again', async () => {
  for (const content of ['Terms & Conditions', 'Terms &amp; Conditions']) {
    for (const op of ['update', 'insert', 'replace']) {
      const f = fixture();
      const edit = op === 'update' ? { op, path: [0], attributes: { content } } : {
        op, ...(op === 'replace' ? { path: [0] } : { index: 0 }),
        block: { name: 'core/group', inner_blocks: [{ name: 'core/paragraph', attributes: { content } }] },
      };
      const result = await f.edit([edit]);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal((await f.save()).persistence, 'verified');
      const saved = f.window.wp.blocks.parse(f.post.content.raw)[0];
      assert.equal(String((op === 'update' ? saved : saved.innerBlocks[0]).attributes.content), 'Terms &amp; Conditions');
    }
  }

  const f = fixture();
  f.registrations['core/table'] = { name: 'core/table', attributes: { body: { type: 'array', source: 'query', query: {
    cells: { type: 'array', source: 'query', query: { content: { type: 'rich-text' }, tag: { type: 'string' } } },
  } } } };
  const inserted = await f.edit([{ op: 'insert', index: 0, block: { name: 'core/table',
    attributes: { body: [{ cells: [{ content: 'R&D', tag: 'td' }] }] } } }]);
  assert.equal(inserted.ok, true, JSON.stringify(inserted));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.window.wp.blocks.parse(f.post.content.raw)[0].attributes.body[0].cells[0].content, 'R&amp;D');
});

test('recover refuses changed JSON-LD in an HTML-sourced script string', async () => {
  const f = fixture();
  f.registrations['example/json-ld'] = { name: 'example/json-ld', attributes: {
    content: { type: 'string', source: 'html', selector: 'script' },
  } };
  const inserted = await f.edit([{ op: 'insert', block: { name: 'example/json-ld',
    attributes: { content: '{"label":"Every\u00a0Room"}' } } }]);
  assert.equal(inserted.ok, true, JSON.stringify(inserted));
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  const unchanged = await f.call('recover', { target: { site_url: target.site_url, user_id: 5 }, receipt: saved.receipt });
  assert.equal(unchanged.outcome, 'matched_desired', JSON.stringify(unchanged));

  f.post.content.raw = f.post.content.raw.replaceAll('\u00a0', '&nbsp;');
  const recovered = await f.call('recover', { target: { site_url: target.site_url, user_id: 5 }, receipt: saved.receipt });
  assert.equal(recovered.error, 'saved_record_different', JSON.stringify(recovered));
  assert.equal(recovered.outcome, 'different');
  assert.equal(recovered.persistence, 'different');
  assert.equal(f.saves, 1);
});

test('string attributes compare exactly regardless of their HTML or rich-text source', async () => {
  for (const source of ['html', 'rich-text']) {
    const f = fixture();
    f.registrations['example/card'].attributes.note = { type: 'string', source };
    const parse = f.window.wp.blocks.parse;
    f.window.wp.blocks.parse = (text) => parse(text).map((block) => ({ ...block,
      attributes: block.attributes.note ? { ...block.attributes, note: 'Every&nbsp;Room' } : block.attributes }));
    const inserted = await f.edit([{ op: 'insert', block: { name: 'example/card', attributes: { note: 'Every\u00a0Room' } } }]);
    assert.equal(inserted.error, 'serialization_mismatch', JSON.stringify(inserted));
    assert.equal(inserted.editor_result, 'not_applied');
    assert.equal(f.dirty, false);
  }
});

test('rich-text projection still refuses changed text, markup, spaces, and ordinary attributes', async () => {
  for (const replacement of ['Every Room', 'EveryRoom', 'Every&nbsp;<strong>Room</strong>', 'Every&nbsp;Other']) {
    const f = fixture();
    const parse = f.window.wp.blocks.parse;
    f.window.wp.blocks.parse = (text) => parse(text).map((block) => ({ ...block,
      attributes: block.attributes.content?.includes('Every') ? { ...block.attributes, content: replacement } : block.attributes }));
    const result = await f.edit([{ op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'Every&nbsp;Room' } } }]);
    assert.equal(result.error, 'serialization_mismatch', JSON.stringify(result));
    assert.equal(result.editor_result, 'not_applied');
    assert.equal(f.dirty, false);
  }

  const f = fixture();
  f.registrations['example/card'].attributes.note = { type: 'string' };
  const parse = f.window.wp.blocks.parse;
  f.window.wp.blocks.parse = (text) => parse(text).map((block) => ({ ...block,
    attributes: block.attributes.note ? { ...block.attributes, note: 'Every&nbsp;Room' } : block.attributes }));
  const result = await f.edit([{ op: 'insert', block: { name: 'example/card', attributes: { note: 'Every\u00a0Room' } } }]);
  assert.equal(result.error, 'serialization_mismatch', JSON.stringify(result));
  assert.equal(result.editor_result, 'not_applied');
});

test('removal inside an open pattern ignores disabled ancestors outside its editing context', async () => {
  const f = fixture();
  f.registrations['core/group'].attributes.metadata = { type: 'object' };
  const empty = { name: 'core/group', attributes: {}, clientId: 'empty', isValid: true, innerBlocks: [] };
  const section = { name: 'core/group', attributes: { metadata: { patternName: 'fixture/section' } },
    clientId: 'section', isValid: true, innerBlocks: [empty] };
  f.blocks = [{ name: 'core/group', attributes: {}, clientId: 'wrapper', isValid: true, innerBlocks: [section] }];
  f.syncContent();
  const store = f.window.wp.data.select('core/block-editor');
  store.getBlockEditingMode = (id) => id === 'wrapper' ? 'disabled' : 'default';
  await f.call('connect');
  const read = await f.call('read', { blocks: { client_id: 'empty' } });
  assert.equal(read.blocks[0].editable, true);
  assert.equal(read.blocks[0].removable, true);
  const removed = await f.call('edit', { edits: [{ op: 'remove', client_id: 'empty' }] });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(f.blocks[0].innerBlocks[0].innerBlocks.length, 0);
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

function patternSectionFixture() {
  const f = fixture();
  f.registrations['core/group'].attributes.metadata = { type: 'object' };
  const group = (clientId, attributes, innerBlocks) => ({
    name: 'core/group', clientId, attributes, innerBlocks, isValid: true,
  });
  f.blocks = [group('wrapper', {}, [group('section', { metadata: { patternName: 'fixture/section' } }, [
    group('empty', {}, []), ...f.blocks,
  ])]), group('second', { metadata: { patternName: 'fixture/second' } }, [])];
  f.syncContent();
  const store = f.window.wp.data.select('core/block-editor');
  const actions = f.window.wp.data.dispatch('core/block-editor');
  f.openSection = null;
  f.sectionOpens = [];
  store.__unstableGetTemporarilyEditingAsBlocks = () => f.openSection;
  store.getBlockEditingMode = (id) => {
    if (f.openSection) {
      return (f.openSection === 'section' && ['section', 'empty', 'a', 'b'].includes(id)) ||
        id === f.openSection ? 'default' : 'disabled';
    }

    return ['empty', 'a', 'b'].includes(id) ? 'contentOnly' : 'default';
  };

  actions.__unstableSetTemporarilyEditingAsBlocks = (id) => {
    f.sectionOpens.push(id);
    f.openSection = id;
  };

  const dispatch = f.window.wp.data.dispatch;
  f.window.wp.data.dispatch = (name) => name === 'core/block-editor' ? actions : dispatch(name);

  return f;
}

test('edit opens a requested section and removes its empty group in both workflows', async () => {
  for (const workflow of ['attached', 'background']) {
    const f = patternSectionFixture();
    await f.call('connect', { workflow });
    const result = await f.call('edit', { open_pattern_section: { section_client_id: 'section' },
      edits: [{ op: 'remove', client_id: 'empty' }] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.sectionOpens, ['section']);
    assert.deepEqual(copy(result.pattern_section), { section_client_id: 'section', state_available: true });
    assert.equal(f.blocks[0].innerBlocks[0].innerBlocks.some((block) => block.clientId === 'empty'), false);
    assert.equal(f.saves, 0);
    assert.equal((await f.call('status')).pattern_section.section_client_id, 'section');
  }
});

test('opening a pattern section does not change content before a union refusal', async () => {
  const f = patternSectionFixture();
  f.registrations['example/card'].attributes.config = { type: ['object', 'array'] };
  f.blocks[0].innerBlocks[0].innerBlocks[2].attributes.config = [];
  f.syncContent();
  const original = copy(f.blocks);
  await f.call('connect', { workflow: 'attached' });
  const result = await f.call('edit', {
    open_pattern_section: { section_client_id: 'section' },
    edits: [{ op: 'update', client_id: 'b', attributes: { variant: 'accent' } }],
  });
  assert.equal(result.error, 'ambiguous_union_attribute', JSON.stringify(result));
  assert.equal(result.editor_result, 'not_applied');
  assert.deepEqual(f.blocks, original);
  assert.equal(f.dirty, false);
  assert.equal(f.saves, 0);
});

test('explicit content-only template locks survive native section opening', async () => {
  for (const open of [false, true]) {
    const f = patternSectionFixture();
    f.registrations['core/paragraph'].attributes.content.role = 'content';
    f.registrations['core/group'].attributes.templateLock = { type: 'string' };
    const section = f.blocks[0].innerBlocks[0];
    const paragraph = section.innerBlocks[1];
    section.innerBlocks[1] = { name: 'core/group', clientId: 'locked-container',
      attributes: { templateLock: 'contentOnly' }, isValid: true, innerBlocks: [paragraph] };
    f.syncContent();
    await f.call('connect', { workflow: 'attached' });
    const option = open ? { open_pattern_section: { section_client_id: 'section' } } : {};
    const refused = await f.call('edit', { ...option,
      edits: [{ op: 'update', client_id: 'a', attributes: { dropCap: true } }] });
    assert.equal(refused.error, 'block_not_editable', JSON.stringify(refused));
    assert.equal(refused.diagnostics.reason, 'content_only');
    assert.equal(refused.diagnostics.editing_mode, open ? 'default' : 'contentOnly');
    assert.equal(f.dirty, false);
    const read = await f.call('read', { blocks: { client_id: 'a' } });
    assert.equal(read.blocks[0].editable, false);
    assert.equal(read.blocks[0].reason, 'content_only');
    const content = await f.call('edit', { edits: [{ op: 'update', client_id: 'a',
      attributes: { content: 'Content role remains editable.' } }] });
    assert.equal(content.ok, true, JSON.stringify(content));
    const removed = await f.call('edit', { edits: [{ op: 'remove', client_id: 'a' }] });
    assert.equal(removed.error, 'template_locked', JSON.stringify(removed));
  }
});

test('an explicit content-only template lock never enables a natively disabled block', async () => {
  const f = patternSectionFixture();
  f.registrations['core/paragraph'].attributes.content.role = 'content';
  f.blocks[0].attributes.templateLock = 'contentOnly';
  f.openSection = 'second';
  f.syncContent();
  await f.call('connect');
  const refused = await f.call('edit', { edits: [{ op: 'update', client_id: 'a',
    attributes: { content: 'Still disabled.' } }] });
  assert.equal(refused.error, 'block_not_editable', JSON.stringify(refused));
  assert.equal(refused.diagnostics.reason, 'content_only');
  assert.equal(refused.diagnostics.editing_mode, 'disabled');
  assert.equal(f.dirty, false);
});

test('edit never opens a section without the explicit option', async () => {
  const f = patternSectionFixture();
  await f.call('connect', { workflow: 'attached' });
  const refused = await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { dropCap: true } }] });
  assert.equal(refused.error, 'block_not_editable');
  assert.equal(refused.diagnostics.reason, 'pattern_section');
  assert.match(refused.hint, /open_pattern_section/);
  assert.match(refused.hint, /raw CDP/);
  assert.deepEqual(f.sectionOpens, []);
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

test('missing public section capabilities refuse before editing and name the user action', async () => {
  for (const capability of ['__unstableSetTemporarilyEditingAsBlocks', '__unstableGetTemporarilyEditingAsBlocks']) {
    const f = patternSectionFixture();
    const object = capability.startsWith('__unstableSet') ? f.window.wp.data.dispatch('core/block-editor')
      : f.window.wp.data.select('core/block-editor');
    delete object[capability];
    await f.call('connect');
    const result = await f.call('edit', { open_pattern_section: { section_client_id: 'section' },
      edits: [{ op: 'remove', client_id: 'empty' }] });
    assert.equal(result.error, 'pattern_section_open_unavailable', JSON.stringify(result));
    assert.equal(result.diagnostics.capability, capability);
    assert.match(result.hint, /user.*Edit pattern/);
    assert.deepEqual(f.sectionOpens, []);
    assert.equal(f.dirty, false);
  }
});

test('section switching is reported even if later planning refuses', async () => {
  const f = patternSectionFixture();
  f.openSection = 'second';
  await f.call('connect', { workflow: 'attached' });
  const failed = await f.call('edit', { open_pattern_section: { section_client_id: 'section' },
    edits: [{ op: 'update', client_id: 'a', attributes: { unknown: true } }] });
  assert.equal(failed.error, 'unsupported_attribute', JSON.stringify(failed));
  assert.equal(failed.editor_result, 'not_applied');
  assert.equal(failed.pattern_section.section_client_id, 'section');
  assert.deepEqual(f.sectionOpens, ['section']);
  assert.equal(f.dirty, false);
  const applied = await f.call('edit', { open_pattern_section: { section_client_id: 'second' },
    edits: [{ op: 'update', client_id: 'second', attributes: { className: 'changed' } }] });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.pattern_section.section_client_id, 'second');
});

test('an action that does not open the requested section refuses with observed state', async () => {
  const f = patternSectionFixture();
  f.window.wp.data.dispatch('core/block-editor').__unstableSetTemporarilyEditingAsBlocks = () => {};

  await f.call('connect');
  const result = await f.call('edit', { open_pattern_section: { section_client_id: 'section' },
    edits: [{ op: 'remove', client_id: 'empty' }] });
  assert.equal(result.error, 'pattern_section_not_opened', JSON.stringify(result));
  assert.equal(result.diagnostics.requested_section_client_id, 'section');
  assert.equal(result.pattern_section.section_client_id, null);
  assert.equal(result.editor_result, 'not_applied');
  assert.equal(f.dirty, false);
});

test('section opening and its edits respect post locks, edit locks, template locks, and identity', async () => {
  for (const restriction of ['post', 'edit', 'ancestor_template', 'section_template', 'native_template', 'not_section']) {
    const f = patternSectionFixture();
    await f.call('connect');
    const store = f.window.wp.data.select('core/block-editor');

    if (restriction === 'post') f.locked = true;

    if (restriction === 'edit') store.canEditBlock = (id) => id !== 'section';

    if (restriction === 'ancestor_template') f.blocks[0].attributes.templateLock = 'all';

    if (restriction === 'section_template') f.blocks[0].innerBlocks[0].attributes.templateLock = 'contentOnly';

    if (restriction === 'native_template') store.getTemplateLock = (id) => id === 'section' ? 'all' : false;
    const result = await f.call('edit', { open_pattern_section: { section_client_id: restriction === 'not_section' ? 'empty' : 'section' },
      edits: [{ op: 'remove', client_id: 'empty' }] });
    const expected = restriction === 'post' ? 'post_locked' : restriction === 'edit' ? 'block_locked' :
      restriction === 'not_section' ? 'pattern_section_required' : 'template_locked';
    assert.equal(result.error, expected, JSON.stringify(result));
    assert.deepEqual(f.sectionOpens, restriction.includes('template') ? ['section'] : []);
    assert.equal(f.dirty, false);
  }
});

test('a block inside an unsynced pattern section names the section that limits it', async () => {
  const f = fixture();
  f.registrations['core/group'].attributes.metadata = { type: 'object' };
  f.blocks = [{ name: 'core/group', attributes: { metadata: { patternName: 'theme/card-split', name: 'Card (Split)' } },
    clientId: 'section', isValid: true, innerBlocks: f.blocks }];
  f.syncContent();
  await f.call('connect');
  f.mode = 'contentOnly';

  const read = await f.call('read', { blocks: { client_id: 'section', depth: 1 } });
  const child = read.blocks.find((block) => block.client_id === 'a');
  assert.deepEqual([child.editable, child.reason, child.section_client_id], [false, 'pattern_section', 'section']);
  const section = read.blocks.find((block) => block.client_id === 'section');
  assert.deepEqual([section.editable, section.reason], [false, 'content_only']);

  const refused = await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { content: 'Changed' } }] });
  assert.equal(refused.error, 'block_not_editable', JSON.stringify(refused));
  assert.deepEqual([refused.diagnostics.reason, refused.diagnostics.section_client_id, refused.diagnostics.editing_mode],
    ['pattern_section', 'section', 'contentOnly']);
  assert.match(refused.hint, /Edit pattern/);
  assert.equal(f.dirty, false);

  // Gutenberg still lets a user change role: content attributes there.
  f.registrations['core/paragraph'].attributes.content.role = 'content';
  const content = await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { content: 'Changed' } }] });
  assert.equal(content.ok, true, JSON.stringify(content));
  assert.equal(String(f.blocks[0].innerBlocks[0].attributes.content), 'Changed');

  const style = await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { dropCap: true } }] });
  assert.equal(style.error, 'block_not_editable', JSON.stringify(style));

  f.mode = 'disabled';
  const disabled = await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { content: 'Again' } }] });
  assert.equal(disabled.error, 'block_not_editable', JSON.stringify(disabled));
  assert.equal(disabled.diagnostics.reason, 'pattern_section');
});

test('client ID selectors retain native edit policy and exact block-name checks', async () => {
  const f = fixture();
  f.disabled = true;
  const blocked = await f.edit([{ client_id: 'a', name: 'core/paragraph', attributes: { content: 'Changed' } }]);
  assert.equal(blocked.error, 'block_not_editable', JSON.stringify(blocked));
  f.disabled = false;
  const wrongName = await f.edit([{ client_id: 'a', name: 'core/group', attributes: { className: 'Changed' } }]);
  assert.equal(wrongName.error, 'block_mismatch', JSON.stringify(wrongName));
  assert.deepEqual(copy(wrongName.diagnostics.target_path), [0]);
  assert.equal(wrongName.diagnostics.expected_name, 'core/group');
  assert.equal(wrongName.diagnostics.actual_name, 'core/paragraph');
  assert.equal(f.dirty, false);
});

test('same-container moves use destination indexes after removal, including append', async () => {
  const f = fixture();

  const plan = await f.edit([
    { op: 'move', path: [0], name: 'core/paragraph', parent: [], index: 2 },
    { op: 'move', path: [0], name: 'example/card', parent: [] },
  ]);

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await f.save()).persistence, 'verified');
  assert.deepEqual(f.blocks.map((block) => block.attributes.content || block.attributes.variant), ['Preserve', 'Before', 'plain']);
});

test('removing every block can save an empty document', async () => {
  const f = fixture();

  const plan = await f.edit([
    { op: 'remove', path: [2], name: 'core/paragraph' },
    { op: 'remove', path: [1], name: 'example/card' },
    { op: 'remove', path: [0], name: 'core/paragraph' },
  ]);

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.post.content.raw, '');
});

for (const [name, mutate, edits, expected] of [
  ['template lock', (f) => { f.templateLock = 'all'; }, [{ op: 'insert', block: { name: 'core/paragraph' } }], 'template_locked'],
  ['removal lock', (f) => { f.removeLocked = true; }, [{ op: 'remove', path: [0], name: 'core/paragraph' }], 'block_locked'],
  ['move lock', (f) => { f.moveLocked = true; }, [{ op: 'move', path: [0], name: 'core/paragraph', index: 2 }], 'block_locked'],
  ['missing registration', () => {}, [{ op: 'insert', block: { name: 'plugin/unknown' } }], 'block_unregistered'],
  ['unregistered attribute', () => {}, [{ op: 'insert', block: { name: 'core/paragraph', attributes: { nope: 1 } } }], 'unsupported_attribute'],
  ['child parent requirement', (f) => { f.registrations['example/card'].parent = ['core/group']; }, [{ op: 'insert', block: { name: 'example/card' } }], 'invalid_nesting'],
  ['unsupported structural document', (f) => { f.blocks.push({ name: 'core/html', clientId: 'html', attributes: { content: 'Raw' }, innerBlocks: [] }); }, [{ op: 'insert', block: { name: 'core/paragraph' } }], 'unsupported_structural_edit'],
  ['bound attribute', (f) => { f.blocks[0].attributes.metadata = { bindings: { content: { source: 'core/post-meta' } } }; }, changes, 'bound_block_unsupported'],
  ['prototype key', () => {}, [{ op: 'insert', block: { name: 'core/group', attributes: { style: JSON.parse('{"__proto__":{"polluted":true}}') } } }], 'unsupported_attribute'],
]) {
  test(`structural edits refuse ${name}`, async () => {
    const f = fixture();
    mutate(f);
    f.syncContent();
    const result = await f.edit(edits);
    assert.equal(result.error, expected, JSON.stringify(result));
    assert.equal(f.dirty, false);
    assert.equal(f.saves, 0);
  });
}

test('registered patterns, variations and styles use native catalogs', async () => {
  const f = fixture();
  f.patterns = [{ name: 'example/section', title: 'Section', content: f.window.wp.blocks.serialize([f.blocks[0]]) }];
  f.registrations['core/group'].styles = [{ name: 'bordered', label: 'Bordered' }];
  f.registrations['core/group'].variations = [{ name: 'stack', attributes: { layout: { type: 'flex', orientation: 'vertical' } }, innerBlocks: [['core/paragraph', { content: 'Variation child' }]] }];
  await f.call('connect', { attribute_guide: { name: 'core/group' }, patterns: true });

  const plan = await f.call('edit', { edits: [
    { op: 'insert_pattern', pattern: 'example/section', },
    { op: 'insert_variation', name: 'core/group', variation: 'stack', attributes: { className: 'keep-this' } },
    { op: 'set_block_style', path: [4], name: 'core/group', style: 'bordered', },
  ] });

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks[4].attributes.className, 'keep-this is-style-bordered');
  assert.equal(f.blocks[4].innerBlocks[0].attributes.content, 'Variation child');
});

test('markup insertion expands into native block inputs and saves once', async () => {
  const f = fixture();
  await f.call('connect');
  const original = f.post.content.raw;
  const edited = await f.call('edit', { edits: [{ op: 'insert', markup: f.window.wp.blocks.serialize([f.blocks[1]]), index: 1 }] });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(f.dirty, true);
  assert.equal(f.post.content.raw, original);
  assert.equal(f.blocks.length, 4);
  assert.equal(f.blocks[1].attributes.variant, 'plain');
  assert.equal((await f.save()).persistence, 'verified');
});

test('markup insertion normalizes native rich text before attribute validation', async () => {
  const f = fixture();
  await f.call('connect');
  const native = f.window.wp.blocks.parse;
  f.window.wp.blocks.parse = text => native(text).map(block => {
    if (block.name !== 'core/paragraph') return block;
    const content = block.attributes.content;

    return { ...block, attributes: { ...block.attributes, lock: undefined, retiredAttribute: undefined, content: { toString: () => content } } };
  });
  const edited = await f.call('edit', { edits: [{ op: 'insert', markup: f.window.wp.blocks.serialize([f.blocks[0]]) }] });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(f.blocks.at(-1).attributes.content, 'Before');
  assert.equal(Object.hasOwn(f.blocks.at(-1).attributes, 'lock'), false);
  assert.equal(f.saves, 0);
});

test('attribute schemas enforce item types, nested required fields, and numeric bounds', async () => {
  for (const value of [{ counts: ['wrong'] }, { counts: [1], requiredValue: 0 }, { counts: [1], requiredValue: 2, unexpected: true }]) {
    const f = fixture();
    f.registrations['example/card'].attributes.options = { type: 'object', required: ['counts', 'requiredValue'], additionalProperties: false,
      properties: { counts: { type: 'array', items: { type: 'integer' } }, requiredValue: { type: 'integer', minimum: 1 } } };
    const result = await f.edit([{ op: 'update', path: [1], name: 'example/card', attributes: { options: value } }]);
    assert.equal(result.error, 'unsupported_attribute_type', JSON.stringify(result));
    assert.equal(f.saves, 0);
  }
});

test('moving a container into its own descendant is rejected before mutation', async () => {
  const f = fixture();
  f.blocks[0] = { name: 'core/group', attributes: {}, clientId: 'outer', innerBlocks: [{ name: 'core/group', attributes: {}, clientId: 'inner', innerBlocks: [] }] };
  f.syncContent();
  assert.equal((await f.edit([{ op: 'move', path: [0], name: 'core/group', parent: [0, 0] }])).error, 'invalid_move');
  assert.equal(f.dirty, false);
});

test('an inserted block can move into an existing parent once its native ID is live', async () => {
  const f = fixture();
  f.blocks[1] = { name: 'core/group', attributes: {}, clientId: 'group', innerBlocks: [] };
  f.syncContent();
  const store = f.window.wp.data.select('core/block-editor');
  const find = (list) => list.flatMap((block) => [block, ...find(block.innerBlocks || [])]);
  store.canInsertBlocks = (ids) => ids.every((id) => find(f.blocks).some((block) => block.clientId === id));

  const plan = await f.edit([
    { op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'New child' } }, index: 0 },
    { op: 'move', path: [0], name: 'core/paragraph', parent: [2] },
  ]);

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks[1].innerBlocks[0].attributes.content, 'New child');
  assert.equal(f.saves, 1);
});

test('template lock changes and structural edits of bound descendants refuse before mutation', async () => {
  const locked = fixture();
  locked.registrations['core/group'].attributes.templateLock = { type: ['string', 'boolean'] };
  locked.blocks[0] = { name: 'core/group', clientId: 'group', attributes: { templateLock: 'all' }, innerBlocks: [] };
  locked.syncContent();
  assert.equal((await locked.edit([{ op: 'update', path: [0], name: 'core/group', attributes: { templateLock: false } }])).error, 'unsupported_attribute');

  for (const edit of [
    { op: 'remove', path: [0], name: 'core/group' },
    { op: 'move', path: [0], name: 'core/group', index: 2 },
    { op: 'replace', path: [0], name: 'core/group', block: { name: 'core/paragraph', attributes: { content: 'Replacement' } } },
  ]) {
    const f = fixture();
    f.blocks[0].attributes.metadata = { bindings: { content: { source: 'core/post-meta' } } };
    f.blocks[0] = { name: 'core/group', clientId: 'group', attributes: {}, innerBlocks: [f.blocks[0]] };
    f.syncContent();
    assert.equal((await f.edit([edit])).error, 'bound_block_unsupported');
    assert.equal(f.dirty, false);
    assert.equal(f.saves, 0);
  }
});

test('native transient block and selection edits do not block a content save', async () => {
  const f = fixture();
  const dispatch = f.window.wp.data.dispatch;
  f.window.wp.data.dispatch = (name) => {
    const actions = dispatch(name);

    if (name !== 'core/block-editor') return actions;

    return { ...actions, async updateBlockAttributes(id, attributes) {
      await actions.updateBlockAttributes(id, attributes);
      f.postEdits = { content: () => f.window.wp.blocks.serialize(f.blocks), blocks: f.blocks, selection: {} };
    } };
  };

  assert.equal((await f.edit()).ok, true);
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.saves, 1);
});

test('nested insertion loads the stalled native canvas and waits for its actual policies', async () => {
  const f = fixture();
  f.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, innerBlocks: [] };
  f.syncContent();
  const original = f.post.content.raw;
  f.missingContext = true;
  f.canvasHtml = '<!doctype html><html><body>Native canvas fixture</body></html>';
  f.frame = { src: 'blob:https://example.test/native-canvas', isConnected: true,
    contentDocument: { URL: 'about:blank', readyState: 'complete', body: { childElementCount: 0 } },
    get srcdoc() { return this.html ?? ''; },
    set srcdoc(value) {
      this.html = value;
      setTimeout(() => { f.missingContext = false; }, 30);
    } };
  const store = f.window.wp.data.select('core/block-editor');
  const nativeInsert = store.canInsertBlockType;
  store.canInsertBlockType = (name, parent) => !f.missingContext && nativeInsert(name, parent);
  const plan = await f.edit([{ op: 'insert', parent: [1], block: { name: 'core/paragraph', attributes: { content: 'Nested' } } }]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(f.frame.srcdoc, f.canvasHtml);
  assert.equal(f.blobReads, 1);
  assert.equal(f.post.content.raw, original);
  assert.equal(f.dirty, true);
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks[1].innerBlocks[0].attributes.content, 'Nested');
  assert.equal(f.blobReads, 1);
});

test('inspection and root edits do not load or wait for an unavailable canvas', async () => {
  const f = fixture();
  f.missingContext = true;
  delete f.window.wp.element;
  f.onSelect = () => { throw new Error('A detached edit must not change selection'); };

  const plan = await f.edit([
    ...changes,
    { op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'New root' } } },
    { op: 'move', path: [3], name: 'core/paragraph', index: 1 },
  ]);

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.canvasReads ?? 0, 0);
  assert.equal(f.blobReads ?? 0, 0);
});

test('ready container policies avoid canvas access and retain native insertion refusal', async () => {
  const f = fixture();
  f.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, innerBlocks: [] };
  f.syncContent();
  f.insertLocked = true;
  const result = await f.edit([{ op: 'insert', block: { name: 'core/paragraph' }, parent: [1] }]);
  assert.equal(result.error, 'insertion_refused');
  assert.equal(f.canvasReads ?? 0, 0);
  assert.equal(f.blobReads ?? 0, 0);
  assert.equal(f.dirty, false);
});

test('waiting for native settings does not rewrite an already loaded or foreign canvas', async () => {
  for (const [src, documentUrl] of [
    ['blob:https://example.test/canvas', 'blob:https://example.test/canvas'],
    ['blob:https://another.test/canvas', 'about:blank'],
  ]) {
    const f = fixture();
    f.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, innerBlocks: [] };
    f.syncContent();
    f.missingContext = true;
    f.frame = { src, srcdoc: '', contentDocument: { URL: documentUrl, readyState: 'complete', body: { childElementCount: 0 } } };
    setTimeout(() => { f.missingContext = false; }, 30);
    const result = await f.edit([{ op: 'insert', block: { name: 'core/paragraph' }, parent: [1] }]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.frame.srcdoc, '');
    assert.equal(f.blobReads ?? 0, 0);
  }
});

test('native rendering that changes content invalidates preparation without saving', async () => {
  const f = fixture();
  f.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, innerBlocks: [] };
  f.syncContent();
  f.missingContext = true;
  setTimeout(() => { f.blocks[0].attributes.content = 'Changed by native rendering'; f.missingContext = false; }, 30);
  const result = await f.edit([{ op: 'insert', block: { name: 'core/paragraph' }, parent: [1] }]);
  assert.equal(result.error, 'editor_content_changed');
  assert.deepEqual(copy(result.diagnostics.mismatches.blocks), [{
    path: [0], properties: ['attributes.content'], truncated: false,
    expected_name: 'core/paragraph', actual_name: 'core/paragraph',
  }]);
  assert.match(result.hint, /diagnostics\.mismatches\.blocks/);
  assert.match(result.hint, /view/);
  assert.match(result.hint, /read/);
  assert.equal(outsideDebug(result).includes('Changed by native rendering'), false);
  assert.equal(f.blocks[0].attributes.content, 'Changed by native rendering');
  assert.equal(f.saves, 0);
});

test('planning reports an existing empty container gaining native template children', async () => {
  const f = fixture();
  f.registrations['core/buttons'] = { name: 'core/buttons', attributes: {} };
  f.registrations['core/button'] = { name: 'core/button', attributes: { text: { type: 'string' } } };
  f.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, innerBlocks: [
    { name: 'core/buttons', clientId: 'buttons', attributes: {}, innerBlocks: [] },
  ] };
  f.syncContent();
  f.missingContext = true;
  setTimeout(() => {
    f.blocks[1].innerBlocks[0].innerBlocks.push({
      name: 'core/button', clientId: 'placeholder', attributes: { text: 'Private placeholder' }, innerBlocks: [],
    });
    f.missingContext = false;
  }, 30);
  const result = await f.edit([{ op: 'insert', block: { name: 'core/paragraph' }, parent: [1] }]);
  assert.equal(result.error, 'editor_content_changed', JSON.stringify(result));
  assert.equal(result.editor_result, 'not_applied');
  assert.equal(result.persistence, 'not_attempted');
  assert.deepEqual(copy(result.diagnostics.mismatches), {
    blocks: [
      { path: [1, 0], properties: ['children'], truncated: false, expected_name: 'core/buttons', actual_name: 'core/buttons' },
      { path: [1, 0, 0], properties: ['name', 'attributes', 'support', 'client_id', 'children', 'reason'], truncated: false, actual_name: 'core/button' },
    ],
    truncated: false,
  });
  assert.equal(outsideDebug(result).includes('Private placeholder'), false);
  assert.equal(f.blocks[1].innerBlocks.length, 1);
  assert.equal(f.saves, 0);
});

test('planning conflict diagnostics bound blocks and properties and omit non-identifier keys', async () => {
  const f = fixture();
  f.blocks = Array.from({ length: 25 }, (_, index) => ({
    name: 'core/group', clientId: `group-${index}`, attributes: { style: {} }, innerBlocks: [],
  }));
  f.syncContent();
  f.missingContext = true;
  // Connecting 25 groups can outlast the timer under load, so connect first.
  assert.equal((await f.call('connect')).ok, true);
  setTimeout(() => {
    for (const block of f.blocks) {
      block.attributes.style['https://private.example/content'] = 'Private value';
      Object.assign(block.attributes.style, Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`field${index}`, 'Private value'])));
    }

    f.missingContext = false;
  }, 30);
  const result = await f.edit([{ op: 'insert', block: { name: 'core/paragraph' }, parent: [0] }]);
  assert.equal(result.error, 'editor_content_changed');
  const { blocks, truncated } = result.diagnostics.mismatches;
  assert.equal(blocks.length, 20);
  assert.equal(truncated, true);
  assert.equal(blocks.every(block => block.properties.length === 20 && block.truncated), true);
  assert.equal(blocks[0].properties[0], 'attributes.style.<key>');
  assert.equal(outsideDebug(result).includes('Private value'), false);
  assert.equal(outsideDebug(result).includes('private.example'), false);
  assert.equal(f.blocks[0].innerBlocks.length, 0);
  assert.equal(f.saves, 0);
});

test('planning names removed blocks and replacements at their baseline paths', async () => {
  const f = fixture();
  f.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, innerBlocks: [] };
  f.syncContent();
  f.missingContext = true;
  setTimeout(() => {
    f.blocks[0] = { name: 'example/card', clientId: 'replacement', attributes: { variant: 'plain' }, innerBlocks: [] };
    f.blocks.pop();
    f.missingContext = false;
  }, 30);
  const result = await f.edit([{ op: 'insert', block: { name: 'core/paragraph' }, parent: [1] }]);
  assert.equal(result.error, 'editor_content_changed');
  const [replaced, removed] = result.diagnostics.mismatches.blocks;
  assert.deepEqual(copy(replaced.path), [0]);
  assert.equal(replaced.expected_name, 'core/paragraph');
  assert.equal(replaced.actual_name, 'example/card');
  assert.ok(replaced.properties.includes('name'));
  assert.ok(replaced.properties.includes('client_id'));
  assert.deepEqual(copy(removed.path), [2]);
  assert.equal(removed.expected_name, 'core/paragraph');
  assert.equal(removed.actual_name, undefined);
  assert.equal(f.blocks[1].innerBlocks.length, 0);
  assert.equal(f.saves, 0);
});

test('native preparation seals generated attributes before save without replaying insertion', async () => {
  const f = fixture();
  f.registrations['example/initialized'] = { name: 'example/initialized', attributes: {
    query: { type: 'object' }, generatedId: { type: 'number' },
  } };
  const dispatch = f.window.wp.data.dispatch;
  let insertions = 0;
  f.window.wp.data.dispatch = (name) => {
    const actions = dispatch(name);

    return name !== 'core/block-editor' ? actions : { ...actions, insertBlocks(...args) {
      insertions++;
      actions.insertBlocks(...args);
      setTimeout(() => {
        const block = f.blocks.at(-1);
        block.attributes.generatedId = 17;
        block.attributes.query.excludeCurrent = null;
      }, 30);
    } };
  };

  const original = f.post.content.raw;
  const plan = await f.edit([{ op: 'insert', block: { name: 'example/initialized', attributes: { query: { perPage: 4 } } } }]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(f.blocks.at(-1).attributes.generatedId, 17);
  assert.equal(f.post.content.raw, original);
  assert.equal(f.autosaveLocked, true);
  assert.equal(f.saves, 0);
  f.interruptSave = true;
  assert.equal((await f.save()).persistence, 'uncertain');
  assert.equal(insertions, 1);
  delete f.window.__blockwork_editor;
});

test('native preparation waits for WordPress resolvers before recording delayed generated data', async () => {
  const f = fixture();
  f.registrations['example/card'].attributes.generatedId = { type: 'number' };
  f.afterInsert = () => {
    f.resolving = true;
    setTimeout(() => {
      f.blocks.at(-1).attributes.generatedId = 23;
      f.resolving = false;
    }, 180);
  };

  const plan = await f.edit([{ op: 'insert', block: { name: 'example/card', attributes: { variant: 'plain' } } }]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(f.blocks.at(-1).attributes.generatedId, 23);
  assert.equal((await f.save()).persistence, 'verified');
});

for (const [name, mutate] of [
  ['requested attribute', (f) => { f.blocks.at(-1).attributes.variant = 'accent'; }],
  ['existing sibling', (f) => { f.blocks[0].attributes.content = 'Unexpected'; }],
  ['structure', (f) => { f.blocks.at(-1).innerBlocks.push(copy(f.blocks[0])); }],
  ['unregistered data', (f) => { f.blocks.at(-1).attributes.unknown = true; }],
]) {
  test(`native initialization refuses changes to ${name} without erasing foreign edits`, async () => {
    const f = fixture();
    const original = f.post.content.raw;
    f.afterInsert = () => { mutate(f); };

    const plan = await f.edit([{ op: 'insert', block: { name: 'example/card', attributes: { variant: 'plain' } } }]);
    assert.equal(plan.ok, false);

    assert.equal(plan.editor_result, 'partial');
    assert.notEqual(f.window.wp.blocks.serialize(f.blocks), original);

    if (name === 'unregistered data') assert.equal(f.blocks.at(-1).attributes.unknown, true);

    assert.equal(f.saves, 0);
  });
}

for (const target of ['existing', 'inserted']) {
  test(`native preparation protects nested ${target} values from reference mutation`, async () => {
    const f = fixture();
    f.registrations['example/card'].attributes.options = { type: 'object' };
    f.blocks[1].attributes.options = { color: 'blue' };
    f.syncContent();
    const dispatch = f.window.wp.data.dispatch;
    f.window.wp.data.dispatch = (name) => {
      const actions = dispatch(name);

      return name !== 'core/block-editor' ? actions : { ...actions, insertBlocks(blocks) {
        f.blocks.push(...blocks);
        f.dirty = true;
        const block = target === 'existing' ? f.blocks[1] : f.blocks.at(-1);
        block.attributes.options.color = 'red';
      } };
    };

    const plan = await f.edit([{ op: 'insert', block: { name: 'example/card', attributes: { options: { color: 'blue' } } } }]);
    assert.equal(plan.ok, false, JSON.stringify(plan));
    assert.equal(plan.editor_result, 'partial');
    assert.equal((target === 'existing' ? f.blocks[1] : f.blocks.at(-1)).attributes.options.color, 'red');
    assert.equal(f.saves, 0);
  });
}

test('native insertion preserves an unrelated container that disallows new children', async () => {
  const f = fixture();
  f.blocks[1] = { name: 'core/group', attributes: {}, clientId: 'blocked-parent', innerBlocks: [copy(f.blocks[2])] };
  f.blocks.pop();
  f.syncContent();
  const untouched = copy(f.blocks[1]);
  const plan = await f.edit([{ op: 'insert', block: { name: 'example/card', attributes: { variant: 'plain' } } }]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await f.save()).persistence, 'verified');
  assert.deepEqual(f.blocks[1], untouched);
});

test('native preparation times out and rolls back an unresolved initialization', async () => {
  const f = fixture();
  f.resolving = true;
  const original = f.post.content.raw;
  const plan = await f.edit([{ op: 'insert', block: { name: 'example/card', attributes: { variant: 'plain' } } }]);
  assert.equal(plan.error, 'native_initialization_unsettled');
  assert.equal(plan.diagnostics.stall_ms, 5000);
  assert.equal(plan.diagnostics.stage, 'settle_initialization');
  assert.equal(plan.diagnostics.edit_index, 0);
  assert.equal(plan.diagnostics.completed_edits, 0);
  assert.equal(plan.diagnostics.core_resolving, true);
  assert.equal(plan.diagnostics.affected[0].name, 'example/card');
  assert.match(plan.diagnostics.affected[0].client_id, /\S/);
  assert.match(plan.hint, /Do not replay/);
  assert.equal(f.window.wp.blocks.serialize(f.blocks), original);
  assert.equal(f.saves, 0);
});

test('native preparation compares rich-text values with their independent string snapshots', async () => {
  const f = fixture();
  f.blocks[0].attributes.content = { toString: () => 'Before', toJSON: () => 'Before' };
  f.syncContent();
  const plan = await f.edit([{ op: 'insert', block: { name: 'example/card', attributes: { variant: 'plain' } } }]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(String(f.blocks[0].attributes.content), 'Before');
});

test('native preparation drains offscreen descendant updates and restores the selection range', async () => {
  const f = fixture();
  f.registrations['example/card'].attributes.generatedId = { type: 'number' };
  const start = { clientId: 'a', attributeKey: 'content', offset: 1 };
  const end = { clientId: 'c', attributeKey: 'content', offset: 4 };
  f.selectionStart = copy(start);
  f.selectionEnd = copy(end);
  f.caret = -1;
  const visited = new Set();
  f.onSelect = (id) => {
    visited.add(id);
    const child = f.blocks.at(-1).innerBlocks[0];

    if (id === child.clientId) child.attributes.generatedId = 42;
  };

  const plan = await f.edit([{ op: 'insert', block: { name: 'core/group', inner_blocks: [{ name: 'example/card' }] } }]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(f.blocks.at(-1).innerBlocks[0].attributes.generatedId, 42);
  assert.equal(visited.size, 2);
  assert.deepEqual(copy(f.selectionStart), start);
  assert.deepEqual(copy(f.selectionEnd), end);
  assert.equal(f.caret, -1);
  assert.equal((await f.save()).persistence, 'verified');
});

test('native Query preparation awaits its exact dependency even before global resolution starts', async () => {
  const f = fixture();
  f.registrations['core/query'] = { name: 'core/query', attributes: { generatedId: { type: 'number' }, query: { type: 'object', default: { inherit: false, perPage: 1, excludeCurrent: null } } } };
  let settingsReady = false;
  const calls = [];
  f.resolveCanUser = async (...args) => {
    calls.push(args);

    return true;
  };

  f.resolveEntity = async (...args) => {
    calls.push(args);
    await new Promise((resolve) => setTimeout(resolve, 180));
    settingsReady = true;

    return { posts_per_page: 4 };
  };

  f.onSelect = (id) => {
    const block = f.blocks.at(-1);

    if (settingsReady && id === block.clientId) block.attributes.generatedId = 41;
  };

  const plan = await f.edit([{ op: 'insert', block: { name: 'core/query', attributes: { query: { inherit: false, perPage: 1, excludeCurrent: null } } } }]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(f.blocks.at(-1).attributes.generatedId, 41);
  assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify(['read', { kind: 'root', name: 'site' }])));
  assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify(['root', 'site'])));
  assert.equal((await f.save()).persistence, 'verified');
});

function queryFixture() {
  const f = fixture();
  f.editorSettings = { ...f.editorSettings, postsPerPage: 1 };
  f.registrations['core/query'] = { name: 'core/query', attributes: { query: { type: 'object' } } };
  f.registrations['core/post-template'] = { name: 'core/post-template', ancestor: ['core/query'], attributes: {} };
  f.queryEdit = { op: 'insert', block: { name: 'core/query', attributes: { query: {
    inherit: false, postType: 'post', perPage: 1, order: 'desc', orderBy: 'date',
  } }, inner_blocks: [{ name: 'core/post-template', inner_blocks: [
    { name: 'core/paragraph', attributes: { content: 'Template child' } },
  ] }] } };

  return f;
}

test('an existing Query retires earlier descendant render targets when its results disappear', async () => {
  const f = queryFixture();
  const query = f.window.wp.blocks.createBlock(
    'core/query',
    { query: { inherit: false, perPage: 1, excludeCurrent: null } },
    [
      f.window.wp.blocks.createBlock('core/post-template', {}, [
        f.window.wp.blocks.createBlock('core/paragraph', { content: 'Template child' }),
      ]),
    ],
  );
  f.blocks.push(query);
  f.syncContent();
  const childId = query.innerBlocks[0].innerBlocks[0].clientId;
  const visited = new Set();
  f.onSelect = (id) => visited.add(id);
  f.isRendered = (id) => id !== `block-${childId}` || !f.blocks[3].attributes.query.search;
  const result = await f.edit([
    { op: 'update', client_id: childId, attributes: { content: 'Updated template child' } },
    { op: 'update', path: [3], attributes: { query: { search: 'No matching fixture' } } },
    { op: 'insert', block: { name: 'example/card' } },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(visited.has(childId), false);
  assert.equal(
    f.blocks[3].innerBlocks[0].innerBlocks[0].attributes.content,
    'Updated template child',
  );
  assert.equal((await f.save()).persistence, 'verified');
});

test('empty Query previews refuse the whole plan before native actions in either workflow', async () => {
  for (const workflow of ['background', 'attached']) {
    const f = queryFixture();
    const original = copy(f.blocks);
    const nativeActions = [];
    const dispatch = f.window.wp.data.dispatch;
    f.window.wp.data.dispatch = name => {
      const actions = dispatch(name);

      if (name !== 'core/block-editor') return actions;

      return Object.fromEntries(Object.entries(actions).map(([key, action]) => [key, (...args) => {
        nativeActions.push(key);

        return action(...args);
      }]));
    };

    f.resolveRecords = async (kind, name, args) => {
      assert.equal(kind, 'postType'); assert.equal(name, 'post');
      assert.deepEqual(copy(args), { offset: 0, order: 'desc', orderby: 'date', per_page: 1 });

      return [];
    };

    const inspected = await f.call('connect', { workflow, unsaved_preview: workflow === 'attached' });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const edited = await f.call('edit', { edits: [...changes, f.queryEdit] });
    const refused = edited;
    assert.equal(refused.error, 'query_preview_empty', JSON.stringify(refused));
    assert.equal(refused.diagnostics.stage, 'query_preview_preflight');
    assert.equal(refused.diagnostics.edit_index, 1);
    assert.equal(refused.diagnostics.completed_edits, undefined);
    assert.deepEqual(copy(refused.diagnostics.target_path), [3, 0]);
    assert.match(refused.hint, /no results/);
    assert.match(refused.hint, /reported editor outcome and current draft/);
    assert.deepEqual(nativeActions, []);
    assert.deepEqual(f.blocks, original);
    assert.equal(f.dirty, false);
    assert.equal(f.saves, 0);

    if (workflow === 'attached') {
      assert.equal(refused.editor_result, 'not_applied');
      assert.equal(f.savingLocks.size, 1);
      assert.equal((await f.call('release')).ok, true);
      assert.equal(f.savingLocks.size, 0);
      assert.equal(f.autosaveLocks.size, 0);
    }
  }
});

test('nonempty Query previews resolve before the mutation budget and render descendants', async () => {
  const f = queryFixture();
  const visited = new Set();
  f.resolveRecords = async () => { f.elapsedMs = 6000;

 return [{ id: 19, type: 'post' }]; };

  f.onSelect = id => visited.add(id);
  const plan = await f.edit([f.queryEdit]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.ok(visited.has(f.blocks.at(-1).innerBlocks[0].innerBlocks[0].clientId));
});

test('filtered and inherited Query previews use native entity arguments', async () => {
  for (const inherit of [false, true]) {
    const f = queryFixture();
    Object.assign(f.queryEdit.block.attributes.query, { inherit, taxQuery: {
      include: { category: [3], topic: [7], unknown: [9] },
      exclude: { category: [4], topic: [] },
    } });
    f.resolveTaxonomies = async (args) => {
      assert.deepEqual(copy(args), { type: 'post', per_page: -1, context: 'view' });

      return [{ slug: 'category', rest_base: 'categories' }, { slug: 'topic', rest_base: 'topics' }];
    };

    f.resolveRecords = async (kind, name, args) => {
      assert.equal(kind, 'postType'); assert.equal(name, 'post');
      const expected = { offset: 0, order: 'desc', orderby: 'date', per_page: 1 };

      if (!inherit) Object.assign(expected, { categories: [3], topics: [7], categories_exclude: [4] });
      assert.deepEqual(copy(args), expected);

      return [{ id: 19, type: 'post' }];
    };

    const plan = await f.edit([f.queryEdit]);
    assert.equal(plan.ok, true, JSON.stringify(plan));
  }
});

test('inherited Query previews use the template slug', async () => {
  for (const [slug, expectedType, expectedArgs] of [
    ['archive-book', 'book', { postType: 'book' }],
    ['category-news', 'post', { categories: 12 }],
    ['tag-news', 'post', { tags: 12 }],
    ['taxonomy-post_format-post-format-aside', 'post', { format: 'aside' }],
  ]) {
    const f = queryFixture();
    assert.equal((await f.call('connect')).ok, true);
    const select = f.window.wp.data.select;
    f.window.wp.data.select = (name) => {
      const store = select(name);

      return name === 'core/editor' ? { ...store, getCurrentPost: () => ({ ...f.post, type: 'wp_template', slug }) } : store;
    };

    f.queryEdit.block.attributes.query.inherit = true;
    f.resolveRecords = async (kind, name, args) => {
      if (kind === 'taxonomy') {
        assert.equal(name, slug.startsWith('category-') ? 'category' : 'post_tag');
        assert.deepEqual(copy(args), { context: 'view', per_page: 1, _fields: ['id'], slug: 'news' });

        return [{ id: 12 }];
      }

      assert.equal(name, expectedType);
      assert.deepEqual(copy(args), { offset: 0, order: 'desc', orderby: 'date', per_page: 1, ...expectedArgs });

      return [{ id: 19, type: expectedType }];
    };

    const plan = await f.edit([f.queryEdit]);
    assert.equal(plan.ok, true, JSON.stringify(plan));
  }
});

test('taxonomy preview timeout reports that no native edit was applied', async () => {
  const f = queryFixture();
  let nativeMutations = 0;
  f.afterInsert = () => { nativeMutations++; };

  f.queryEdit.block.attributes.query.taxQuery = { include: { category: [3] } };
  const original = copy(f.blocks);
  f.resolveTaxonomies = () => { f.elapsedMs = 12001;

 return new Promise(() => {}); };

  const plan = await f.edit([f.queryEdit]);
  assert.equal(plan.error, 'query_preview_unsettled');
  assert.equal(plan.diagnostics.pending_resolver, 'core.getTaxonomies');
  assert.equal(plan.diagnostics.completed_edits, undefined);
  assert.match(plan.hint, /reported editor outcome and current draft/);
  assert.equal(plan.editor_result, 'not_applied');
  assert.equal(nativeMutations, 0);
  assert.deepEqual(f.blocks, original);
});

test('an insert elsewhere does not preflight an existing filtered Query the batch updates', async () => {
  const f = queryFixture();
  const { createBlock } = f.window.wp.blocks;
  f.registrations['core/post-template'].attributes = { layout: { type: 'object' } };
  f.blocks.push(createBlock('core/query', { query: { inherit: false, postType: 'post', taxQuery: { include: { category: [3] } } } }, [
    createBlock('core/post-template', {}, [createBlock('core/paragraph', { content: 'Template child' })]),
  ]));
  f.syncContent();
  const template = f.blocks[3].innerBlocks[0];
  const plan = await f.edit([
    { op: 'insert', block: { name: 'example/card' } },
    { op: 'update', client_id: template.clientId, attributes: { layout: { type: 'grid', columnCount: 3 } } },
  ]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.deepEqual(copy(f.blocks[3].innerBlocks[0].attributes.layout), { type: 'grid', columnCount: 3 });
});

test('Query preview preflight preserves typing and leaves unrelated Query blocks alone', async () => {
  const f = queryFixture();
  f.resolveRecords = async () => { f.blocks[0].attributes.content = 'Human typing';

 return [{ id: 19, type: 'post' }]; };

  await f.call('connect', { workflow: 'attached' });
  const edited = await f.call('edit', { edits: [f.queryEdit] });

  assert.equal(edited.ok, false);
  assert.equal(f.blocks[0].attributes.content, 'Human typing');
  assert.equal(f.blocks.length, 3);
  delete f.resolveRecords;
  const node = f.window.wp.blocks.createBlock('core/query', { query: { inherit: true } }, [
    f.window.wp.blocks.createBlock('core/post-template', {}, []),
  ]);
  f.blocks.push(node); f.syncContent(); f.dirty = false;
  const next = await f.call('connect', { workflow: 'attached' });
  const nextPlan = await f.call('edit', { edits: [{ op: 'insert', block: { name: 'example/card' } }] });

  assert.equal(nextPlan.ok, true, JSON.stringify({ next, nextPlan }));
});

test('removal uses the selected block native lock without waiting for descendant insertion contexts', async () => {
  for (const locked of [false, true]) {
    const f = queryFixture();
    f.blocks.push(f.window.wp.blocks.createBlock('core/query', { query: { inherit: true } }, [
      f.window.wp.blocks.createBlock('core/post-template', {}, [f.window.wp.blocks.createBlock('core/paragraph')]),
    ]));
    f.syncContent(); f.missingContext = true; f.removeLocked = locked;
    const plan = await f.edit([{ op: 'remove', path: [3], name: 'core/query' }]);
    assert.equal(plan.ok, !locked, JSON.stringify(plan));

    if (locked) assert.equal(plan.error, 'block_locked');
  }
});

test('removing a section ignores locks on its descendants, like native removal', async () => {
  const f = fixture();
  f.blocks.push({ name: 'core/group', clientId: 'section', isValid: true, attributes: {}, innerBlocks: [
    { name: 'core/paragraph', clientId: 'template-child', isValid: true, attributes: { content: 'Template text', lock: { remove: true } }, innerBlocks: [] },
  ] });
  f.syncContent();
  const removed = await f.edit([{ op: 'remove', client_id: 'section' }]);
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(f.blocks.some((block) => block.clientId === 'section'), false);
  f.blocks.push({ name: 'core/group', clientId: 'locked', isValid: true, attributes: { lock: { remove: true } }, innerBlocks: [] });
  f.syncContent();
  await f.call('read', { blocks: 'all' });
  const refused = await f.edit([{ op: 'remove', client_id: 'locked' }]);
  assert.equal(refused.error, 'block_locked', JSON.stringify(refused));
});

test('a render failure restores selection and rolls back the unsaved blocks', async () => {
  const f = fixture();
  const original = f.post.content.raw;
  f.onSelect = () => { throw { code: 'probe-render-failed' }; };

  const plan = await f.edit([{ op: 'insert', block: { name: 'example/card' } }]);
  assert.equal(plan.error, 'probe-render-failed');
  assert.equal(plan.editor_result, 'rolled_back');
  // A caller whose host call lost this result still learns why from status.
  assert.deepEqual(copy((await f.call('status')).last_request), { id: plan.last_request.id, operation: 'edit', outcome: 'rolled_back', error: 'probe-render-failed' });
  assert.deepEqual(copy(f.selectionStart), {});
  assert.deepEqual(copy(f.selectionEnd), {});
  assert.equal(f.window.wp.blocks.serialize(f.blocks), original);
  assert.equal(f.saves, 0);
});

test('a failed rollback reports partial with the rollback error as debug', async () => {
  const f = fixture();
  f.onSelect = () => { throw { code: 'probe-render-failed' }; };

  const dispatch = f.window.wp.data.dispatch;
  f.window.wp.data.dispatch = (name) => name === 'core/block-editor'
    ? { ...dispatch(name), resetBlocks() { throw new Error('reset refused'); } }
    : dispatch(name);

  const plan = await f.edit([{ op: 'insert', block: { name: 'example/card' } }]);
  assert.equal(plan.error, 'probe-render-failed');
  assert.equal(plan.editor_result, 'partial');
  const [edit, rollback] = plan.debug.cause.errors;
  assert.equal(edit.code, 'probe-render-failed');
  assert.equal(rollback.cause.message, 'reset refused');
});

test('changes caused by restoring selection remain subject to the requested-value guard', async () => {
  const f = fixture();
  f.onSelectionRestore = () => { f.blocks.at(-1).attributes.variant = 'accent'; };

  const plan = await f.edit([{ op: 'insert', block: { name: 'example/card', attributes: { variant: 'plain' } } }]);
  assert.equal(plan.error, 'native_requested_value_changed');
  assert.equal(plan.editor_result, 'partial');
  assert.equal(f.blocks.at(-1).attributes.variant, 'accent');
  assert.equal(f.saves, 0);
});

for (const failure of ['reject', 'never finish', 'deny permission']) {
  test(`Query dependency can ${failure} without permitting an unverified save`, async () => {
    const f = fixture();
    f.registrations['core/query'] = { name: 'core/query', attributes: { query: { type: 'object', default: { inherit: false, perPage: 1, excludeCurrent: null } } } };
    const original = f.post.content.raw;
    f.resolveCanUser = () => failure === 'never finish' ? new Promise(() => {}) : Promise.resolve(failure !== 'deny permission');
    f.resolveEntity = async () => { throw { code: 'rest_forbidden' }; };

    const plan = await f.edit([{ op: 'insert', block: { name: 'core/query', attributes: { query: { inherit: false, perPage: 1, excludeCurrent: null } } } }]);

    if (failure === 'deny permission') {
      assert.equal(plan.ok, true, JSON.stringify(plan));
      assert.equal((await f.save()).persistence, 'verified');
    } else {
      assert.equal(plan.error, failure === 'reject' ? 'permission_denied' : 'native_initialization_unsettled');

      if (failure === 'never finish') {
        assert.equal(plan.diagnostics.stage, 'query_site_permission');
        assert.equal(plan.diagnostics.pending_resolver, 'core.canUser');
        assert.equal(plan.diagnostics.stall_ms, 5000);
      }

      assert.equal(f.window.wp.blocks.serialize(f.blocks), original);
      assert.equal(f.saves, 0);
    }
  });
}

test('native preparation can finish within its budget without repeating completed settling', async () => {
  const f = fixture();
  f.onSelect = () => { f.elapsedMs = (f.elapsedMs ?? 0) + 1500; };

  const original = f.post.content.raw;
  const plan = await f.edit([{ op: 'insert', block: { name: 'example/card' } }]);

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.ok(f.elapsedMs < 5000);
  assert.equal(f.post.content.raw, original);
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.saves, 1);
});

test('a stable fifty-block tree needs only one render sweep within the shared budget', async () => {
  const f = fixture();
  let selections = 0;
  f.onSelect = () => { selections++; f.elapsedMs = (f.elapsedMs ?? 0) + 70; };

  const plan = await f.edit([{ op: 'insert', block: { name: 'core/group', inner_blocks:
    Array.from({ length: 49 }, (_, i) => ({ name: 'core/paragraph', attributes: { content: String(i) } })),
  } }]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(selections, 50);
  assert.equal(f.elapsedMs, 3500);
  assert.equal(f.saves, 0);
});

test('a completed resolver invalidates the render sweep before sealing generated data', async () => {
  const f = fixture();
  f.registrations['example/card'].attributes.generatedId = { type: 'number' };
  let resolvedValue = 0;
  f.afterInsert = () => {
    f.resolving = true;
    setTimeout(() => { resolvedValue = 43; f.resolving = false; }, 60);
  };

  f.onSelect = () => { if (resolvedValue) f.blocks.at(-1).attributes.generatedId = resolvedValue; };

  const plan = await f.edit([{ op: 'insert', block: { name: 'example/card' } }]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(f.blocks.at(-1).attributes.generatedId, 43);
});

test('mixed native edits settle the final subtree without revisiting intermediate leaves', async () => {
  const f = fixture();
  const paragraph = (id) => ({ name: 'core/paragraph', clientId: id, attributes: { content: id }, innerBlocks: [], isValid: true });
  const group = (id, children) => ({ name: 'core/group', clientId: id, attributes: {}, innerBlocks: children, isValid: true });
  const card = (id) => ({ name: 'example/card', clientId: id, attributes: {}, innerBlocks: [], isValid: true });
  f.blocks = [group('section', [group('image-column', [card('image')]), group('content-column', [
    paragraph('heading'), paragraph('intro'), group('features', [0, 1, 2].map((i) => group(`row-${i}`, [
      group(`icon-${i}`, [card(`image-${i}`)]), group(`text-${i}`, [paragraph(`title-${i}`), paragraph(`body-${i}`)]),
    ]))), group('callout', [paragraph('callout-title'), paragraph('callout-body')]),
  ])]), paragraph('unrelated')];
  f.syncContent();
  const visited = new Set();
  f.onSelect = (id) => { visited.add(id); f.elapsedMs = (f.elapsedMs ?? 0) + 70; };

  await f.call('connect', { workflow: 'attached' });
  const edited = await f.call('edit', { edits: [
    { op: 'remove', path: [0, 0], name: 'core/group' },
    { op: 'update', path: [0, 0], name: 'core/group', attributes: { className: 'expanded' } },
    { op: 'replace', path: [0, 0, 2], name: 'core/group', block: { name: 'core/group', inner_blocks: [0, 1, 2].map((i) => ({
      name: 'core/group', inner_blocks: [{ name: 'core/group', inner_blocks: [{ name: 'example/card' }] },
        { name: 'core/paragraph', attributes: { content: `title-${i}` } }, { name: 'core/paragraph', attributes: { content: `body-${i}` } }],
    })) } },
  ] });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(edited.editor_result, 'applied');
  assert.ok(f.elapsedMs < 5000);
  assert.ok(!visited.has('image-0'));
  assert.ok(!visited.has('unrelated'));
  const remaining = f.blocks[0].innerBlocks[0];
  assert.equal(remaining.attributes.className, 'expanded');
  assert.ok(visited.has(remaining.innerBlocks[2].innerBlocks[0].innerBlocks[0].innerBlocks[0].clientId));
  assert.equal(f.saves, 0);
});

test('intermediate native containers refresh their insertion policy before the next edit', async () => {
  const f = fixture();
  const store = f.window.wp.data.select('core/block-editor');
  const canInsert = store.canInsertBlockType;
  let mounted = false;
  f.onSelect = (id) => { if (id === f.blocks.at(-1).clientId) mounted = true; };

  store.canInsertBlockType = (name, parent) => mounted && parent === f.blocks.at(-1).clientId
    ? name === 'example/card' : canInsert(name, parent);
  const original = f.post.content.raw;
  const prepared = await f.edit([
    { op: 'insert', block: { name: 'core/group', inner_blocks: [{ name: 'example/card' }] } },
    { op: 'insert', parent: [3], block: { name: 'core/paragraph', attributes: { content: 'Refused child' } } },
  ]);
  assert.equal(prepared.error, 'insertion_refused', JSON.stringify(prepared));
  assert.equal(prepared.diagnostics.edit_index, 1);
  assert.equal(prepared.diagnostics.completed_edits, 1);
  assert.equal(f.window.wp.blocks.serialize(f.blocks), original);
  assert.equal(f.saves, 0);
});

test('native selection timeouts name the block and restore the original selection', async () => {
  const f = fixture();
  f.onSelect = () => { f.elapsedMs = 6000; };

  const original = f.post.content.raw;
  const prepared = await f.edit([{ op: 'insert', block: { name: 'example/card' } }]);
  assert.equal(prepared.error, 'native_initialization_unsettled');
  assert.equal(prepared.diagnostics.stage, 'render_affected');
  assert.equal(prepared.diagnostics.render_phase, 'selection_commit');
  assert.equal(prepared.diagnostics.block_name, 'example/card');
  assert.deepEqual(copy(prepared.diagnostics.target_path), [3]);
  assert.equal(prepared.diagnostics.completed_blocks, 1);
  assert.equal(prepared.diagnostics.block_count, 1);
  assert.deepEqual(copy(f.selectionStart), {});
  assert.equal(f.window.wp.blocks.serialize(f.blocks), original);
  assert.equal(f.saves, 0);
});

for (const op of ['update', 'set_block_style']) {
  test(`native mixed batches detect foreign changes under existing ${op} targets`, async () => {
    const f = fixture();
    const card = f.blocks[1];
    f.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, innerBlocks: [card], isValid: true };
    f.registrations['example/card'].attributes.generatedId = { type: 'number' };
    f.registrations['core/group'].styles = [{ name: 'bordered', label: 'Bordered' }];
    f.syncContent();
    f.onSelect = (id) => { if (id === 'b') f.blocks[1].innerBlocks[0].attributes.generatedId = 9; };

    await f.call('connect', { attribute_guide: { name: 'core/group' } });

    const edit = op === 'update' ? { op, path: [1], name: 'core/group', attributes: { className: 'changed' } }
      : { op, path: [1], name: 'core/group', style: 'bordered', };

    const plan = await f.call('edit', { edits: [edit, { op: 'insert', block: { name: 'example/card' } }] });
    assert.equal(plan.error, 'prepared_content_changed');
    assert.equal(plan.editor_result, 'partial');
    assert.equal(f.blocks[1].innerBlocks[0].attributes.generatedId, 9);
    assert.equal(f.saves, 0);
  });
}

test('native parents can mount descendants and register their policies before child checks', async () => {
  const f = fixture();
  let ready = false;

  const missing = () => {
    f.elapsedMs = 6000;

    return false;
  };

  f.window.wp.data.select('core/block-editor').getBlockListSettings = () => ready ? {} : missing() || undefined;
  f.isRendered = (id) => id === `block-${f.blocks.at(-1).clientId}` || ready || missing();
  f.onSelect = (id) => { if (id === f.blocks.at(-1).clientId) ready = true; };

  const plan = await f.edit([{ op: 'insert', block: { name: 'core/group', inner_blocks: [
    { name: 'core/group', inner_blocks: [{ name: 'example/card' }] },
  ] } }]);

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await f.save()).persistence, 'verified');
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

test('an attached Code Mode editor keeps its mode and refuses rendered work at once', async () => {
  const f = fixture();
  f.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, innerBlocks: [] };
  f.syncContent();
  const original = f.post.content.raw;
  f.missingContext = true;
  f.window.wp.data.select('core/editor').getEditorMode = () => 'text';
  f.window.wp.data.dispatch = new Proxy(f.window.wp.data.dispatch, {
    apply: (target, self, [name]) => {
      assert.notEqual(name, 'core/preferences');

      return target(name);
    },
  });

  const connected = await f.call('connect', { workflow: 'attached' });
  assert.equal(connected.editor_mode, 'text');

  const measured = await f.call('measure', { blocks: ['group'] });
  assert.equal(measured.error, 'editor_code_mode');
  assert.match(measured.hint, /Visual editor/);

  const edited = await f.call('edit', { edits: [
    { op: 'insert', parent_client_id: 'group', index: 0, block: { name: 'core/paragraph', attributes: { content: 'Nested' } } },
  ] });
  assert.equal(edited.error, 'editor_code_mode');
  assert.equal(f.window.wp.blocks.serialize(f.blocks), original);
});

function filledFixture() {
  const f = fixture();
  f.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, innerBlocks: [] };
  f.syncContent();
  f.blocks[1].innerBlocks = [{ name: 'core/paragraph', clientId: 'filled', attributes: { content: '' }, innerBlocks: [] }];

  return f;
}

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

test('an empty rich-text value stays an object through a plan copy', async () => {
  const f = fixture();
  // A save such as core/details' writes default text for a falsy value, so a
  // plan copy must not turn an empty RichTextData into ''.
  const empty = { toJSON: () => '' };
  f.blocks[1] = { name: 'core/paragraph', clientId: 'empty', attributes: { content: empty }, innerBlocks: [] };
  const { blocks } = f.window.wp;
  const { serialize } = blocks;
  const seen = [];
  blocks.serialize = (list) => {
    seen.push(...list.filter((block) => block.clientId === 'empty').map((block) => block.attributes.content));

    return serialize(list);
  };

  const connected = await f.call('connect', { workflow: 'attached' });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  await f.call('edit', { edits: [{ op: 'update', client_id: f.blocks[0].clientId, attributes: { content: 'After' } }] });
  assert.ok(seen.length);
  assert.ok(seen.every((value) => value === empty), `copied to ${JSON.stringify(seen)}`);
});

test('native timeout rollback finishes when animation frames stop', { timeout: 500 }, async () => {
  const f = fixture();
  const original = f.post.content.raw;
  f.window.requestAnimationFrame = () => {};

  f.afterInsert = () => { f.elapsedMs = 6000; };

  const plan = await f.edit([{ op: 'insert', block: { name: 'example/card' } }]);
  assert.equal(plan.error, 'native_initialization_unsettled');
  assert.equal(f.window.wp.blocks.serialize(f.blocks), original);
  assert.equal(f.window.__blockwork_editor.busy, false);
  assert.equal(f.saves, 0);
});

test('native rollback preserves a valid nested selection range', async () => {
  const f = fixture();
  f.blocks[1].innerBlocks = [{ name: 'core/paragraph', attributes: { content: 'Nested' }, clientId: 'nested', innerBlocks: [], isValid: true }];
  f.syncContent();
  const original = f.post.content.raw;
  const start = { clientId: 'nested', attributeKey: 'content', offset: 1 };
  const end = { clientId: 'nested', attributeKey: 'content', offset: 4 };
  f.selectionStart = copy(start);
  f.selectionEnd = copy(end);
  f.caret = -1;
  f.onSelect = () => { throw { code: 'probe-render-failed' }; };

  const plan = await f.edit([{ op: 'insert', block: { name: 'example/card' } }]);
  assert.equal(plan.error, 'probe-render-failed');
  assert.deepEqual(copy(f.selectionStart), start);
  assert.deepEqual(copy(f.selectionEnd), end);
  assert.equal(f.caret, -1);
  assert.equal(f.window.wp.blocks.serialize(f.blocks), original);
  assert.equal(f.saves, 0);
});

function sharedFixture(post_type = 'wp_block', identity = 7) {
  const url = post_type === 'wp_block' ? 'https://example.test/wp-admin/post.php?post=7&action=edit'
    : 'https://example.test/wp-admin/site-editor.php?canvas=edit';

  const f = fixture(post_type, url);
  const selected = { ...target, post_type, post_id: identity };
  f.post.id = identity;
  f.post.status = 'publish';

  if (['wp_template', 'wp_template_part'].includes(post_type)) {
    [f.post.theme, f.post.slug] = identity.split('//');
    f.post.wp_id = 51;
    f.post.source = 'custom';
    delete f.post.date_gmt;
    delete f.post.modified_gmt;
  }

  // Only the post editor supplies post lock utilities.
  if (post_type !== 'wp_block') f.window.wp.data.select('core/editor').getEditorSettings = () => ({});

  if (post_type === 'wp_navigation') {
    f.blocks = [{ name: 'core/navigation', attributes: { ref: identity }, clientId: 'wrapper', isValid: true, innerBlocks: f.blocks }];
    // The entity's own blocks, without the block editor's wrapper.
    f.window.wp.data.select('core/editor').getEditorBlocks = () => f.blocks[0].innerBlocks;
  }

  const call = f.call;
  f.call = (operation, extra = {}) => {
    const identity = { ...selected };

    if (operation === 'connect') delete identity.user_id;

    return call(operation, { target: identity, ...extra });
  };

  return f;
}

for (const [type, identity, scope] of [['wp_block', 7, 'all_references'], ['wp_navigation', 7, 'site_wide'],
  ['wp_template', 'theme//test', 'site_wide'], ['wp_template_part', 'theme//part', 'site_wide']]) {
  test(`${type} preserves identity and requires shared scope for a verified native save`, async () => {
    const f = sharedFixture(type, identity);
    const inspection = await f.call('connect');
    assert.equal(inspection.ok, true, JSON.stringify(inspection));
    assert.equal(inspection.entity.scope, scope);
    const missing = await f.call('edit', { edits: changes });
    assert.equal(missing.error, 'shared_scope_required');
    const edited = await f.call('edit', { edits: changes, scope });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    const saved = await f.save();
    assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
    assert.equal(f.saves, 1);
    assert.equal(f.post.status, 'publish');
    assert.equal(f.post.id, identity);
    const released = await f.call('release');

    // The Site Editor neither takes nor checks post locks.
    if (type === 'wp_block') {
      assert.equal(released.cleanup, 'release_requested');
    } else {
      assert.deepEqual([released.cleanup, f.pulses, f.releases], ['no_post_lock', 0, 0]);
    }

    if (type === 'wp_navigation') {
      assert.equal(f.blocks[0].clientId, 'wrapper');
      assert.equal(f.blocks[0].innerBlocks[0].attributes.content, 'After');
      assert.equal(f.post.content.raw.includes('core/navigation'), false);
    }
  });
}

test('shared documents refuse settings and unsynced patterns', async () => {
  const f = sharedFixture();
  await f.call('connect');
  assert.equal((await f.call('edit', { edits: changes, scope: 'all_references', post: { title: 'No' } })).error, 'shared_content_only');
  f.post.wp_pattern_sync_status = 'unsynced';
  assert.equal((await f.call('connect')).error, 'pattern_not_synced');
  assert.equal(f.saves, 0);
});

function referenceFixture() {
  const f = fixture();
  f.registrations['core/block'] = { name: 'core/block', attributes: { ref: { type: 'number' } } };
  const record = { ...copy(f.post), id: 77, type: 'wp_block', status: 'publish' };
  const baseApi = f.api;
  f.api = async (request) => request.method !== 'OPTIONS' && request.path.startsWith('/wp/v2/blocks/77') ? record : baseApi?.(request);
  f.referenceRecord = record;

  return f;
}

test('reference insertion checks identity and currentness before editing and preserves shared content', async () => {
  const f = referenceFixture();
  const refTarget = { ...target, post_type: 'wp_block', post_id: 77 };
  const referenced = await f.call('inspect_entity', { target: refTarget });
  assert.equal(referenced.ok, true, JSON.stringify(referenced));
  await f.call('connect');

  const edited = await f.call('edit', { edits: [{ op: 'insert_reference',
    reference: { entity_type: 'wp_block', entity_id: 77, reference_token: referenced.reference_token } }] });

  assert.equal(edited.ok, true, JSON.stringify(edited));
  const original = f.referenceRecord.content.raw;
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks.at(-1).attributes.ref, 77);
  assert.equal(f.referenceRecord.content.raw, original);

  const stale = referenceFixture();
  const reference = await stale.call('inspect_entity', { target: refTarget });
  await stale.call('connect');

  stale.referenceRecord.title.raw = 'Changed';
  const plan = await stale.call('edit', { edits: [{ op: 'insert_reference',
    reference: { entity_type: 'wp_block', entity_id: 77, reference_token: reference.reference_token } }] });

  assert.equal(plan.error, 'stale_entity_reference', JSON.stringify(plan));
  assert.equal(stale.saves, 0);
});

test('save rechecks inserted references across edits and revert', async () => {
  const f = referenceFixture();
  const refTarget = { ...target, post_type: 'wp_block', post_id: 77 };
  const inspected = await f.call('inspect_entity', { target: refTarget });
  await f.call('connect');
  const inserted = await f.call('edit', { edits: [{ op: 'insert_reference',
    reference: { entity_type: 'wp_block', entity_id: 77, reference_token: inspected.reference_token } }] });
  assert.equal(inserted.ok, true, JSON.stringify(inserted));
  assert.equal((await f.call('edit', { edits: changes })).ok, true);
  assert.equal((await f.call('revert')).ok, true);
  await f.call('connect');
  f.referenceRecord.title.raw = 'Changed';
  const prepared = await f.call('prepare_save');
  assert.equal(prepared.error, 'stale_entity_reference', JSON.stringify(prepared));
  assert.equal(prepared.next, 'inspect_entity_then_reconcile');
  assert.equal(prepared.diagnostics.stage, 'reference_currentness');
  assert.deepEqual(copy(prepared.diagnostics.live_block_path), [3]);
  assert.equal(f.saves, 0);
});

test('removing an owned reference retires its save check', async () => {
  const f = referenceFixture();
  const inspected = await f.call('inspect_entity', { target: { ...target, post_type: 'wp_block', post_id: 77 } });
  await f.call('connect');
  const inserted = await f.call('edit', { edits: [{ op: 'insert_reference',
    reference: { entity_type: 'wp_block', entity_id: 77, reference_token: inspected.reference_token } }] });
  assert.equal(inserted.ok, true, JSON.stringify(inserted));
  const removed = await f.call('edit', { edits: [{ op: 'remove', client_id: f.blocks.at(-1).clientId }] });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal((await f.call('edit', { edits: changes })).ok, true);
  f.referenceRecord.title.raw = 'Changed';
  assert.equal((await f.save()).persistence, 'verified');
});

test('moving an owned reference reports its current path', async () => {
  const f = referenceFixture();
  const inspected = await f.call('inspect_entity', { target: { ...target, post_type: 'wp_block', post_id: 77 } });
  await f.call('connect');
  assert.equal((await f.call('edit', { edits: [{ op: 'insert_reference',
    reference: { entity_type: 'wp_block', entity_id: 77, reference_token: inspected.reference_token } }] })).ok, true);
  const id = f.blocks.at(-1).clientId;
  const moved = await f.call('edit', { edits: [{ op: 'move', client_id: id, parent: [], index: 0 }] });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  f.referenceRecord.title.raw = 'Changed';
  const prepared = await f.call('prepare_save');
  assert.equal(prepared.error, 'stale_entity_reference', JSON.stringify(prepared));
  assert.deepEqual(copy(prepared.diagnostics.live_block_path), [0]);
});

test('reference replacement retires the old entity but pins the replacement', async () => {
  for (const staleReplacement of [false, true]) {
    const f = referenceFixture();
    const replacement = { ...copy(f.referenceRecord), id: 78 };
    const baseApi = f.api;
    f.api = (request) => request.method !== 'OPTIONS' && request.path.startsWith('/wp/v2/blocks/78') ? replacement : baseApi(request);
    const first = await f.call('inspect_entity', { target: { ...target, post_type: 'wp_block', post_id: 77 } });
    const second = await f.call('inspect_entity', { target: { ...target, post_type: 'wp_block', post_id: 78 } });
    await f.call('connect');
    assert.equal((await f.call('edit', { edits: [{ op: 'insert_reference', reference: {
      entity_type: 'wp_block', entity_id: 77, reference_token: first.reference_token,
    } }] })).ok, true);
    const replaced = await f.call('edit', { edits: [{ op: 'update_reference', client_id: f.blocks.at(-1).clientId,
      reference: { entity_type: 'wp_block', entity_id: 78, reference_token: second.reference_token } }] });
    assert.equal(replaced.ok, true, JSON.stringify(replaced));
    f.referenceRecord.title.raw = 'Changed';

    if (staleReplacement) replacement.title.raw = 'Changed replacement';
    const prepared = await f.call('prepare_save');

    if (staleReplacement) {
      assert.equal(prepared.error, 'stale_entity_reference', JSON.stringify(prepared));
      assert.equal(prepared.diagnostics.entity_id, 78);
    } else assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal(f.saves, 0);
  }
});

test('removing an ancestor retires its owned reference check', async () => {
  const f = referenceFixture();
  const inspected = await f.call('inspect_entity', { target: { ...target, post_type: 'wp_block', post_id: 77 } });
  await f.call('connect');
  assert.equal((await f.call('edit', { edits: [{ op: 'insert', block: { name: 'core/group' } }] })).ok, true);
  const ancestor = f.blocks.at(-1).clientId;
  const inserted = await f.call('edit', { edits: [{ op: 'insert_reference', parent_client_id: ancestor,
    reference: { entity_type: 'wp_block', entity_id: 77, reference_token: inspected.reference_token } }] });
  assert.equal(inserted.ok, true, JSON.stringify(inserted));
  assert.equal(f.blocks.at(-1).innerBlocks.length, 1);
  assert.equal((await f.call('edit', { edits: [{ op: 'remove', client_id: ancestor }] })).ok, true);
  assert.equal((await f.call('edit', { edits: changes })).ok, true);
  f.referenceRecord.title.raw = 'Changed';
  assert.equal((await f.save()).persistence, 'verified');
});

test('removing one reference owner retains another owners shared dependency check', async () => {
  const f = referenceFixture();
  const dependency = { ...copy(f.referenceRecord), id: 78 };
  f.referenceRecord.content.raw = f.window.wp.blocks.serialize([f.window.wp.blocks.createBlock('core/block', { ref: 78 })]);
  const baseApi = f.api;
  f.api = (request) => request.method !== 'OPTIONS' && request.path.startsWith('/wp/v2/blocks/78') ? dependency : baseApi(request);
  const inspected = await f.call('inspect_entity', { target: { ...target, post_type: 'wp_block', post_id: 77 } });
  await f.call('connect');
  const reference = { entity_type: 'wp_block', entity_id: 77, reference_token: inspected.reference_token };
  assert.equal((await f.call('edit', { edits: [{ op: 'insert_reference', reference }] })).ok, true);
  const firstOwner = f.blocks.at(-1).clientId;
  assert.equal((await f.call('edit', { edits: [{ op: 'insert_reference', reference }] })).ok, true);
  const remainingOwner = f.blocks.at(-1).clientId;
  assert.equal((await f.call('edit', { edits: [{ op: 'remove', client_id: firstOwner }] })).ok, true);
  dependency.title.raw = 'Changed dependency';
  const prepared = await f.call('prepare_save');
  assert.equal(prepared.error, 'stale_entity_reference', JSON.stringify(prepared));
  assert.equal(prepared.diagnostics.entity_id, 78);
  assert.equal(prepared.diagnostics.owner_client_id, remainingOwner);
  assert.equal(prepared.diagnostics.dependency, true);
  assert.equal(f.saves, 0);
});

test('a same-identity reference update batched with another edit retains pinned dependencies', async () => {
  const f = referenceFixture();
  const dependency = { ...copy(f.referenceRecord), id: 78 };
  f.referenceRecord.content.raw = f.window.wp.blocks.serialize([f.window.wp.blocks.createBlock('core/block', { ref: 78 })]);
  const baseApi = f.api;
  f.api = (request) => request.method !== 'OPTIONS' && request.path.startsWith('/wp/v2/blocks/78') ? dependency : baseApi(request);
  const inspected = await f.call('inspect_entity', { target: { ...target, post_type: 'wp_block', post_id: 77 } });
  await f.call('connect');
  const reference = { entity_type: 'wp_block', entity_id: 77, reference_token: inspected.reference_token };
  assert.equal((await f.call('edit', { edits: [{ op: 'insert_reference', reference }] })).ok, true);
  const owner = f.blocks.at(-1).clientId;
  dependency.title.raw = 'Changed dependency';
  const edited = await f.call('edit', { edits: [
    { op: 'update_reference', client_id: owner, reference }, ...changes,
  ] });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const prepared = await f.call('prepare_save');
  assert.equal(prepared.error, 'stale_entity_reference', JSON.stringify(prepared));
  assert.equal(prepared.diagnostics.entity_id, 78);
  assert.equal(f.saves, 0);
});

test('a recovered committed reference save clears its checks after reconnect', async () => {
  const f = referenceFixture();
  const inspected = await f.call('inspect_entity', { target: { ...target, post_type: 'wp_block', post_id: 77 } });
  await f.call('connect');
  assert.equal((await f.call('edit', { edits: [{ op: 'insert_reference', reference: {
    entity_type: 'wp_block', entity_id: 77, reference_token: inspected.reference_token,
  } }] })).ok, true);
  f.interruptSave = true;
  const lost = await f.save();
  assert.equal(lost.persistence, 'uncertain', JSON.stringify(lost));
  f.interruptSave = false;
  const receipt = (await f.call('status')).receipt;
  const recovered = await f.call('recover', { target: { site_url: target.site_url, user_id: target.user_id }, receipt });
  assert.equal(recovered.outcome, 'matched_desired', JSON.stringify(recovered));
  assert.equal((await f.call('connect')).ok, true);
  f.referenceRecord.title.raw = 'Changed after persistence';
  assert.equal((await f.call('edit', { edits: changes })).ok, true);
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.saves, 2);
});

test('generic block insertion and attribute changes cannot bypass reference validation', async () => {
  const f = referenceFixture();
  const plainInsert = await f.edit([{ op: 'insert', block: { name: 'core/block', attributes: { ref: 77 } } }]);
  assert.equal(plainInsert.error, 'reference_operation_required');
  assert.match(plainInsert.hint, /insert_reference/);
  const g = fixture();
  g.blocks.push({ name: 'core/navigation', attributes: { ref: 9 }, clientId: 'nav', innerBlocks: [], isValid: true });
  g.syncContent();
  assert.equal((await g.edit([{ op: 'update', name: 'core/navigation', path: [3], attributes: { ref: 10 } }])).error, 'reference_operation_required');
});

test('reference replacement keeps the shared entity unchanged and checks indirect cycles', async () => {
  const f = referenceFixture();
  f.blocks.push({ name: 'core/block', attributes: { ref: 76 }, clientId: 'shared', innerBlocks: [], isValid: true });
  f.syncContent();
  const reference = await f.call('inspect_entity', { target: { ...target, post_type: 'wp_block', post_id: 77 } });
  await f.call('connect');

  const plan = await f.call('edit', { edits: [{ op: 'update_reference', path: [3], name: 'core/block',
    reference: { entity_type: 'wp_block', entity_id: 77, reference_token: reference.reference_token } }] });

  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks[3].attributes.ref, 77);
  assert.equal(f.referenceRecord.content.raw, f.window.wp.blocks.serialize(f.window.wp.blocks.parse(f.referenceRecord.content.raw)));

  const cyclic = sharedFixture();
  cyclic.registrations['core/block'] = { name: 'core/block', attributes: { ref: { type: 'number' } } };

  const other = { ...copy(cyclic.post), id: 77, content: { raw: cyclic.window.wp.blocks.serialize([
    cyclic.window.wp.blocks.createBlock('core/block', { ref: 7 }),
  ]) } };

  cyclic.api = ({ path, method }) => method !== 'OPTIONS' && path.startsWith('/wp/v2/blocks/77') ? other : undefined;
  const selected = await cyclic.call('inspect_entity', { target: { ...target, post_type: 'wp_block', post_id: 77 } });
  await cyclic.call('connect');

  const refused = await cyclic.call('edit', { scope: 'all_references', edits: [{ op: 'insert_reference', reference: { entity_type: 'wp_block', entity_id: 77, reference_token: selected.reference_token } }] });

  assert.equal(refused.error, 'recursive_entity_reference', JSON.stringify(refused));
  assert.equal(cyclic.saves, 0);
});

test('navigation connect waits for the entity blocks inside the editor-only wrapper', async () => {
  const f = sharedFixture('wp_navigation');
  const blockEditor = f.window.wp.data.select('core/block-editor');
  const getBlocks = blockEditor.getBlocks;
  let childChecks = 0;
  blockEditor.getBlocks = (root) => (root === 'wrapper' && ++childChecks < 3 ? [] : getBlocks(root));
  const connected = await f.call('connect', { workflow: 'attached' });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.deepEqual(copy(connected.blocks).map(({ client_id }) => client_id), ['a', 'b', 'c']);

  const empty = sharedFixture('wp_navigation');
  empty.blocks[0].innerBlocks = [];
  empty.syncContent();
  const started = Date.now();
  assert.equal((await empty.call('connect', { workflow: 'attached' })).ok, true);
  assert.ok(Date.now() - started < 1000);
});

test('a request that never settles still times out, and diagnostics hide template IDs', async () => {
  const f = sharedFixture('wp_template', 'private-theme//private%20campaign');
  const apiFetch = f.window.wp.apiFetch;
  f.window.wp.apiFetch = (options) => {
    f.elapsedMs = 37950;

    // A nonce refresh or media post-processing request carries no signal, so
    // the native promise outlives the abort.
    return String(options.path).startsWith('/wp/v2/templates/') ? new Promise(() => {}) : apiFetch(options);
  };

  const started = Date.now();
  const unanswered = await f.call('connect', { workflow: 'attached' });
  assert.deepEqual([unanswered.error, unanswered.next, unanswered.diagnostics?.request],
    ['request_timeout', 'retry', 'OPTIONS /wp/v2/templates/:id'], JSON.stringify(unanswered));
  assert.ok(Date.now() - started < 2000);
  assert.equal(JSON.stringify(unanswered).includes('private'), false);
});

test('navigation structural edits address children while preserving the native wrapper', async () => {
  const f = sharedFixture('wp_navigation');
  await f.call('connect');

  const plan = await f.call('edit', { scope: 'site_wide', edits: [
    { op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'Inserted' } }, index: 1 },
    { op: 'move', name: 'core/paragraph', path: [1], parent: [], index: 0 },
    { op: 'remove', name: 'example/card', path: [2] },
  ] });

  assert.equal(plan.ok, true, JSON.stringify(plan));
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(f.blocks.length, 1);
  assert.equal(f.blocks[0].clientId, 'wrapper');
  assert.deepEqual(f.blocks[0].innerBlocks.map((b) => b.attributes.content), ['Inserted', 'Before', 'Preserve']);
});

// The editor shows stored markup until its first change, as Gutenberg does.
function storedMarkup(f, raw) {
  const wp = f.window.wp;
  f.post.content.raw = raw;
  wp.data.select('core/editor').getEditedPostContent = () => f.dirty ? wp.blocks.serialize(f.blocks) : f.post.content.raw;
}

test('template markup that differs only in format plans from native serialization', async () => {
  const f = sharedFixture('wp_template', 'theme//404');
  const wp = f.window.wp;
  // WordPress serialized this template in PHP, which orders attributes its own way.
  storedMarkup(f, f.blocks.map(({ name, attributes }) => JSON.stringify({ attributes, name, innerBlocks: [] })).join('\n\n'));
  const connected = await f.call('connect');
  assert.equal(connected.normalization_required, true, JSON.stringify(connected));
  const edited = await f.call('edit', { scope: 'site_wide', edits: changes });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.post.content.raw, wp.blocks.serialize(f.blocks));
});

test('format-only markup beside preserved raw content edits and saves natively', async () => {
  for (const name of ['core/html', 'core/freeform']) {
    const f = mixedFixture();
    f.registrations[name] = { name, attributes: { content: { type: 'string' } } };
    f.blocks[3].name = name;
    const wp = f.window.wp;
    // Only supported block formatting differs. Raw markup remains an exact region.
    storedMarkup(f, f.blocks.map((block, index) => index === 3
      ? wp.blocks.serialize([block])
      : JSON.stringify({ attributes: block.attributes, name: block.name, innerBlocks: [] })).join('\n\n'));
    const raw = wp.blocks.serialize([f.blocks[3]]);
    const connected = await f.call('connect');
    assert.equal(connected.normalization_required, true, JSON.stringify(connected));
    const edited = await f.call('edit', { edits: changes });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    assert.equal(f.blocks[0].attributes.content, 'After');
    assert.equal(wp.blocks.serialize([f.blocks[3]]), raw);
    const saved = await f.save();
    assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
    assert.equal(saved.preservation_status, 'verified_after_read');
    assert.equal(f.post.content.raw, wp.blocks.serialize(f.blocks));
  }
});

test('unproved format-only content explains markup differences without suggesting bypasses', async () => {
  for (const missing of [false, true]) {
    const f = mixedFixture();

    if (missing) {
      delete f.registrations['core/html'];
    } else {
      f.blocks.push({ ...copy(f.blocks[3]), clientId: 'duplicate-raw' });
    }

    storedMarkup(f, f.blocks.map((block, index) => index >= 3
      ? f.window.wp.blocks.serialize([block])
      : JSON.stringify({ attributes: block.attributes, name: block.name, innerBlocks: [] })).join('\n\n'));
    assert.equal((await f.call('connect')).ok, true);
    const edited = await f.call('edit', { edits: changes });
    assert.equal(edited.error, 'initial_serialization_changed', JSON.stringify(edited));
    assert.equal(edited.diagnostics.markup_changed, true);
    assert.equal(edited.diagnostics.block_state_equal, true);
    assert.deepEqual(copy(edited.diagnostics.mismatches.blocks), []);
    assert.match(edited.hint, /opens the editor for them with Save ready/);
    assert.equal(f.blocks[0].attributes.content, 'Before');
    assert.equal(f.saves, 0);
  }
});

test('prepare_resave enables Save in an attached editor only', async () => {
  const background = fixture();
  assert.equal((await background.call('connect')).ok, true);
  assert.equal((await background.call('prepare_resave')).error, 'workflow_mismatch');
});

test('deprecated markup refuses other edits until it is re-saved', async () => {
  // Gutenberg also migrates markup that still validates when a deprecation is eligible.
  for (const legacyValid of [false, true]) {
  const f = fixture();
  const wp = f.window.wp;
  f.legacyValid = legacyValid;
  f.registrations['example/legacy'] = { name: 'example/legacy', attributes: { content: { type: 'string' } }, deprecated: [{ save: () => 'old' }] };
  f.blocks[0] = { name: 'example/legacy', clientId: 'legacy', attributes: { old: 'Legacy text' }, innerBlocks: [] };
  f.syncContent();
  storedMarkup(f, f.post.content.raw);
  f.blocks = wp.blocks.parse(f.post.content.raw);
  assert.equal((await f.call('connect')).ok, true);
  const edited = await f.call('edit', { edits: [{ op: 'update', path: [2], name: 'core/paragraph', attributes: { content: 'Changed' } }] });
  assert.equal(edited.error, 'initial_serialization_changed', JSON.stringify(edited));
  assert.equal(f.blocks[2].attributes.content, 'Preserve');
  assert.equal(f.saves, 0);
  }
});

test('a file template save verifies its first database override and assigned author', async () => {
  const f = sharedFixture('wp_template', 'theme//file');
  Object.assign(f.post, { wp_id: 0, source: 'theme', origin: 'theme', has_theme_file: true, author: 0 });
  await f.call('connect');
  assert.equal(f.pulses, 0);
  const edited = await f.call('edit', { scope: 'site_wide', edits: changes });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(saved.entity.source, 'custom');
  assert.equal(saved.entity.has_theme_file, true);
  assert.equal(saved.entity.wp_id, 51);
  assert.equal(saved.editor_url, 'https://example.test/wp-admin/site-editor.php?postType=wp_template&postId=theme%2F%2Ffile&canvas=edit');
});

test('template discovery pages native identity lists without repeating the first page', async () => {
  const f = sharedFixture('wp_template', 'theme//first');
  const second = { ...copy(f.post), id: 'theme//second', slug: 'second', wp_id: 52 };
  f.api = ({ path, method }) => {
    if (method === 'OPTIONS') return;

    if (path === '/wp/v2/templates?context=edit&_fields=id') return [{ id: second.id }, { id: f.post.id }];

    if (path.startsWith('/wp/v2/templates/theme//second')) return second;
  };

  const request = { target: { site_url: target.site_url, user_id: 5 }, entity_type: 'wp_template', limit: 1 };
  const first = await f.call('list_entities', request);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.items[0].target.post_id, 'theme//first');
  assert.equal(first.may_have_more, true);
  const next = await f.call('list_entities', { ...request, page: 2 });
  assert.equal(next.items[0].target.post_id, 'theme//second');
  assert.equal(next.may_have_more, false);
});

test('shared references reject insertion and movement into their children before native staging', async () => {
  for (const name of ['core/block', 'core/template-part', 'core/navigation']) {
    for (const operation of ['insert_tree', 'move']) {
      const f = fixture();
      f.registrations[name] = { name, attributes: { ref: { type: 'number' }, slug: { type: 'string' } } };
      f.blocks.push({ name, attributes: { ref: 77, slug: 'part' }, clientId: 'shared', innerBlocks: [], isValid: true });
      f.syncContent();
      const before = copy(f.blocks);

      const edit = operation === 'move' ? { op: 'move', name: 'core/paragraph', path: [2], parent: [3] }
        : { op: 'insert', parent: [3], block: { name: 'core/group', inner_blocks: [{ name: 'core/paragraph', attributes: { content: 'Escaped' } }] } };

      const refused = await f.edit([...changes, edit]);
      assert.equal(refused.error, 'shared_descendant_not_editable', JSON.stringify(refused));
      assert.deepEqual(f.blocks, before);
      assert.equal(f.dirty, false);
      assert.equal(f.saves, 0);
    }
  }
});

test('navigation respects the wrapper insertion policy and exposes that policy in inspection', async () => {
  const f = sharedFixture('wp_navigation');
  const store = f.window.wp.data.select('core/block-editor');
  store.getTemplateLock = (id) => id === 'wrapper' ? false : 'insert';
  store.canInsertBlockType = (_name, id) => id === 'wrapper' && !f.insertLocked;
  const inspected = await f.call('connect', { blocks: 'roots', insertion: {} });
  assert.equal(inspected.insertion.template_lock, false);
  assert.equal(inspected.insertion.items[0].allowed, true);
  f.insertLocked = true;

  const refused = await f.call('edit', { scope: 'site_wide',
    edits: [{ op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'Refused' } } }] });

  assert.equal(refused.error, 'insertion_refused', JSON.stringify(refused));
  assert.equal(f.saves, 0);
});

test('nested template part references use the native current theme when omitted', async () => {
  const f = referenceFixture();
  f.registrations['core/template-part'] = { name: 'core/template-part', attributes: { theme: { type: 'string' }, slug: { type: 'string' } } };
  f.referenceRecord.content.raw = f.window.wp.blocks.serialize([f.window.wp.blocks.createBlock('core/template-part', { slug: 'header' })]);
  const part = { ...copy(f.post), id: 'theme//header', type: 'wp_template_part', theme: 'theme', slug: 'header', source: 'custom', wp_id: 78, status: 'publish' };
  const baseApi = f.api;
  const paths = [];
  f.api = async (request) => {
    paths.push(request.path);

    return request.path.startsWith('/wp/v2/template-parts/theme//header') ? part : baseApi(request);
  };

  const reference = await f.call('inspect_entity', { target: { ...target, post_type: 'wp_block', post_id: 77 } });
  const plan = await f.edit([{ op: 'insert_reference', reference: { entity_type: 'wp_block', entity_id: 77, reference_token: reference.reference_token } }]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.ok(paths.some(path => path.includes('theme//header')));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.referenceRecord.content.raw.includes('core/template-part'), true);
});

test('shared discovery reports a missing permission distinctly from sign-in', async () => {
  const f = sharedFixture();
  await f.call('connect');
  f.api = () => { throw { code: 'rest_cannot_read', data: { status: 403 } }; };

  const listed = await f.call('list_entities', { target: { site_url: target.site_url, user_id: 5 }, entity_type: 'wp_block' });
  assert.deepEqual([listed.error, listed.diagnostics?.wordpress_error], ['permission_denied', 'rest_cannot_read'], JSON.stringify(listed));
});

test('shared discovery and recovery normalize revoked authentication', async () => {
  const f = sharedFixture();
  await f.call('connect');
  await f.call('edit', { scope: 'all_references', edits: changes });
  const save = await f.call('prepare_save');
  assert.equal(save.ok, true, JSON.stringify(save));
  f.auth = false;
  const site = { site_url: target.site_url, user_id: 5 };
  const listed = await f.call('list_entities', { target: site, entity_type: 'wp_block' });
  assert.equal(listed.error, 'reauthorization_required');
  const recovered = await f.call('recover', { target: site, receipt: save.receipt });
  assert.equal(recovered.error, 'reauthorization_required');
  assert.equal(recovered.persistence, 'uncertain');
  f.auth = true;
  f.location.pathname = '/wp-login.php';
  const requests = f.requests.length;
  const signedOut = await f.call('recover', { target: site, receipt: save.receipt });
  assert.deepEqual([signedOut.error, signedOut.persistence, signedOut.next],
    ['reauthorization_required', 'uncertain', 'inspect_do_not_replay'], JSON.stringify(signedOut));
  assert.equal(f.requests.length, requests);
  assert.equal(f.saves, 0);
});

for (const action of ['neighbor', 'cell', 'insert']) {
  test(`nested native table rich text survives ${action} editing and verification`, async () => {
    const f = fixture();

    class RichText {
      #text;
      constructor(text) { this.#text = text; }
      toString() { return this.#text; }
      toJSON() { return this.#text; }
    }

    f.registrations['core/table'] = { name: 'core/table', attributes: { body: { type: 'array', source: 'query', query: {
      cells: { type: 'array', source: 'query', query: { content: { type: 'rich-text' }, tag: { type: 'string' } } },
    } } } };
    const body = [{ cells: [{ content: 'R&amp;D 日本語', tag: 'td' }, { content: '<strong>Keep</strong>', tag: 'td' }] }];
    f.blocks[1] = { name: 'core/table', clientId: 'table', attributes: { body: copy(body) }, innerBlocks: [], isValid: true };
    f.blocks[1].attributes.body[0].cells[0].content = new RichText(body[0].cells[0].content);
    const parse = f.window.wp.blocks.parse;

    f.window.wp.blocks.parse = (text) => parse(text).map((block) => {
      if (block.name === 'core/table') {
        for (const row of block.attributes.body) {
          for (const cell of row.cells) cell.content = new RichText(cell.content);
        }
      }

      return block;
    });
    f.syncContent();

    const inspection = await f.call('connect', { blocks: { client_id: 'table' } });
    assert.deepEqual(JSON.parse(JSON.stringify(inspection.blocks[0].attributes.body)), body);

    const editedBody = copy(body);
    editedBody[0].cells[0].content = 'Changed 日本語';

    const edit = action === 'neighbor' ? changes[0] : action === 'cell'
      ? { op: 'update', path: [1], name: 'core/table', attributes: { body: editedBody } }
      : { op: 'insert', block: { name: 'core/table', attributes: { body: editedBody } } };

    const prepared = await f.edit([edit]);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const saved = await f.save();
    assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
    assert.deepEqual(JSON.parse(JSON.stringify(f.blocks[1].attributes.body)), action === 'cell' ? editedBody : body);
    assert.equal(f.blocks[2].attributes.content, 'Preserve');

    if (action === 'insert') assert.deepEqual(JSON.parse(JSON.stringify(f.blocks[3].attributes.body)), editedBody);
    assert.equal(f.saves, 1);
  });
}

test('native Column border sides, presets and empty side containers survive unrelated values and save', async () => {
  const f = stylingFixture();
  f.registrations['core/column'] = {
    ...f.registrations['core/group'], name: 'core/column',
    supports: { ...f.registrations['core/group'].supports, __experimentalBorder: true },
    attributes: { ...f.registrations['core/group'].attributes, borderColor: { type: 'string' } },
  };
  f.blocks[0].name = 'core/column';
  f.blocks[0].attributes.borderColor = 'accent';
  f.blocks[0].attributes.style.border = { radius: '8px', right: [], left: { width: '2px' } };
  f.syncContent();
  const inspected = await f.call('connect', { style_guides: [{ client_id: 'a' }] });
  const side = inspected.style_guides[0].controls.find(control => control.property.join('.') === 'style.border.right.color');
  assert.ok(side);
  assert.equal(side.preset_attribute, undefined);
  assert.equal(side.preset_value_format, 'var:preset|color|SLUG');
  const edited = await styleEdit(f, [
    { property: ['style', 'border', 'right', 'color'], value: 'var:preset|color|accent' },
    { property: ['style', 'border', 'right', 'width'], value: '1px' },
    { property: ['style', 'border', 'right', 'style'], value: 'solid' },
  ]);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.deepEqual(copy(f.blocks[0].attributes.style.border), {
    color: 'var:preset|color|accent', radius: '8px', left: { width: '2px' },
    right: { color: 'var:preset|color|accent', width: '1px', style: 'solid' },
  });
  assert.equal(f.blocks[0].attributes.borderColor, undefined);
  assert.equal(f.blocks[0].attributes.style.spacing.padding.top, '24px');
  delete f.window.__blockwork_editor;
  const reset = await styleEdit(f, [], [['style', 'border', 'right', 'width']]);
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks[0].attributes.style.border.right.width, undefined);
  assert.equal(f.blocks[0].attributes.style.border.right.color, 'var:preset|color|accent');
});

test('border side controls honor registration and theme restrictions and validate color presets', async () => {
  for (const configure of [
    f => { f.registrations['core/group'].supports.__experimentalBorder = { width: true, color: false }; },
    f => { f.registrations['core/group'].supports.__experimentalBorder = true; f.editorSettings.__experimentalFeatures.border = { color: false }; },
  ]) {
    const f = stylingFixture(); configure(f);
    const result = await styleEdit(f, [{ property: ['style', 'border', 'right', 'color'], value: '#ddd' }]);
    assert.equal(result.error, 'unsupported_style_property');
    assert.equal(result.diagnostics.field, 'edits.0.set.0.property');
    assert.deepEqual(copy(result.diagnostics.property), ['style', 'border', 'right', 'color']);
    assert.equal(result.diagnostics.control_enabled, false);
    assert.equal(f.dirty, false);
    assert.equal(f.saves, 0);
  }

  const f = stylingFixture();
  f.registrations['core/group'].supports.__experimentalBorder = true;
  f.registrations['core/group'].attributes.borderColor = { type: 'string' };
  const preset = await styleEdit(f, [{ property: ['borderColor'], value: 'accent' }]);
  assert.equal(preset.ok, true, JSON.stringify(preset));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks[0].attributes.borderColor, 'accent');
  delete f.window.__blockwork_editor;
  const invalid = await styleEdit(f, [{ property: ['style', 'border', 'left', 'color'], value: 'var:preset|color|private-input' }]);
  assert.equal(invalid.error, 'style_preset_unavailable');
  assert.equal(JSON.stringify(invalid).includes('private-input'), false);
});

test('native background, typography, element colors and duotone controls use exact value shapes', async () => {
  const f = stylingFixture();
  Object.assign(f.registrations['core/group'].supports, {
    background: { backgroundImage: true, backgroundSize: true },
    color: { link: true, button: true, heading: true }, filter: { duotone: true },
    typography: { textAlign: ['left', 'center'], textColumns: true, textIndent: true, __experimentalWritingMode: true },
  });
  const patches = [
    { property: ['style', 'background', 'backgroundImage'], value: { url: 'https://example.test/image.jpg', id: 21, source: 'file' } },
    { property: ['style', 'background', 'backgroundSize'], value: 'cover' },
    { property: ['style', 'background', 'backgroundPosition'], value: '50% 50%' },
    { property: ['style', 'background', 'backgroundRepeat'], value: 'no-repeat' },
    { property: ['style', 'background', 'backgroundAttachment'], value: 'scroll' },
    { property: ['style', 'typography', 'textAlign'], value: 'left' },
    { property: ['style', 'typography', 'textColumns'], value: 2 },
    { property: ['style', 'typography', 'textIndent'], value: '1em' },
    { property: ['style', 'typography', 'writingMode'], value: 'vertical-rl' },
    { property: ['style', 'elements', 'link', 'color', 'text'], value: 'var:preset|color|accent' },
    { property: ['style', 'elements', 'button', 'color', 'background'], value: '#ddd' },
    { property: ['style', 'elements', 'h2', 'color', 'text'], value: '#333' },
    { property: ['style', 'color', 'duotone'], value: ['#111', '#eee'] },
  ];
  const edited = await styleEdit(f, patches);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks[0].attributes.style.typography.fontSize, '20px');
  assert.deepEqual(copy(f.blocks[0].attributes.style.color.duotone), ['#111', '#eee']);

  delete f.window.__blockwork_editor;

  for (const patch of [
    { property: ['style', 'background', 'backgroundImage'], value: { url: 'private-input' } },
    { property: ['style', 'typography', 'textAlign'], value: 'right' },
    { property: ['style', 'color', 'duotone'], value: ['#000'] },
  ]) {
    const result = await styleEdit(f, [patch]);
    assert.equal(result.error, 'unsupported_style_value', JSON.stringify(result));
    assert.equal(result.diagnostics.patch_index, 0);
    assert.equal(result.diagnostics.field, 'edits.0.set.0.value');
    assert.equal(JSON.stringify(result).includes('private-input'), false);
  }

  f.editorSettings.__experimentalFeatures.background = { backgroundSize: false };
  const disabled = await styleEdit(f, [patches[1]]);
  assert.equal(disabled.error, 'unsupported_style_property');
  f.editorSettings.__experimentalFeatures.color.customDuotone = false;
  assert.equal((await styleEdit(f, [patches.at(-1)])).error, 'custom_style_disabled');
});

test('style failures distinguish inserted planned targets from moved pre-existing live targets', async () => {
  for (const inserted of [true, false]) {
    const f = stylingFixture();
    const before = copy(f.blocks);
    await f.call('connect', { workflow: 'attached', style_guides: [{ name: 'core/group' }] });
    const result = await f.call('edit', { edits: [
      { op: 'insert', block: { name: 'core/group' }, index: inserted ? 1 : 0 },
      { op: 'update_style', path: [1], name: 'core/group', set: [{ property: ['style', 'border', 'right', 'color'], value: '#ddd' }] },
    ] });
    assert.equal(result.error, 'unsupported_style_property');
    assert.equal(result.diagnostics.edit_index, 1);
    assert.equal(result.diagnostics.path_space, 'planned');
    assert.equal(result.diagnostics.target_origin, inserted ? 'inserted_block' : 'existing_block');
    assert.deepEqual(copy(result.diagnostics.live_path), inserted ? undefined : [0]);
    assert.equal(result.diagnostics.field, 'edits.1.set.0.property');
    assert.match(result.hint, inserted ? /block this edit inserts/ : /live_path/);
    assert.deepEqual(f.blocks, before);
    assert.equal(f.saves, 0);
  }
});

test('missing required fields explain absence instead of presenting a key name as the expected value', async () => {
  const f = fixture();
  const result = await f.call('read', { target: { site_url: target.site_url, post_id: 7, post_type: 'page' } });
  assert.equal(result.issues[0].path, 'target.user_id');
  assert.equal(result.issues[0].expected, 'required field');
  assert.equal(result.issues[0].constraint, 'required_key');
  assert.match(result.issues[0].hint, /required key at target.user_id is absent/);
  assert.equal(f.window.__blockwork_editor, undefined);
  assert.equal(f.saves, 0);
});


test('update deep merges object members, replaces arrays, then unsets nested values', async () => {
  const f = fixture();
  f.registrations['example/card'].attributes.options = { type: 'object' };
  f.blocks[1].attributes.options = { colors: { foreground: 'red', background: 'white' }, values: [1, 2], retained: true };
  f.syncContent();
  await f.call('connect');
  const edited = await f.call('edit', { edits: [{ op: 'update', client_id: 'b',
    attributes: { options: { colors: { foreground: 'blue' }, values: [3] } }, unset: [['options', 'colors', 'background'], ['variant']] }] });
  assert.equal(edited.editor_result, 'applied', JSON.stringify(edited));
  assert.deepEqual(JSON.parse(JSON.stringify(f.blocks[1].attributes)), { options: { colors: { foreground: 'blue' }, values: [3], retained: true } });
  assert.equal(f.blocks[1].attributes.variant, undefined);
  assert.equal((await f.save()).persistence, 'verified');
});

test('metadata labels preserve native members and refuse agent binding writes', async () => {
  const f = fixture();
  f.registrations['core/paragraph'].attributes.metadata = { type: 'object' };
  f.blocks[0].attributes.metadata = { categories: ['text'], name: 'Before label' };
  f.syncContent(); await f.call('connect');
  assert.equal((await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { metadata: { name: 'After label' } } }] })).ok, true);
  assert.deepEqual(copy(f.blocks[0].attributes.metadata), { categories: ['text'], name: 'After label' });
  const refused = await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { metadata: { name: 'Label', bindings: {} } } }] });
  assert.equal(refused.error, 'unsupported_attribute');
  assert.equal(refused.diagnostics.attribute, 'metadata.bindings');
  assert.equal(refused.diagnostics.constraint, 'allowed_metadata_members_only');
});

test('markup from an inserted pattern round-trips its metadata members', async () => {
  const f = fixture();
  f.registrations['core/paragraph'].attributes.metadata = { type: 'object' };
  await f.call('connect');
  const metadata = { categories: ['text', 7], patternName: 'core/block/12', name: 'Colored border' };
  const markup = f.window.wp.blocks.serialize([{ name: 'core/paragraph', attributes: { content: 'Copied', metadata }, innerBlocks: [] }]);
  const edited = await f.call('edit', { edits: [{ op: 'replace', client_id: 'a', markup }] });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.deepEqual(copy(f.blocks[0].attributes.metadata), metadata);
  const id = f.blocks[0].clientId;
  const resent = await f.call('edit', { edits: [{ op: 'update', client_id: id, attributes: { metadata: { ...metadata, name: 'Renamed' } } }] });
  assert.equal(resent.ok, true, JSON.stringify(resent));

  for (const patternName of ['', 'core/block/13']) {
    const refused = await f.call('edit', { edits: [{ op: 'update', client_id: id, attributes: { metadata: { patternName } } }] });
    assert.equal(refused.error, 'unsupported_attribute', JSON.stringify(refused));
    assert.deepEqual([refused.diagnostics.attribute, refused.diagnostics.constraint], ['metadata.patternName', 'pattern_name_unchanged']);
  }
});

test('read observes returned blocks without REST and permits unrelated human typing', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached' });
  f.blocks[0].attributes.content = 'Human changed target';
  const conflict = await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { content: 'Agent edit' } }] });
  assert.equal(conflict.error, 'block_changed');
  assert.deepEqual(copy(conflict.diagnostics.conflicts), [{ client_id: 'a', name: 'core/paragraph', path: [0], changed: ['content'], edit_index: 0 }]);
  const count = f.requests.length;
  const read = await f.call('read', { blocks: { client_id: 'a' } });
  assert.equal(read.blocks[0].attributes.content, 'Human changed target');
  f.blocks[2].attributes.content = 'Unrelated typing';
  const edited = await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { content: 'Agent edit' } }] });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(f.requests.length, count);
  assert.equal(f.blocks[2].attributes.content, 'Unrelated typing');
});

test('path selectors refuse changes to root and ancestor child lists', async () => {
  for (const level of ['root', 'ancestor']) {
    const f = fixture();
    f.blocks[0] = { name: 'core/group', clientId: 'group', attributes: {}, isValid: true, innerBlocks: [
      { name: 'core/paragraph', clientId: 'nested', attributes: { content: 'Nested' }, innerBlocks: [], isValid: true },
    ] };
    f.syncContent(); await f.call('connect', { workflow: 'attached' });
    const newBlock = f.window.wp.blocks.createBlock('core/paragraph', { content: 'Human insertion' });

    if (level === 'root') f.blocks.push(newBlock);
    else f.blocks[0].innerBlocks.push(newBlock);
    const refused = await f.call('edit', { edits: [{ op: 'update', path: [0, 0], attributes: { content: 'Edited' } }] });
    assert.equal(refused.error, 'block_changed', JSON.stringify(refused));
    assert.equal(refused.diagnostics.conflicts[0].client_id, level === 'root' ? '' : 'group');
    assert.deepEqual(copy(refused.diagnostics.conflicts[0].changed), ['children']);
    assert.equal(f.blocks[0].innerBlocks[0].attributes.content, 'Nested');
    assert.equal((await f.call('edit', { edits: [{ op: 'update', client_id: 'nested', attributes: { content: 'Edited by identity' } }] })).ok, true);
  }
});

test('indexed insertions refuse changed destination lists while append accepts them', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached' });
  f.blocks.push(f.window.wp.blocks.createBlock('core/paragraph', { content: 'Human insertion' }));
  const block = { name: 'core/paragraph', attributes: { content: 'Appended' } };
  const refused = await f.call('edit', { edits: [{ op: 'insert', index: 1, block }] });
  assert.equal(refused.error, 'block_changed');
  assert.equal(refused.diagnostics.conflicts[0].client_id, '');
  assert.equal((await f.call('edit', { edits: [{ op: 'insert', block }] })).ok, true);
  assert.equal(f.blocks.at(-1).attributes.content, 'Appended');
});

test('structural edits check the entire observed target subtree', async () => {
  const f = fixture();
  f.blocks[0] = { name: 'core/group', clientId: 'group', attributes: {}, isValid: true, innerBlocks: [
    { name: 'core/paragraph', clientId: 'nested', attributes: { content: 'Nested' }, innerBlocks: [], isValid: true },
  ] };
  f.syncContent(); await f.call('connect', { workflow: 'attached' });
  f.blocks[0].innerBlocks[0].attributes.content = 'Human typing';
  const refused = await f.call('edit', { edits: [{ op: 'remove', client_id: 'group' }] });
  assert.equal(refused.error, 'block_changed');
  assert.equal(refused.diagnostics.conflicts[0].client_id, 'nested');
  assert.equal(f.blocks[0].innerBlocks[0].attributes.content, 'Human typing');
});

test('field conflicts refuse changed settings until the agent reads them', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached' });
  f.postEdits = { title: 'Human title' }; f.dirty = true;
  const refused = await f.call('edit', { post: { title: 'Agent title' } });
  assert.equal(refused.error, 'field_changed');
  assert.deepEqual(copy(refused.diagnostics.fields), ['title']);
  const count = f.requests.length;
  assert.equal((await f.call('read', { settings: true })).ok, true);
  assert.equal(f.requests.length, count);
  assert.equal((await f.call('edit', { post: { title: 'Agent title' } })).ok, true);
  assert.equal(f.postEdits.title, 'Agent title');
});

test('field conflicts identify changed meta keys', async () => {
  const f = fixture();
  f.post.meta = { note: 'Before', other: 'Same' };
  await f.call('connect', { workflow: 'attached' });
  f.postEdits = { meta: { note: 'Human', other: 'Same' } };
  const refused = await f.call('edit', { settings: { meta: { note: 'Agent' } } });
  assert.equal(refused.error, 'field_changed');
  assert.deepEqual(copy(refused.diagnostics.fields), ['meta.note']);
  assert.equal((await f.call('read', { settings: true })).ok, true);
  assert.equal((await f.call('edit', { settings: { meta: { note: 'Agent' } } })).ok, true);
});

test('revert undoes only the latest edit and can be used once', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached' });
  await f.edit();
  await f.edit([{ op: 'update', client_id: 'c', attributes: { content: 'Second edit' } }]);
  assert.equal((await f.call('status')).revert_available, true);
  assert.equal((await f.call('revert')).editor_result, 'reverted');
  assert.equal(f.blocks[0].attributes.content, 'After');
  assert.equal(f.blocks[2].attributes.content, 'Preserve');
  assert.equal((await f.call('revert')).error, 'revert_not_available');
  assert.equal((await f.call('status')).revert_available, false);
});

test('background save refuses unexpected pending fields and rechecks schema only for settings', async () => {
  const f = fixture();
  await f.edit();
  f.postEdits = { title: 'Foreign pending setting' }; f.dirty = true;
  const refused = await f.call('prepare_save');
  assert.equal(refused.error, 'unexpected_editor_change');
  assert.deepEqual(copy(refused.diagnostics.fields), ['title']);
  f.postEdits = {};
  const before = f.requests.filter(request => request.method === 'OPTIONS').length;
  const prepared = await f.call('prepare_save');
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(f.requests.filter(request => request.method === 'OPTIONS').length, before);
  assert.equal((await f.call('save', { receipt: prepared.receipt })).persistence, 'verified');
  await f.call('edit', { post: { title: 'Requested' } });
  const withSettings = await f.call('prepare_save');
  assert.equal(withSettings.ok, true, JSON.stringify(withSettings));
  assert.equal(f.requests.filter(request => request.method === 'OPTIONS').length, before + 1);
  assert.equal(f.saves, 1);
});

test('a stale field schema refuses persistence without discarding the draft', async () => {
  const f = fixture();
  await f.call('connect');
  await f.call('edit', { post: { title: 'Requested' } });
  f.schema = { title: { type: 'string', maxLength: 20 } };
  const refused = await f.call('prepare_save');
  assert.equal(refused.error, 'stale_settings_schema');
  assert.equal(f.postEdits.title, 'Requested');
  assert.equal(f.saves, 0);
});

test('new native blocks may initialize template children and template locks', async () => {
  const f = fixture();
  f.registrations['core/group'].attributes.templateLock = { type: 'string' };
  f.afterInsert = () => {
    const group = f.blocks.at(-1);
    group.attributes.templateLock = 'all';
    group.innerBlocks = [f.window.wp.blocks.createBlock('core/paragraph', { content: 'Native template child' })];
  };

  const edited = await f.edit([{ op: 'insert', block: { name: 'core/group' } }]);
  assert.equal(edited.editor_result, 'applied', JSON.stringify(edited));
  assert.equal(f.blocks.at(-1).attributes.templateLock, 'all');
  assert.equal(f.blocks.at(-1).innerBlocks[0].attributes.content, 'Native template child');
  assert.ok(edited.changed.some(block => block.client_id === f.blocks.at(-1).innerBlocks[0].clientId));
  assert.equal((await f.save()).persistence, 'verified');
});

test('inserted descendants use allowedBlocks rather than the locked live inserter', async () => {
  const f = fixture();
  f.registrations['core/group'].attributes.templateLock = { type: 'string' };
  f.registrations['core/group'].allowedBlocks = ['core/paragraph'];
  const store = f.window.wp.data.select('core/block-editor');
  const calls = [];
  store.canInsertBlockType = (name, parent) => { calls.push({ name, parent });

 return !parent; };

  store.getTemplateLock = parent => parent?.startsWith('new-') ? 'all' : false;
  f.afterInsert = () => { f.blocks.at(-1).attributes.templateLock = 'all'; };

  const edited = await f.edit([{ op: 'insert', block: { name: 'core/group', inner_blocks: [{ name: 'core/paragraph', attributes: { content: 'Requested child' } }] } }]);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(calls.some(call => call.parent?.startsWith('new-')), false);
  assert.equal(f.blocks.at(-1).innerBlocks[0].attributes.content, 'Requested child');
});

test('edit measurement failure leaves a successful edit and usable revert', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached' });
  const edited = await f.call('edit', { edits: changes, measure: true });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(edited.editor_result, 'applied');
  assert.equal(edited.measure.ok, false);
  assert.equal(edited.measure.error, 'native_render_unavailable');
  assert.equal(f.blocks[0].attributes.content, 'After');
  assert.equal((await f.call('status')).last_request.outcome, 'applied');
  assert.equal((await f.call('revert')).ok, true);
});

test('measure reads the canvas window and reports font loading failures without editor actions', async () => {
  const f = fixture();
  const wrapper = { tagName: 'P', getBoundingClientRect: () => ({ x: 12.34, y: 4, width: 120, height: 30 }), matches: () => false, querySelector: () => null };
  const faces = [{ family: '"Body"', weight: '400', style: 'normal', status: 'error' }, { family: 'Body', weight: '400', style: 'normal', status: 'error' }, { family: 'Display', status: 'loading' }];
  faces.status = 'loading'; faces.ready = Promise.resolve();
  const closed = { ...wrapper, display: 'block', getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }) };
  const contents = { ...closed, display: 'contents' };
  f.frame = { contentDocument: { body: { childElementCount: 1 }, documentElement: { scrollWidth: 400 }, fonts: faces,
    getElementById: id => ({ 'block-a': wrapper, 'block-c': closed })[id] ?? null,
    defaultView: { innerWidth: 400, innerHeight: 800, requestAnimationFrame: callback => callback(),
      getComputedStyle: element => { assert.ok([wrapper, closed, contents].includes(element));

 return { display: element.display, getPropertyValue: property => property === 'font-size' ? '18px' : 'Body' }; } },
  } };
  await f.call('connect', { workflow: 'attached' });
  f.onSelect = () => assert.fail('Measurement changed selection');
  const measured = await f.call('measure', { blocks: ['a', 'b', 'c'], properties: ['font_size', 'font-family'] });
  assert.equal(measured.ok, true, JSON.stringify(measured));
  assert.equal(measured.canvas, 'iframe');
  assert.deepEqual(copy(measured.fonts), { status: 'loading', failed: ['Body 400 normal'], loading: 1 });
  assert.deepEqual(copy(measured.blocks[0].elements[0].rect), { x: 12.3, y: 4, width: 120, height: 30 });
  assert.deepEqual(copy(measured.blocks[0].elements[0].styles), { 'font-size': '18px', 'font-family': 'Body' });
  assert.equal(measured.blocks[1].rendered, false);
  // A closed panel's zero box and styles would read as real geometry.
  assert.deepEqual(copy(measured.blocks[2]), { client_id: 'c', name: 'core/paragraph', rendered: false });
  // A display: contents wrapper has no box of its own, but its children render.
  f.frame.contentDocument.getElementById = id => (id === 'block-c' ? contents : null);
  const unboxed = await f.call('measure', { blocks: ['c'] });
  assert.equal(unboxed.blocks[0].rendered, true);
  assert.equal(f.dirty, false);
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

test('preview release keeps human work made between Blockwork edits', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached', unsaved_preview: true });
  const update = (content) => f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { content } }] });
  assert.equal((await update('Agent one')).ok, true);
  f.blocks[2].attributes.content = 'Human typing';
  assert.equal((await update('Agent two')).ok, true);
  assert.equal((await f.call('release')).error, 'unsaved_preview_pending');
  assert.equal(f.blocks[2].attributes.content, 'Human typing');
  assert.equal(f.savingLocks.size, 1);
});

test('a setting typed during native application is never overwritten', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached' });
  f.onSelect = () => { f.postEdits = { ...f.postEdits, title: 'Human title' }; };

  const edited = await f.call('edit', { post: { title: 'Agent title' }, edits: [{ op: 'insert', block: { name: 'example/card' } }] });
  assert.equal(edited.error, 'field_changed', JSON.stringify(edited));
  assert.equal(f.postEdits.title, 'Human title');
});

test('a child inserted during settings application names the changed parent', async () => {
  const f = fixture();
  f.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, innerBlocks: [] };
  f.syncContent();
  await f.call('connect');
  const actions = f.window.wp.data.dispatch('core/editor');
  const editPost = actions.editPost;
  actions.editPost = (values) => {
    editPost(values);
    f.blocks[1].innerBlocks.push(f.window.wp.blocks.createBlock('core/paragraph', { content: 'Human child' }));
  };

  const result = await f.call('edit', { post: { title: 'Agent title' } });
  assert.equal(result.error, 'prepared_content_changed', JSON.stringify(result));
  assert.deepEqual(copy(result.diagnostics.mismatches.blocks[0]), {
    path: [1], expected_name: 'core/group', actual_name: 'core/group',
    properties: ['children'], truncated: false,
  });
  assert.equal(f.saves, 0);
});

test('a refused reconnect leaves a running operation busy', async () => {
  const f = fixture();
  await f.call('connect');
  f.window.__blockwork_editor.busy = true;
  assert.equal((await f.call('connect')).error, 'operation_in_progress');
  assert.equal(f.window.__blockwork_editor.busy, true);
});

test('attached rollback keeps a new block once someone else changed it', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached' });
  f.onSelect = (id) => {
    const block = f.blocks.find((item) => item.clientId === id && item.name === 'example/card' && item.clientId !== 'b');

    if (block) { block.attributes.variant = 'accent'; throw { code: 'probe-render-failed' }; }
  };

  const edited = await f.call('edit', { edits: [{ op: 'insert', block: { name: 'example/card' } }] });
  assert.equal(edited.editor_result, 'partial', JSON.stringify(edited));
  assert.equal(f.blocks.at(-1).attributes.variant, 'accent');
});

test('a move into a path destination refuses when that path now names another block', async () => {
  const f = fixture();
  const group = (clientId, innerBlocks = []) => ({ name: 'core/group', clientId, isValid: true, attributes: {}, innerBlocks });
  f.blocks = [group('wrapper', [group('first'), group('second')]), { name: 'core/paragraph', clientId: 'p', isValid: true, attributes: { content: 'Move me' }, innerBlocks: [] }];
  f.syncContent();
  await f.call('connect');
  f.blocks[0].innerBlocks.reverse();
  const moved = await f.call('edit', { edits: [{ op: 'move', client_id: 'p', parent: [0, 0] }] });
  assert.equal(moved.error, 'block_changed', JSON.stringify(moved));
  assert.equal(f.blocks[1].clientId, 'p');
});

test('an uncertain save cannot be prepared again until recovered and reconnected', async () => {
  const f = fixture();
  await f.edit();
  f.interruptSave = true;
  assert.equal((await f.save()).persistence, 'uncertain');
  f.interruptSave = false;
  assert.equal((await f.call('prepare_save')).error, 'save_unresolved');
  assert.equal(f.saves, 1);
});

test('generated template children must be supported blocks', async () => {
  const f = fixture();
  const original = f.post.content.raw;
  f.afterInsert = () => { f.blocks.at(-1).innerBlocks = [f.window.wp.blocks.createBlock('core/html', { content: '<b>raw</b>' })]; };

  const edited = await f.edit([{ op: 'insert', block: { name: 'core/group' } }]);
  assert.equal(edited.error, 'unsupported_block', JSON.stringify(edited));
  assert.equal(edited.editor_result, 'partial');
  assert.notEqual(f.window.wp.blocks.serialize(f.blocks), original);
  assert.equal(f.blocks.at(-1).innerBlocks[0].name, 'core/html');
  assert.equal(f.saves, 0);
});

test('reverting a policy setting allows structural edits again', async () => {
  const f = fixture();
  await f.call('connect');
  assert.equal((await f.call('edit', { post: { template: 'landing' } })).ok, true);
  assert.equal((await f.call('revert')).ok, true);
  const edited = await f.call('edit', { edits: [{ op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'New' } } }] });
  assert.equal(edited.ok, true, JSON.stringify(edited));
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

test('a background save refuses a requested setting that later changed again', async () => {
  const f = fixture();
  await f.call('connect');
  assert.equal((await f.call('edit', { post: { status: 'private' } })).ok, true);
  f.postEdits = { ...f.postEdits, status: 'publish' };
  const refused = await f.call('prepare_save');
  assert.equal(refused.error, 'unexpected_editor_change', JSON.stringify(refused));
  assert.deepEqual(copy(refused.diagnostics.fields), ['status']);
  assert.equal(f.saves, 0);
});

test('a native meta change names its key, and sending the value to keep clears it', async () => {
  for (const requestedFirst of [false, true]) {
    const f = fixture();
    f.post.meta = { example_gallery: [1, 2], note: 'Before' };
    f.schema = { meta: { type: 'object', properties: { example_gallery: { type: 'array' }, note: { type: 'string' } } } };
    await f.call('connect');

    if (requestedFirst) assert.equal((await f.call('edit', { settings: { meta: { note: 'After' } } })).ok, true);

    f.postEdits = { ...f.postEdits, meta: { ...(f.postEdits?.meta ?? f.post.meta), example_gallery: [2] } };
    const refused = await f.call('prepare_save');
    assert.equal(refused.error, 'unexpected_editor_change', JSON.stringify(refused));
    assert.deepEqual(copy(refused.diagnostics.fields), ['meta.example_gallery']);
    assert.match(refused.hint, /Reading never clears a field/);
    assert.equal((await f.call('read', { settings: true })).ok, true);
    const kept = await f.call('edit', { settings: { meta: { example_gallery: [2] } } });
    assert.equal(kept.ok, true, JSON.stringify(kept));
    assert.equal((await f.save()).persistence, 'verified');
    assert.deepEqual(f.post.meta, { example_gallery: [2], note: requestedFirst ? 'After' : 'Before' });
  }
});

test('an append does not absorb an unread deletion before a background save', async () => {
  const f = fixture();
  await f.call('connect');
  f.blocks.splice(2, 1);
  const appended = await f.call('edit', { edits: [{ op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'Appended' } } }] });
  assert.equal(appended.ok, true, JSON.stringify(appended));
  const refused = await f.call('prepare_save');
  assert.equal(refused.error, 'unexpected_editor_change', JSON.stringify(refused));
  assert.deepEqual(copy(refused.diagnostics.blocks.find((block) => block.client_id === '')), { client_id: '', name: 'root' });
  await f.call('read', { blocks: 'roots' });
  assert.equal((await f.save()).persistence, 'verified');
});

test('a scheduling edit refuses a date someone else changed since connect', async () => {
  const f = fixture();
  await f.call('connect');
  f.postEdits = { ...f.postEdits, date_gmt: '2099-03-01T00:00:00' };
  const refused = await f.call('edit', { post: { status: 'future', date_gmt: '2099-01-01T12:00:00' } });
  assert.equal(refused.error, 'field_changed', JSON.stringify(refused));
  assert.equal(f.postEdits.date_gmt, '2099-03-01T00:00:00');
});

test('concurrent first connections install one session', async () => {
  const f = fixture();
  const results = await Promise.all([f.call('connect'), f.call('connect')]);
  assert.deepEqual(results.map((result) => result.ok ?? false).sort(), [false, true], JSON.stringify(results));
  assert.equal(results.find((result) => !result.ok).error, 'operation_in_progress');
});

test('an attached save accepts a native autosave from the same editor', async () => {
  const f = fixture();
  assert.equal((await f.call('connect', { workflow: 'attached' })).ok, true);
  assert.equal((await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { content: 'After' } }] })).ok, true);
  f.autosave();
  const saved = await f.save({ save_all_pending: true });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.persistence, 'unchanged');

  assert.equal((await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { content: 'Later' } }] })).ok, true);
  f.loadedPost = copy(f.post);
  f.post.content.raw = 'another tab';
  const refused = await f.save({ save_all_pending: true });
  assert.equal(refused.error, 'saved_record_changed', JSON.stringify(refused));
  assert.match(refused.hint, /diagnostics.fields/);
  assert.equal(f.saves, 0);

  // A foreign record the store adopted without a save is still someone else's.
  f.loadedPost = undefined;
  const adopted = await f.save({ save_all_pending: true });
  assert.equal(adopted.error, 'saved_record_changed', JSON.stringify(adopted));
  assert.equal(f.saves, 0);
});

test('a draft autosave with meta boxes leaves foreign meta changes refused', async () => {
  const f = fixture();
  f.hasMetaBoxes = true;
  assert.equal((await f.call('connect', { workflow: 'attached' })).ok, true);
  assert.equal((await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { content: 'After' } }] })).ok, true);
  // Core posts meta box forms after full saves only, so an autosave's baseline stays complete.
  f.autosave();
  f.post.meta = { ...f.post.meta, another_writer: 'changed' };
  const refused = await f.save({ save_all_pending: true });
  assert.equal(refused.error, 'saved_record_changed', JSON.stringify(refused));
  assert.deepEqual(copy(refused.diagnostics.fields), ['meta.another_writer']);
  assert.equal(f.saves, 0);
});

test('edits and saves wait for a running native autosave', async () => {
  const f = fixture();
  assert.equal((await f.call('connect', { workflow: 'attached' })).ok, true);
  f.saving = true;
  setTimeout(() => { f.saving = false; }, 120);
  const edited = await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { content: 'After' } }] });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  f.saving = true;
  setTimeout(() => { f.saving = false; }, 120);
  assert.equal((await f.save({ save_all_pending: true })).persistence, 'verified');
});

test('save verification accepts PHP re-serialization and explains real differences', async () => {
  const rewrite = (f, change) => {
    const actions = f.window.wp.data.dispatch('core/editor');
    const save = actions.savePost;
    actions.savePost = async () => { await save(); f.post.content.raw = change(f.post.content.raw); };
  };

  const f = fixture();
  f.blocks[1] = { name: 'core/group', clientId: 'b', isValid: true, innerBlocks: [], attributes: { style: { spacing: {} } } };
  f.syncContent();
  rewrite(f, (raw) => raw.replaceAll('{}', '[]'));
  await f.edit();
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));

  const filtered = fixture();
  rewrite(filtered, (raw) => raw.replace('"After"', '"Filtered"'));
  await filtered.edit();
  const mismatch = await filtered.save();
  assert.equal(mismatch.error, 'verification_mismatch', JSON.stringify(mismatch));
  assert.equal(mismatch.persistence, 'uncertain');
  assert.deepEqual(copy(mismatch.diagnostics.fields), []);
  assert.deepEqual(copy(mismatch.diagnostics.blocks), [{ path: [0], properties: ['attributes.content'], truncated: false }]);
  assert.match(mismatch.hint, /diagnostics\.blocks/);
  const recovered = await filtered.call('recover', { target: { site_url: target.site_url, user_id: 5 }, receipt: mismatch.receipt });
  assert.equal(recovered.error, 'saved_record_different', JSON.stringify(recovered));
  assert.equal(recovered.outcome, 'different');
  filtered.post.meta = { note: 'Also changed' };
  const both = await filtered.call('recover', { target: { site_url: target.site_url, user_id: 5 }, receipt: mismatch.receipt });
  assert.equal(both.error, 'saved_record_different', JSON.stringify(both));
});

test('written styles drop nested empty objects without touching other values', async () => {
  const f = fixture();
  await f.call('connect');
  const inserted = await f.call('edit', { edits: [{ op: 'insert', block: { name: 'core/group',
    attributes: { style: { border: {}, spacing: { padding: { top: '4px' }, margin: {} } } } } }] });
  assert.equal(inserted.ok, true, JSON.stringify(inserted));
  const group = f.blocks.at(-1);
  assert.deepEqual(copy(group.attributes.style), { spacing: { padding: { top: '4px' } } });
  const updated = await f.call('edit', { edits: [{ op: 'update', client_id: group.clientId, attributes: { style: { color: {}, spacing: { padding: { left: '2px' } } } } }] });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.deepEqual(copy(group.attributes.style), { spacing: { padding: { top: '4px', left: '2px' } } });

  group.attributes.layout = { type: 'flex', options: { empty: {} } };
  group.attributes.style.typography = {};
  await f.call('read', { blocks: { client_id: group.clientId, depth: 0 } });
  const kept = await f.call('edit', { edits: [{ op: 'update', client_id: group.clientId, attributes: { layout: { options: { label: 'x' } }, style: { color: { text: 'red' } } } }] });
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.deepEqual(copy(group.attributes.layout), { type: 'flex', options: { empty: {}, label: 'x' } });
  assert.deepEqual(copy(group.attributes.style.typography), {});
});

test('slow native rendering finishes while every block keeps making progress', async () => {
  const f = fixture();
  f.onSelect = () => { f.elapsedMs = (f.elapsedMs ?? 0) + 1200; };

  const plan = await f.edit([{ op: 'insert', block: { name: 'core/group', inner_blocks:
    Array.from({ length: 9 }, (_, i) => ({ name: 'core/paragraph', attributes: { content: String(i) } })),
  } }]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.ok(f.elapsedMs >= 12000, String(f.elapsedMs));

  const capped = fixture();
  capped.onSelect = () => { capped.elapsedMs = (capped.elapsedMs ?? 0) + 4000; };

  const original = capped.post.content.raw;
  const refused = await capped.edit([{ op: 'insert', block: { name: 'core/group', inner_blocks:
    Array.from({ length: 9 }, (_, i) => ({ name: 'core/paragraph', attributes: { content: String(i) } })),
  } }]);
  assert.equal(refused.error, 'native_initialization_unsettled', JSON.stringify(refused));
  assert.equal(refused.diagnostics.cap_ms, 30000);
  assert.ok(refused.diagnostics.elapsed_ms >= 30000);
  assert.equal(capped.window.wp.blocks.serialize(capped.blocks), original);
});

test('a block that never renders fails after the stall interval', async () => {
  const f = fixture();
  f.afterInsert = () => { f.stuck = `block-${f.blocks.at(-1).innerBlocks[0].clientId}`; };

  f.isRendered = (id) => id !== f.stuck;
  let polls = 0;
  const pause = setInterval(() => { polls++; f.elapsedMs = (f.elapsedMs ?? 0) + 1000; }, 5);
  const plan = await f.edit([{ op: 'insert', block: { name: 'core/group', inner_blocks: [{ name: 'core/paragraph', attributes: { content: 'Stuck' } }] } }]);
  clearInterval(pause);
  assert.equal(plan.error, 'native_initialization_unsettled', JSON.stringify(plan));
  assert.equal(plan.diagnostics.stall_ms, 5000);
  assert.ok(plan.diagnostics.elapsed_ms < 30000);
  assert.ok(polls > 0);
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

test('a lock attribute at its default is a no-op only on a new block', async () => {
  const f = fixture();
  f.registrations['core/group'].attributes.templateLock = { type: ['string', 'boolean'], enum: ['all', 'insert', 'contentOnly', false], default: false };
  const inserted = await f.edit([{ op: 'insert', block: { name: 'core/group', attributes: { templateLock: false } } }]);
  assert.equal(inserted.ok, true, JSON.stringify(inserted));

  const locking = await f.call('edit', { edits: [{ op: 'insert', block: { name: 'core/group', attributes: { templateLock: 'all' } } }] });
  assert.equal(locking.error, 'unsupported_attribute');

  const locked = fixture();
  locked.registrations['core/group'].attributes.templateLock = f.registrations['core/group'].attributes.templateLock;
  locked.blocks[0] = { name: 'core/group', clientId: 'group', attributes: { templateLock: 'all' }, innerBlocks: [] };
  locked.syncContent();
  const unlocking = await locked.edit([{ op: 'update', path: [0], name: 'core/group', attributes: { templateLock: false } }]);
  assert.equal(unlocking.error, 'unsupported_attribute');
});

test('engine failures carry the native error as debug only in a development build', async () => {
  const { editor } = await bundles({ debug: false });

  for (const [engine, message] of [[source, 'secret'], [editor, undefined]]) {
    const f = fixture('page', undefined, engine);
    f.auth = false;
    const expired = await f.call('connect', { target: { site_url: target.site_url, post_id: 7, post_type: 'page' }, workflow: 'attached' });
    assert.equal(expired.error, 'reauthorization_required');
    assert.equal(expired.debug?.message, message);
    assert.equal(outsideDebug(expired).includes('secret'), false);
  }
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

test('save verification keeps the exact markup of blocks Gutenberg cannot rebuild', async () => {
  const f = fixture();
  f.blocks[1] = { name: 'example/legacy', attributes: { old: 'kept' }, clientId: 'b', innerBlocks: [], isValid: false };
  f.syncContent();
  const actions = f.window.wp.data.dispatch('core/editor');
  const save = actions.savePost;
  actions.savePost = async () => { await save(); f.post.content.raw = f.post.content.raw.replace('{"name":"example/legacy"', '{"html":"rewritten","name":"example/legacy"'); };

  await f.edit();
  await f.call('read', { blocks: 'all' });
  const result = await f.save();
  assert.equal(result.error, 'verification_mismatch', JSON.stringify(result));
  assert.deepEqual(copy(result.diagnostics.blocks), [{ path: [1], properties: ['original_markup'], truncated: false }]);
});

test('recover and reconnect accept a lost save that PHP re-serialized', async () => {
  const f = fixture();
  f.blocks[1] = { name: 'core/group', clientId: 'b', isValid: true, innerBlocks: [], attributes: { style: { spacing: {} } } };
  f.syncContent();
  const actions = f.window.wp.data.dispatch('core/editor');
  const save = actions.savePost;
  actions.savePost = async () => {
    await save().catch(() => undefined);
    f.post.content.raw = f.post.content.raw.replaceAll('{}', '[]');
    throw new Error('connection-lost');
  };

  await f.edit();
  const lost = await f.save();
  assert.equal(lost.persistence, 'uncertain', JSON.stringify(lost));
  const receipt = (await f.call('status')).receipt;
  const parse = f.window.wp.blocks.parse;
  f.window.wp.blocks.parse = undefined;
  const elsewhere = await f.call('recover', { target: { site_url: target.site_url, user_id: target.user_id }, receipt });
  f.window.wp.blocks.parse = parse;
  assert.equal(elsewhere.error, 'recover_requires_editor', JSON.stringify(elsewhere));
  const recovered = await f.call('recover', { target: { site_url: target.site_url, user_id: target.user_id }, receipt });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.outcome, 'matched_desired');
  assert.equal((await f.call('connect')).ok, true);
  const prepared = await f.call('prepare_save');
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(f.saves, 1);
});

// A canvas document's root element; zoomedOut marks Gutenberg's zoom-out mode.
const canvasRoot = (state = {}) => ({ scrollWidth: 500, classList: { contains: (name) => name === 'is-zoomed-out' && Boolean(state.zoomedOut) } });

test('a failed view leaves its checkpoint, and the next operation restores the editor', async () => {
  const f = fixture();
  const scroller = { scrollTop: 40, scrollLeft: 0, scrollTo({ top, left }) { this.scrollTop = top; this.scrollLeft = left; } };
  f.frame = { contentDocument: { body: { childElementCount: 1 }, documentElement: canvasRoot(), scrollingElement: scroller, getElementById: () => null },
    parentElement: null, closest: () => null, getBoundingClientRect: () => ({ width: 100, height: 100, left: 0, top: 0 }),
    get clientWidth() { return f.device === 'Mobile' ? 479 : 100; } };
  f.device = 'Desktop';
  f.window.wp.data.select('core/editor').getDeviceType = () => f.device;
  f.window.wp.data.dispatch('core/editor').setDeviceType = (device) => { f.device = device; };

  await f.call('connect', { workflow: 'attached' });

  const failed = await f.call('view', { client_id: 'a', width: 'mobile' });
  assert.equal(failed.error, 'block_not_rendered', JSON.stringify(failed));
  assert.equal(f.device, 'Mobile');
  scroller.scrollTop = 900;
  assert.equal((await f.call('read')).ok, true);
  assert.equal(f.device, 'Desktop');
  assert.equal(scroller.scrollTop, 40);
  assert.equal(f.window.__blockwork_editor.view, undefined);
});

test('view places a display: contents block by its children', async () => {
  const f = fixture();
  const child = (top, height) => ({ display: 'block', children: [], getBoundingClientRect: () => ({ left: 10, top, right: 110, bottom: top + height }) });
  const wrapper = { display: 'contents', children: [child(20, 30), child(60, 40)], querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) };
  f.window.innerWidth = 1000;
  f.window.innerHeight = 1000;
  f.frame = { contentDocument: { body: { childElementCount: 1 }, documentElement: canvasRoot(), getElementById: (id) => (id === 'block-a' ? wrapper : null) },
    contentWindow: { getComputedStyle: (element) => ({ display: element.display }), requestAnimationFrame: (callback) => callback() },
    parentElement: null, closest: () => null, clientLeft: 0, clientTop: 0, clientWidth: 500, clientHeight: 800,
    getBoundingClientRect: () => ({ width: 500, height: 800, left: 0, top: 0 }) };
  f.window.wp.data.select('core/editor').getDeviceType = () => 'Desktop';
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('The device was already desktop');

  await f.call('connect', { workflow: 'attached' });
  const placed = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.equal(placed.rendered, true, JSON.stringify(placed));
  assert.equal(placed.block_height, 80);
  assert.deepEqual(copy(placed.clip), { x: 10, y: 20, width: 100, height: 80 });
  // The host's clip is in document pixels, so the page's own scroll is added.
  f.window.scrollY = 40;
  assert.deepEqual(copy((await f.call('view', { client_id: 'a', width: 'desktop' })).clip), { x: 10, y: 60, width: 100, height: 80 });
});

test('view waits briefly for a just-edited block to lay out before reporting it hidden', async () => {
  for (const laidOutAfter of [3, Infinity]) {
    const f = fixture();
    let checks = 0;
    const block = { display: 'block', children: [], querySelectorAll: () => [], getBoundingClientRect: () => (++checks > laidOutAfter
      ? { left: 10, top: 20, right: 110, bottom: 70 } : { left: 0, top: 0, right: 0, bottom: 0 }) };
    f.window.innerWidth = 1000;
    f.window.innerHeight = 1000;
    f.frame = { contentDocument: { body: { childElementCount: 1 }, documentElement: canvasRoot(), getElementById: (id) => (id === 'block-a' ? block : null) },
      contentWindow: { getComputedStyle: (element) => ({ display: element.display }), requestAnimationFrame: (callback) => callback() },
      parentElement: null, closest: () => null, clientLeft: 0, clientTop: 0, clientWidth: 500, clientHeight: 800,
      getBoundingClientRect: () => ({ width: 500, height: 800, left: 0, top: 0 }) };
    f.window.wp.data.select('core/editor').getDeviceType = () => 'Desktop';
    f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('The device was already desktop');
    await f.call('connect', { workflow: 'attached' });
    const started = Date.now();
    const placed = await f.call('view', { client_id: 'a', width: 'desktop' });
    assert.equal(placed.ok, true, JSON.stringify(placed));
    assert.equal(placed.rendered, laidOutAfter !== Infinity, JSON.stringify(placed));
    assert.ok(Date.now() - started < 2000);
  }
});

test('view scrolls a card row to the block and restores it, and reports a card clipped by its track', async () => {
  const f = fixture();
  f.window.innerWidth = 1000;
  f.window.innerHeight = 1000;
  // A row 500px wide whose sixth card starts 600px in, past its right edge.
  const row = (overflowX, width = 500) => ({ overflowX, display: 'flex', scrollLeft: 0, scrollTop: 0, scrollWidth: 1000, clientWidth: width, clientTop: 0,
    clientHeight: 300, clientLeft: 0, parentElement: null, getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: 300 }),
    scrollTo({ left }) { this.scrollLeft = left; } });
  const card = (parent, left = 600) => ({ display: 'block', parentElement: parent, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: left - parent.scrollLeft, top: 20, right: left + 100 - parent.scrollLeft, bottom: 100 }) });
  let block;
  f.frame = { contentDocument: { body: { childElementCount: 1 }, documentElement: canvasRoot(), getElementById: (id) => (id === 'block-a' ? block : null) },
    contentWindow: { getComputedStyle: (element) => ({ display: element.display, overflowX: element.overflowX ?? 'visible', overflowY: 'visible' }),
      requestAnimationFrame: (callback) => callback() },
    parentElement: null, closest: () => null, clientLeft: 0, clientTop: 0, clientWidth: 500, clientHeight: 800,
    getBoundingClientRect: () => ({ width: 500, height: 800, left: 0, top: 0 }) };
  f.window.wp.data.select('core/editor').getDeviceType = () => 'Desktop';
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('The device was already desktop');
  await f.call('connect', { workflow: 'attached' });

  const scrolling = row('auto');
  block = card(scrolling);
  const placed = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.equal(placed.rendered, true, JSON.stringify(placed));
  assert.deepEqual(copy(placed.clip), { x: 0, y: 20, width: 100, height: 80 });
  assert.equal(scrolling.scrollLeft, 600);
  assert.equal((await f.call('restore_view')).ok, true);
  assert.equal(scrolling.scrollLeft, 0);

  block = card(row('hidden'));
  const clipped = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.equal(clipped.error, 'block_clipped', JSON.stringify(clipped));
  assert.match(clipped.hint, /container block/);

  // A 100px track inside the canvas hides a slide 200px in, and half of one 50px in.
  block = card(row('hidden', 100), 200);
  assert.equal((await f.call('view', { client_id: 'a', width: 'desktop' })).error, 'block_clipped');
  block = card(row('hidden', 100), 50);
  const half = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual([half.clipped, half.clip.width, half.next_offset], [true, 50, null]);
});

test('view shows only the part of a block its containers leave visible, and slices only toward more of it', async () => {
  const f = fixture();
  f.window.innerWidth = 1000;
  f.window.innerHeight = 1000;
  const parent = (top, bottom) => ({ display: 'block', overflowX: 'visible', overflowY: 'hidden', parentElement: null, clientLeft: 0, clientTop: 0,
    clientWidth: 500, clientHeight: bottom - top, getBoundingClientRect: () => ({ left: 0, top, right: 500, bottom }) });
  const child = (container, top, bottom) => ({ display: 'block', parentElement: container, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top, right: 400, bottom }) });
  let block;
  f.frame = { contentDocument: { body: { childElementCount: 1 }, documentElement: canvasRoot(), getElementById: (id) => (id === 'block-a' ? block : null) },
    contentWindow: { getComputedStyle: (element) => ({ display: element.display, overflowX: element.overflowX ?? 'visible', overflowY: element.overflowY ?? 'visible' }),
      requestAnimationFrame: (callback) => callback() },
    parentElement: null, closest: () => null, clientLeft: 0, clientTop: 0, clientWidth: 500, clientHeight: 800,
    getBoundingClientRect: () => ({ width: 500, height: 800, left: 0, top: 0 }) };
  f.window.wp.data.select('core/editor').getDeviceType = () => 'Desktop';
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('The device was already desktop');
  await f.call('connect', { workflow: 'attached' });

  // A container hides the top 50px of a 100px block.
  block = child(parent(50, 300), 0, 100);
  const top = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual([top.from, top.to, top.clipped, top.next_offset], [50, 100, true, null], JSON.stringify(top));
  // An 800px container at the canvas's own height hides the rest of a 1600px block.
  block = child(parent(0, 800), 0, 1600);
  const tall = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual([tall.from, tall.to, tall.clipped, tall.next_offset], [0, 800, true, null], JSON.stringify(tall));
  // Without the container, the canvas edge cuts it and the next slice continues.
  block = child(null, 0, 1600);
  const open = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual([open.to, open.clipped, open.next_offset], [800, false, 800], JSON.stringify(open));
});

test('view starts the first slice where a container shows the block after its images load', async () => {
  const f = fixture();
  f.window.innerWidth = 1000;
  f.window.innerHeight = 1000;
  // The canvas scrolls a document where an 800px container at 1000px hides the
  // top of a bottom-aligned block, which grows from 850px to 1700px once its
  // image loads.
  const doc = { scrollTop: 0, scrollLeft: 0, scrollTo({ top }) { this.scrollTop = top; } };
  const rect = (top, bottom) => ({ left: 0, right: 400, top: top - doc.scrollTop, bottom: bottom - doc.scrollTop });
  let height = 850;
  let ready = false;
  let checks = 0;
  const image = { get complete() {
    if (!checks++) setTimeout(() => { height = 1700; ready = true; }, 10);

    return ready;
  } };
  const container = { display: 'block', overflowX: 'visible', overflowY: 'hidden', parentElement: null, clientLeft: 0, clientTop: 0,
    clientWidth: 500, clientHeight: 800, getBoundingClientRect: () => rect(1000, 1800) };
  const block = { display: 'block', parentElement: container, querySelectorAll: () => [image], getBoundingClientRect: () => rect(1800 - height, 1800) };
  f.frame = { contentDocument: { body: { childElementCount: 1 }, documentElement: canvasRoot(), scrollingElement: doc,
    getElementById: (id) => (id === 'block-a' ? block : null) },
    contentWindow: { getComputedStyle: (element) => ({ display: element.display, overflowX: element.overflowX ?? 'visible', overflowY: element.overflowY ?? 'visible' }),
      requestAnimationFrame: (callback) => callback() },
    parentElement: null, closest: () => null, clientLeft: 0, clientTop: 0, clientWidth: 500, clientHeight: 800,
    getBoundingClientRect: () => ({ width: 500, height: 800, left: 0, top: 0 }) };
  f.window.wp.data.select('core/editor').getDeviceType = () => 'Desktop';
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('The device was already desktop');
  await f.call('connect', { workflow: 'attached' });

  const placed = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual([placed.from, placed.to, placed.clipped, placed.next_offset], [900, 1700, true, null], JSON.stringify(placed));
});

// The in-app browser aborts Gutenberg's blob canvas navigation and leaves an
// empty about:blank document until Blockwork reloads it through srcdoc.
const stalledCanvas = (f, block, { mounts = true } = {}) => {
  const view = { innerWidth: 500, innerHeight: 800, requestAnimationFrame: (callback) => callback(),
    getComputedStyle: () => ({ display: 'block', getPropertyValue: () => '' }) };
  const canvas = { URL: 'about:blank', readyState: 'complete', body: { childElementCount: 0 },
    documentElement: canvasRoot(), defaultView: view, getElementById: () => null };
  f.canvasHtml = '<!doctype html><html><body>Native canvas fixture</body></html>';
  f.frame = { src: 'blob:https://example.test/native-canvas', isConnected: true, contentDocument: canvas, contentWindow: view,
    parentElement: null, closest: () => null, clientLeft: 0, clientTop: 0, clientWidth: 500, clientHeight: 800,
    getBoundingClientRect: () => ({ width: 500, height: 800, left: 0, top: 0 }),
    get srcdoc() { return this.html ?? ''; },
    set srcdoc(value) {
      this.html = value;

      if (!mounts) {
        f.elapsedMs = 6000;

        return;
      }

      // Gutenberg mounts the canvas, then renders blocks into it a little later.
      setTimeout(() => { canvas.URL = 'about:srcdoc'; canvas.body.childElementCount = 1; }, 20);
      setTimeout(() => { canvas.getElementById = (id) => (id === 'block-a' ? block : null); }, 40);
    } };
  f.window.wp.data.select('core/editor').getDeviceType = () => 'Desktop';
};

const canvasBlock = () => ({ tagName: 'P', matches: () => false, querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 80, left: 10, top: 20, right: 110, bottom: 100 }) });

test('view mounts a blank native canvas and waits for the block before placing it', async () => {
  const f = fixture();
  f.window.innerWidth = 1000;
  f.window.innerHeight = 1000;
  stalledCanvas(f, canvasBlock());
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('The device was already desktop');

  await f.call('connect', { workflow: 'attached' });
  const placed = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.equal(placed.rendered, true, JSON.stringify(placed));
  assert.deepEqual(copy(placed.clip), { x: 10, y: 20, width: 100, height: 80 });
  assert.equal(f.frame.srcdoc, f.canvasHtml);
  assert.equal(f.blobReads, 1);
});

test('measure at a device width waits for blocks in a newly mounted canvas', async () => {
  const f = fixture();
  stalledCanvas(f, canvasBlock());
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('The device was already desktop');

  await f.call('connect', { workflow: 'attached' });
  const measured = await f.call('measure', { blocks: ['a'], width: 'desktop' });
  assert.equal(measured.ok, true, JSON.stringify(measured));
  assert.equal(measured.blocks[0].rendered, true);
  assert.equal(f.blobReads, 1);
});

test('view reports a canvas that stays blank after reloading it, before changing the device', async () => {
  const f = fixture();
  stalledCanvas(f, null, { mounts: false });
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('A blank canvas changed the device');

  await f.call('connect', { workflow: 'attached' });
  const failed = await f.call('view', { client_id: 'a', width: 'mobile' });
  assert.equal(failed.error, 'native_render_unavailable', JSON.stringify(failed));
  assert.equal(failed.diagnostics.canvas_reloaded, true);
  assert.match(failed.hint, /front end/);
  assert.equal(f.blobReads, 1);
});

// An editor whose Desktop canvas is the window less 350px of List View, and
// whose Tablet preview is a 781px resizable canvas inside 24px of padding.
const sizedEditor = (f) => {
  const box = { style: { width: '100%' } };
  f.box = box;
  f.device = 'Desktop';
  f.window.innerWidth = 1280;
  f.window.innerHeight = 1080;
  const space = () => f.window.innerWidth - 350;
  const set = () => Number.parseFloat(box.style.width);
  const width = () => (box.style.width.endsWith('px') ? Math.min(set(), space() - 48) : space());
  const view = { get innerWidth() { return width(); }, innerHeight: 900, requestAnimationFrame: (callback) => callback(),
    getComputedStyle: () => ({ display: 'block', overflowX: 'visible', getPropertyValue: () => '' }) };
  f.frame = { contentDocument: { body: { childElementCount: 1 }, defaultView: view, documentElement: canvasRoot(f),
    getElementById: (id) => (id === 'block-a' ? canvasBlock() : null) },
    contentWindow: view, parentElement: null, clientLeft: 0, clientTop: 0, clientHeight: 900, closest: () => box,
    get clientWidth() { return width(); },
    getBoundingClientRect: () => ({ width: width(), height: 900, left: 0, top: 0 }) };
  f.window.wp.data.select('core/editor').getDeviceType = () => f.device;
  f.window.wp.data.dispatch('core/editor').setDeviceType = (device) => {
    f.device = device;
    box.style.width = { Tablet: '781px', Mobile: '479px' }[device] ?? '100%';
  };
};

test('view sizes the canvas only in its own tab and refuses widths a user editor cannot show', async () => {
  const owned = fixture();
  sizedEditor(owned);
  await owned.call('connect');
  const resize = await owned.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual(copy(resize.resize), { width: 'desktop', canvas_width: 930, target_width: 1440, window_width: 1790 });
  assert.equal(resize.rendered, undefined);
  owned.window.innerWidth = 1790;
  const placed = await owned.call('view', { client_id: 'a', width: 'desktop' });
  assert.equal(placed.rendered, true, JSON.stringify(placed));
  assert.deepEqual([placed.canvas_width, placed.width_source, placed.clipped], [1440, 'exact', false]);
  // A 400px canvas would need a 750px window, where wp-admin covers the canvas.
  const narrow = await owned.call('view', { client_id: 'a', width: 400 });
  assert.equal(narrow.error, 'width_unavailable', JSON.stringify(narrow));
  assert.equal(narrow.diagnostics.window_width, 750);

  const user = fixture();
  sizedEditor(user);
  await user.call('connect', { workflow: 'attached' });
  const exact = await user.call('view', { client_id: 'a', width: 1440 });
  assert.equal(exact.error, 'width_requires_background', JSON.stringify(exact));
  assert.equal(user.device, 'Desktop');
  user.window.innerWidth = 1100;
  const squeezed = await user.call('view', { client_id: 'a', width: 'tablet' });
  assert.equal(squeezed.error, 'width_unavailable', JSON.stringify(squeezed));
  assert.deepEqual(copy(squeezed.diagnostics), { width: 'tablet', canvas_width: 702, target_width: 781 });
  assert.equal((await user.call('restore_view')).ok, true);
  assert.equal(user.device, 'Desktop');
  const own = await user.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual([own.canvas_width, own.width_source], [750, 'user_editor']);
});

test('a user editor dragged to its own canvas width is never switched away from it', async () => {
  const f = fixture();
  sizedEditor(f);
  await f.call('connect', { workflow: 'attached' });
  f.device = 'Tablet';
  f.box.style.width = '600px';
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('A custom canvas width was reset');

  for (const width of ['tablet', 'mobile', 'desktop']) {
    const refused = await f.call('view', { client_id: 'a', width });
    assert.equal(refused.error, 'custom_canvas_width', JSON.stringify(refused));
    assert.deepEqual(copy(refused.diagnostics), { width, device: 'Tablet', canvas_width: 600 });
  }

  // Zoomed out, Gutenberg reports Desktop and hides its stored width.
  assert.equal((await f.call('restore_view')).ok, true);
  f.device = 'Desktop';
  f.box.style.width = '100%';
  f.zoomedOut = true;
  assert.equal((await f.call('view', { client_id: 'a', width: 'tablet' })).error, 'custom_canvas_width');
  assert.equal((await f.call('view', { client_id: 'a', width: 'desktop' })).width_source, 'user_editor');
  f.zoomedOut = false;

  // A custom width wider than the tablet range is a Desktop canvas, shown as is.
  assert.equal((await f.call('restore_view')).ok, true);
  f.device = 'Desktop';
  f.box.style.width = '880px';
  const own = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual([own.rendered, own.canvas_width, own.width_source], [true, 880, 'user_editor']);
  assert.equal((await f.call('view', { client_id: 'a', width: 'mobile' })).error, 'custom_canvas_width');
});

test('a width the user drags after a lost restore stays theirs', async () => {
  const f = fixture();
  sizedEditor(f);
  f.window.innerWidth = 1600;
  await f.call('connect', { workflow: 'attached' });
  assert.equal((await f.call('measure', { blocks: ['a'], width: 'tablet' })).width_source, 'preset');
  // The host's restore never arrives, and the user drags the Tablet canvas.
  f.box.style.width = '600px';
  const dispatch = f.window.wp.data.dispatch('core/editor');
  const setDeviceType = dispatch.setDeviceType;
  dispatch.setDeviceType = () => assert.fail('A dragged width was reset');
  assert.equal((await f.call('measure', { blocks: ['a'], width: 'mobile' })).error, 'custom_canvas_width');
  assert.equal((await f.call('read')).ok, true);
  assert.deepEqual([f.device, f.box.style.width, f.window.__blockwork_editor.view], ['Tablet', '600px', undefined]);
  dispatch.setDeviceType = setDeviceType;
});

test('a measure at a width keeps the editor in that preview until the view is restored', async () => {
  const f = fixture();
  sizedEditor(f);
  f.window.innerWidth = 1100;
  await f.call('connect');
  const resize = await f.call('measure', { blocks: ['a'], width: 'tablet' });
  assert.deepEqual(copy(resize.resize), { width: 'tablet', canvas_width: 702, target_width: 781, window_width: 1179 });
  f.window.innerWidth = 1179;
  const measured = await f.call('measure', { blocks: ['a'], width: 'tablet' });
  assert.equal(measured.ok, true, JSON.stringify(measured));
  assert.deepEqual([measured.canvas_width, measured.width_source], [781, 'preset']);
  assert.equal(f.device, 'Tablet');
  assert.equal((await f.call('restore_view')).ok, true);
  assert.equal(f.device, 'Desktop');
});

test('source reads confirm the signed-in user first', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached' });
  f.user_id = 6;
  const refused = await f.call('read', { source: { post_id: 7, post_type: 'page' } });
  assert.equal(refused.error, 'user_mismatch', JSON.stringify(refused));
});

test('only saves that wrote the post itself move the saved baseline', async () => {
  const f = fixture();
  f.post.status = 'publish';
  assert.equal((await f.call('connect', { workflow: 'attached' })).ok, true);
  assert.equal((await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { content: 'After' } }] })).ok, true);
  // The store adopts another tab's save, then a revision autosave completes.
  f.post.content.raw = 'another tab';
  f.autosave();
  const refused = await f.save({ save_all_pending: true });
  assert.equal(refused.error, 'saved_record_changed', JSON.stringify(refused));
  assert.equal(f.saves, 0);
});

test('a native publish in the same editor becomes the saved state', async () => {
  const f = fixture();
  assert.equal((await f.call('connect', { workflow: 'attached' })).ok, true);
  f.window.wp.data.dispatch('core/editor').editPost({ status: 'publish' });
  await f.window.wp.data.dispatch('core/editor').savePost();
  assert.equal((await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { content: 'After' } }] })).ok, true);
  const saved = await f.save({ save_all_pending: true });
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(f.post.status, 'publish');
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

test('an attribute moved into block supports names its enabled style control', async () => {
  const f = stylingFixture();
  f.registrations['core/paragraph'].attributes.style = { type: 'object' };
  f.registrations['core/paragraph'].supports = {
    typography: { textAlign: true, __experimentalFontWeight: true, __experimentalDefaultControls: { textAlign: true } },
    dimensions: { minHeight: true }, __experimentalBorder: { radius: true }, color: { text: true, link: true },
  };
  await f.call('connect');
  const insert = (attributes) => f.call('edit', { edits: [{ op: 'insert', block: { name: 'core/paragraph', attributes } }] });

  for (const [attribute, path] of [
    ['textAlign', ['style', 'typography', 'textAlign']], ['fontWeight', ['style', 'typography', 'fontWeight']],
    ['minHeight', ['style', 'dimensions', 'minHeight']], ['radius', ['style', 'border', 'radius']], ['text', ['style', 'color', 'text']],
  ]) {
    const refused = await insert({ [attribute]: 'center' });
    assert.equal(refused.error, 'unsupported_attribute', attribute);
    assert.deepEqual(copy(refused.diagnostics.use_instead), path);
    assert.match(refused.hint, /diagnostics\.use_instead/);
  }

  for (const attribute of ['nope', 'link', 'defaultControls', '__experimentalFontWeight']) {
    const refused = await insert({ [attribute]: 1 });
    assert.equal(refused.error, 'unsupported_attribute', attribute);
    assert.equal(refused.diagnostics.use_instead, undefined, attribute);
    assert.doesNotMatch(refused.hint, /use_instead/);
  }
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

test('style guide entries with dotted property strings get a shape hint', async () => {
  const f = fixture();
  await f.call('connect');
  const refused = await f.call('read', { style_guides: [{ name: 'core/group', properties: ['style.spacing'] }] });
  assert.equal(refused.error, 'invalid_read');
  assert.equal(refused.issues[0].path, 'style_guides.0');
  assert.match(refused.issues[0].hint, /\[\["layout"\], \["style","spacing"\]\]/);
});


function explicitFootnoteFixture() {
  const f = fixture('post');
  f.blocks = [f.blocks[0], f.blocks[2]];
  f.post.meta = { footnotes: '[]', note: 'Retained' };
  f.syncContent();
  f.registrations['core/footnotes'] = { name: 'core/footnotes', attributes: {}, supports: { multiple: false } };
  const wp = f.window.wp;
  wp.richText = footnoteRichText;
  wp.blocks.__unstableSerializeAndClean = values => values.length === 1 && wp.blocks.isUnmodifiedDefaultBlock(values[0]) ? '' : wp.blocks.serialize(values);
  const select = wp.data.select;
  const dispatch = wp.data.dispatch;
  const editor = select('core/editor');
  const blocks = select('core/block-editor');
  let entityBlocks;
  let entityContent;
  f.pairedWrites = 0;
  f.settingsWrites = 0;
  f.selectionStart = f.selectionEnd = { clientId: 'c', attributeKey: 'content', offset: 2 };
  f.caret = 0;
  const postActions = dispatch('core/editor');
  const editPost = postActions.editPost;
  postActions.editPost = (values) => { f.settingsWrites++;

 return editPost(values); };

  const core = { ...select('core'), getEditedEntityRecord: () => ({
    blocks: entityBlocks, content: entityContent ?? f.postEdits?.content ?? f.post.content.raw,
    meta: f.postEdits?.meta ?? f.post.meta,
  }) };
  const entityActions = { editEntityRecord(kind, type, id, edits, options) {
    assert.deepEqual([kind, type, id, copy(options)], ['postType', 'post', 7, { isCached: false }]);
    f.pairedWrites++;
    entityBlocks = copy(edits.blocks);
    entityContent = edits.content;
    f.postEdits = { ...f.postEdits };

    if (JSON.stringify(edits.meta) === JSON.stringify(f.post.meta)) delete f.postEdits.meta;
    else f.postEdits.meta = copy(edits.meta);

    if (edits.content === f.post.content.raw) delete f.postEdits.content;
    else f.postEdits.content = edits.content;

    if (!f.entityOnly) f.blocks = copy(edits.blocks);
    f.selectionStart = copy(edits.selection.selectionStart);
    f.selectionEnd = copy(edits.selection.selectionEnd);
    f.caret = edits.selection.initialPosition;
    f.dirty = editor.getEditedPostContent() !== f.post.content.raw || Object.keys(f.postEdits).length > 0;
    f.afterPaired?.();
  } };
  wp.data.select = (name) => name === 'core' ? core : select(name);
  wp.data.dispatch = (name) => name === 'core' ? entityActions : dispatch(name);
  wp.element = { flushSync(callback) { f.beforeFlush?.(); callback(); f.afterFlush?.(); } };
  f.foreignMeta = () => { f.postEdits = { ...f.postEdits, meta: {
    ...(f.postEdits?.meta ?? f.post.meta), note: 'Foreign',
  } }; f.dirty = true; };

  f.footnoteRequest = {
    edits: [
      { op: 'update', path: [0], attributes: { content: 'Reference <sup data-fn="note_a" class="fn"><a href="#note_a" id="note_a-link">1</a></sup>' } },
      { op: 'insert', block: { name: 'core/footnotes' } },
    ],
    settings: { meta: { footnotes: JSON.stringify([{ id: 'note_a', content: 'Inserted note' }]) } },
  };
  f.selection = () => [copy(blocks.getSelectionStart()), copy(blocks.getSelectionEnd()), blocks.getSelectedBlocksInitialCaretPosition()];

  return f;
}

test('explicit footnote insertion owns the complete request once and reverts the exact draft', async () => {
  for (const workflow of ['attached', 'background']) {
    const f = explicitFootnoteFixture();
    assert.equal((await f.call('connect', { workflow, settings: true })).ok, true);
    const before = copy(f.blocks);
    const selection = f.selection();
    const result = await f.call('edit', f.footnoteRequest);
    assert.equal(result.editor_result, 'applied', JSON.stringify(result));
    assert.equal(f.pairedWrites, 1);
    assert.equal(f.settingsWrites, 0);
    assert.equal(f.blocks[0].attributes.content, f.footnoteRequest.edits[0].attributes.content);
    assert.deepEqual(f.postEdits.meta, { footnotes: f.footnoteRequest.settings.meta.footnotes, note: 'Retained' });
    assert.deepEqual(copy(f.window.__blockwork_editor.requested.meta), { footnotes: f.footnoteRequest.settings.meta.footnotes });
    assert.deepEqual(copy(f.window.__blockwork_editor.observed_fields.meta), f.postEdits.meta);
    assert.deepEqual(f.selection(), selection);
    assert.equal((await f.call('revert')).editor_result, 'reverted');
    assert.equal(f.pairedWrites, 2);
    assert.deepEqual(f.blocks, before);
    assert.deepEqual(f.postEdits, {});
    assert.equal(f.dirty, false);
    assert.deepEqual(f.selection(), selection);
  }
});

test('explicit footnote guard refuses foreign whole meta immediately before dispatch', async () => {
  const f = explicitFootnoteFixture();
  assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
  const before = copy(f.blocks);
  f.beforeFlush = () => { f.beforeFlush = undefined; f.foreignMeta(); };

  const result = await f.call('edit', f.footnoteRequest);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.dispatched_groups, 0);
  assert.equal(f.pairedWrites, 0);
  assert.deepEqual(f.blocks, before);
  assert.equal(f.postEdits.meta.note, 'Foreign');
});

test('explicit footnote failures preserve foreign meta and reject the incoming-only transition', async () => {
  for (const mode of ['immediate', 'settling', 'entity_only']) {
    const f = explicitFootnoteFixture();
    assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);

    if (mode === 'immediate') f.afterPaired = f.foreignMeta;

    if (mode === 'settling') f.onSelect = () => { f.onSelect = undefined; f.foreignMeta(); };

    f.entityOnly = mode === 'entity_only';
    const result = await f.call('edit', f.footnoteRequest);
    assert.equal(result.editor_result, 'partial', JSON.stringify(result));
    assert.equal(result.diagnostics.dispatched_groups, 1);
    assert.equal(result.diagnostics.completed_edits, 0);
    assert.equal(f.pairedWrites, 1);
    assert.equal(f.window.__blockwork_editor.last_edit, undefined);
    assert.equal(f.autosaveLocks.has('blockwork/attached_mutation'), true);

    if (mode !== 'entity_only') assert.equal(f.postEdits.meta.note, 'Foreign');
    assert.equal((await f.call('release')).ok, true);
    assert.equal(f.autosaveLocks.size, 0);
  }
});

test('explicit footnote guarded revert preserves foreign settings and pending key presence', async () => {
  for (const mode of ['meta', 'pending_key', 'dirty']) {
    const f = explicitFootnoteFixture();
    assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
    assert.equal((await f.call('edit', f.footnoteRequest)).ok, true);

    if (mode === 'meta') f.foreignMeta();

    if (mode === 'pending_key') f.postEdits.title = f.post.title.raw;

    if (mode === 'dirty') f.dirty = false;
    const before = copy(f.blocks);
    const result = await f.call('revert');
    assert.equal(result.editor_result, 'partial', JSON.stringify(result));
    assert.equal(f.pairedWrites, 1);
    assert.deepEqual(f.blocks, before);

    if (mode === 'meta') assert.equal(f.postEdits.meta.note, 'Foreign');

    if (mode === 'pending_key') assert.ok(Object.hasOwn(f.postEdits, 'title'));

    if (mode === 'dirty') assert.equal(f.dirty, false);
    assert.equal(f.autosaveLocks.has('blockwork/attached_mutation'), true);
  }
});

test('explicit footnote restore verifies the original dirty pending draft after awaiting', async () => {
  const f = explicitFootnoteFixture();
  f.postEdits = { title: 'Existing human draft' };
  f.dirty = true;
  assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
  assert.equal((await f.call('edit', f.footnoteRequest)).ok, true);
  assert.equal((await f.call('revert')).editor_result, 'reverted');
  assert.deepEqual(f.postEdits, { title: 'Existing human draft' });
  assert.equal(f.dirty, true);

  assert.equal((await f.call('edit', f.footnoteRequest)).ok, true);
  f.afterPaired = () => { setTimeout(() => f.foreignMeta(), 0); };

  const result = await f.call('revert');
  assert.equal(result.editor_result, 'partial', JSON.stringify(result));
  assert.equal(f.postEdits.meta.note, 'Foreign');
  assert.equal(f.autosaveLocks.has('blockwork/attached_mutation'), true);
});

test('explicit footnote policy refusal happens before any paired mutation', async () => {
  const f = explicitFootnoteFixture();
  assert.equal((await f.call('connect', { settings: true })).ok, true);
  f.insertLocked = true;
  assert.equal((await f.call('edit', f.footnoteRequest)).ok, false);
  assert.equal(f.pairedWrites, 0);
});


test('explicit footnote failed rendering restores only the complete reached state', async () => {
  const f = explicitFootnoteFixture();
  assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
  const before = copy(f.blocks);
  const selection = f.selection();
  f.onSelect = () => { throw new Error('Injected render refusal'); };

  const result = await f.call('edit', f.footnoteRequest);
  assert.equal(result.editor_result, 'rolled_back', JSON.stringify(result));
  assert.equal(result.diagnostics.dispatched_groups, 1);
  assert.equal(result.diagnostics.completed_edits, 0);
  assert.equal(f.pairedWrites, 2);
  assert.deepEqual(f.blocks, before);
  assert.deepEqual(f.postEdits, {});
  assert.equal(f.dirty, false);
  assert.deepEqual(f.selection(), selection);
  assert.equal(f.autosaveLocks.size, 0);
});

test('explicit footnote pairing preserves empty paragraphs beside the target', async () => {
  const f = explicitFootnoteFixture();
  f.blocks[1].attributes.content = '';
  f.syncContent();
  assert.equal((await f.call('connect', { settings: true })).ok, true);
  const result = await f.call('edit', f.footnoteRequest);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.pairedWrites, 1);
  assert.equal(f.blocks[1].attributes.content, '');
});

test('explicit footnote pairing keeps the Freeform structural restriction', async () => {
  const f = explicitFootnoteFixture();
  f.blocks[1].name = 'core/freeform';
  f.blocks[1].attributes.content = '<p>Freeform</p>';
  f.registrations['core/freeform'] = { name: 'core/freeform', attributes: { content: { type: 'string' } } };
  f.syncContent();
  assert.equal((await f.call('connect', { settings: true })).ok, true);
  const before = copy(f.blocks);
  const result = await f.call('edit', f.footnoteRequest);
  assert.equal(result.ok, false);
  assert.equal(f.pairedWrites, 0);
  assert.deepEqual(f.blocks, before);
});

function completeTabsFixture(action = 'label') {
  const f = explicitFootnoteFixture();
  const wp = f.window.wp;

  for (const name of ['tabs', 'tab-list', 'tab-panels', 'tab-panel']) {
    f.registrations['core/' + name] = { name: 'core/' + name, attributes: {
      label: { type: 'string' }, tabs: { type: 'array' }, editorActiveTabIndex: { type: 'number', role: 'local' },
    } };
  }

  const block = (name, clientId, attributes = {}, innerBlocks = []) => ({ name: 'core/' + name, clientId, attributes, innerBlocks, isValid: true });
  f.blocks = [block('tabs', 'tabs', { editorActiveTabIndex: 0 }, [
    block('tab-list', 'list', { tabs: ['First', 'Second', 'Third'].map(label => ({ label })) }),
    block('tab-panels', 'panels', {}, ['First', 'Second', 'Third'].map((label, i) => block('tab-panel', 'panel' + i, { label }, [block('paragraph', 'text' + i, { content: label })]))),
  ])];
  f.syncContent();
  const core = wp.data.select('core');
  let entityBlocks;
  let entityContent;
  core.getEditedEntityRecord = () => ({ blocks: entityBlocks, content: entityContent ?? f.post.content.raw, meta: f.postEdits?.meta ?? f.post.meta });
  const actions = wp.data.dispatch('core');
  actions.editEntityRecord = (_kind, _type, _id, edits) => {
    assert.equal(Object.hasOwn(edits, 'meta'), false);
    f.pairedWrites++;
    entityBlocks = copy(edits.blocks);
    entityContent = f.replacePairedContent && edits.content !== f.post.content.raw
      ? record => edits.content(record)
      : edits.content;
    f.blocks = copy(edits.blocks);

    if (edits.content === f.post.content.raw) delete f.postEdits.content;
    else f.postEdits.content = entityContent;
    f.dirty = Object.keys(f.postEdits).length > 0;
    f.afterPaired?.();
  };

  const updates = wp.data.dispatch('core/block-editor');
  const single = updates.updateBlockAttributes;
  updates.updateBlockAttributes = (ids, attrs, unique) => {
    if (!Array.isArray(ids)) return single(ids, attrs);
    assert.equal(unique, true); f.attributeGroups = (f.attributeGroups ?? 0) + 1;

    for (const id of ids) single(id, attrs[id]);
    entityContent = ({ blocks = f.blocks }) => wp.blocks.__unstableSerializeAndClean(blocks);
    f.postEdits.content = entityContent; f.afterPaired?.();
  };

  const dispatch = wp.data.dispatch;
  wp.data.dispatch = name => name === 'core/block-editor' ? updates : dispatch(name);
  f.selectionStart = f.selectionEnd = { clientId: 'text0', attributeKey: 'content', offset: 2 };
  f.postEdits = {};
  const labels = action === 'label' ? ['Renamed', 'Second', 'Third'] : action === 'remove' ? ['First', 'Second'] : ['Second', 'First', 'Third'];
  f.tabsRequest = { edits: [action === 'label'
    ? { op: 'update', path: [0, 1, 0], attributes: { label: 'Renamed' } }
    : action === 'remove' ? { op: 'remove', path: [0, 1, 2] }
      : { op: 'move', path: [0, 1, 0], parent: [0, 1], index: 1 },
    ...(action === 'label' ? [] : [{ op: 'update', path: [0], attributes: { editorActiveTabIndex: 1 } }]),
    { op: 'update', path: [0, 0], attributes: { tabs: labels.map(label => ({ label })) } },
  ] };

  return f;
}

for (const action of ['label', 'remove', 'move']) {
  test('complete Tabs ' + action + ' applies once and restores without meta writes', async () => {
    const f = completeTabsFixture(action);
    assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
    const before = copy(f.blocks), meta = copy(f.post.meta);
    const result = await f.call('edit', f.tabsRequest);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((f.attributeGroups ?? 0) + f.pairedWrites, 1);
    assert.deepEqual(f.post.meta, meta);
    assert.equal(Object.hasOwn(f.postEdits, 'meta'), false);
    assert.equal((await f.call('revert')).ok, true);
    assert.deepEqual(f.blocks, before);
  });
}

for (const action of ['label', 'remove', 'move']) {
  test('complete Tabs ' + action + ' checks final policy before dispatch', async () => {
    const f = completeTabsFixture(action);
    assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
    const before = copy(f.blocks);
    f.beforeFlush = () => {
      if (action === 'remove') f.removeLocked = true;
      else if (action === 'move') f.moveLocked = true;
      else f.blocks[0].innerBlocks[0].attributes.lock = { remove: true, move: true };
    };

    if (action === 'label') {
      const store = f.window.wp.data.select('core/block-editor');
      const mode = store.getBlockEditingMode;
      store.getBlockEditingMode = id => f.denied ? 'disabled' : mode(id);
      f.beforeFlush = () => { f.denied = true; };
    }

    const result = await f.call('edit', f.tabsRequest);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(f.pairedWrites + (f.attributeGroups ?? 0), 0);
    assert.deepEqual(f.blocks, before);
  });
}

for (const variant of ['wrong', 'missing']) {
  test('incomplete Tabs list ' + variant + ' never receives paired transport', async () => {
    const f = completeTabsFixture('remove');
    assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);

    if (variant === 'missing') f.tabsRequest.edits.pop();
    else f.tabsRequest.edits.at(-1).attributes.tabs = [{ label: 'Wrong' }];
    const before = copy(f.blocks);
    const result = await f.call('edit', f.tabsRequest);
    assert.equal(result.error, 'tabs_companion_required', JSON.stringify(result));
    assert.equal(result.editor_result, 'not_applied');
    assert.match(result.hint, /tab-list tabs array/);
    assert.deepEqual(f.blocks, before);
    assert.equal(f.pairedWrites, 0);
    assert.equal(f.attributeGroups ?? 0, 0);
  });
}

for (const equalPlanned of [false, true]) {
  test('complete Tabs refuses foreign list before dispatch even when planned ' + equalPlanned, async () => {
    const f = completeTabsFixture('move');
    assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
    const foreign = equalPlanned ? copy(f.tabsRequest.edits.at(-1).attributes.tabs) : [{ label: 'Foreign' }];
    f.beforeFlush = () => { f.blocks[0].innerBlocks[0].attributes.tabs = copy(foreign); };

    assert.equal((await f.call('edit', f.tabsRequest)).ok, false);
    assert.equal(f.pairedWrites, 0);
    assert.deepEqual(f.blocks[0].innerBlocks[0].attributes.tabs, foreign);
  });
}

test('complete Tabs preserves foreign list during settle and refuses guarded revert', async () => {
  const f = completeTabsFixture('move');
  assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
  f.afterPaired = () => setTimeout(() => { f.blocks[0].innerBlocks[0].attributes.tabs = [{ label: 'Foreign' }]; }, 150);
  const result = await f.call('edit', f.tabsRequest);
  assert.equal(result.ok, false);
  assert.equal(result.editor_result, 'partial');
  assert.equal(f.pairedWrites, 1);
  assert.deepEqual(f.blocks[0].innerBlocks[0].attributes.tabs, [{ label: 'Foreign' }]);
  assert.equal((await f.call('revert')).ok, false);
});

test('complete Tabs guarded revert preserves foreign meta and unrelated settings', async () => {
  const f = completeTabsFixture('remove');
  assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
  assert.equal((await f.call('edit', f.tabsRequest)).ok, true);
  f.foreignMeta(); f.postEdits.title = 'Foreign title';
  assert.equal((await f.call('revert')).ok, false);
  assert.equal(f.pairedWrites, 1);
  assert.equal(f.postEdits.meta.note, 'Foreign');
  assert.equal(f.postEdits.title, 'Foreign title');
});


test('complete Tabs move accepts native callback replacement only with the exact planned state', async () => {
  const f = completeTabsFixture('move');
  f.replacePairedContent = true;
  assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
  const before = copy(f.blocks);
  const result = await f.call('edit', f.tabsRequest);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await f.call('revert')).ok, true);
  assert.deepEqual(f.blocks, before);
});

test('complete Tabs supports a document without a metadata field', async () => {
  const f = completeTabsFixture('move');
  delete f.post.meta;
  assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
  const before = copy(f.blocks);
  const result = await f.call('edit', f.tabsRequest);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(Object.hasOwn(f.postEdits, 'meta'), false);
  assert.equal((await f.call('revert')).ok, true);
  assert.deepEqual(f.blocks, before);
});

test('unsetting a meta-sourced attribute refuses before a neighboring edit', async () => {
  const f = fixture();
  const type = f.registrations[f.blocks[0].name];
  type.attributes.note = { type: 'string', source: 'meta', meta: 'note' };
  f.blocks[0].attributes.note = 'Retained';
  f.syncContent();
  assert.equal((await f.call('connect')).ok, true);
  const before = copy(f.blocks);
  const result = await f.call('edit', { edits: [
    { op: 'update', path: [0], unset: [['note']] },
    { op: 'update', path: [2], attributes: { content: 'Changed neighbor' } },
  ] });
  assert.equal(result.error, 'unsupported_attribute', JSON.stringify(result));
  assert.equal(result.editor_result, 'not_applied');
  assert.equal(result.diagnostics.attribute, 'note');
  assert.match(result.diagnostics.use_instead, /settings.meta/);
  assert.match(result.hint, /settings.meta/);
  assert.deepEqual(f.blocks, before);
  assert.equal(f.saves, 0);
});


function structuralFootnoteFixture() {
  const f = explicitFootnoteFixture();
  f.window.wp.richText = footnoteRichText;
  f.blocks = [
    { ...footnoteParagraph('note_a', 1), clientId: 'a' },
    { ...footnoteParagraph('note_b', 2), clientId: 'b' },
    f.blocks[1],
    {
      name: 'core/footnotes',
      clientId: 'footnotes',
      attributes: {},
      innerBlocks: [],
      isValid: true,
    },
  ];
  f.post.meta.footnotes = footnoteBodies(['note_a', 'note_b']);
  f.syncContent();

  return f;
}

for (const operation of ['move', 'remove', 'copy']) {
  test(`structural footnote ${operation} pairs numbering and bodies and restores the exact draft`, async () => {
    for (const workflow of ['attached', 'background']) {
      const f = structuralFootnoteFixture();

      if (workflow === 'attached') {
        f.postEdits = { title: 'Human draft' };
        f.dirty = true;
      }

      assert.equal((await f.call('connect', { workflow, settings: true })).ok, true);
      const before = copy(f.blocks);
      const selection = f.selection();
      const read = await f.call('read', {
        blocks: { client_id: 'a', markup: true },
        settings: true,
      });
      assert.equal(read.ok, true, JSON.stringify(read));
      const edits =
        operation === 'copy'
          ? [{ op: 'insert', markup: read.markup, index: 1 }]
          : operation === 'move'
            ? [{ op: 'move', client_id: 'b', index: 0 }]
            : [{ op: 'remove', client_id: 'a' }];
      const result = await f.call('edit', { edits });
      assert.equal(result.editor_result, 'applied', JSON.stringify(result));
      const ids =
        operation === 'move'
          ? ['note_b', 'note_a']
          : operation === 'remove'
            ? ['note_b']
            : ['note_a', 'note_a', 'note_b'];
      assert.equal(f.postEdits.meta.footnotes, footnoteBodies(ids));
      assert.match(
        f.blocks[operation === 'copy' ? 2 : 0].attributes.content,
        operation === 'copy' ? /<strong>3<\/strong>/ : /<strong>1<\/strong>/,
      );
      assert.equal(f.pairedWrites, 1);
      assert.equal(f.settingsWrites, 0);
      assert.equal(result.footnote_writes.source, 'document');
      assert.equal(result.footnote_writes.requested_edits, 1);
      assert.equal(result.footnote_writes.companion_writes, operation === 'move' ? 2 : 1);
      assert.doesNotMatch(JSON.stringify(result.footnote_writes), /Body note/);
      assert.equal(f.window.__blockwork_editor.last_edit.plan.steps.length, 1);
      assert.deepEqual(f.selection(), selection);
      assert.equal((await f.call('revert')).editor_result, 'reverted');
      assert.deepEqual(f.blocks, before);
      assert.deepEqual(f.selection(), selection);
      assert.deepEqual(f.postEdits, workflow === 'attached' ? { title: 'Human draft' } : {});
      assert.equal(f.dirty, workflow === 'attached');
    }
  });
}

test('structural footnote cross-document copy reads source bodies and destination settings', async () => {
  const source = structuralFootnoteFixture();
  source.blocks = [{ ...footnoteParagraph('note_c', 1), clientId: 'source' }, source.blocks.at(-1)];
  source.post.meta.footnotes = footnoteBodies(['note_c']);
  source.syncContent();
  assert.equal((await source.call('connect', { settings: true })).ok, true);
  const readSource = await source.call('read', {
    blocks: { client_id: 'source', markup: true },
    settings: true,
  });
  assert.equal(readSource.ok, true, JSON.stringify(readSource));

  for (const hasList of [true, false]) {
    const destination = structuralFootnoteFixture();

    if (!hasList) {
      destination.blocks = [destination.blocks[2]];
      destination.post.meta.footnotes = '';
      destination.syncContent();
    }

    const readDestination = await destination.call('connect', { settings: true });
    assert.equal(readDestination.ok, true, JSON.stringify(readDestination));
    const bodies = [
      ...JSON.parse(readDestination.settings.values.meta.footnotes || '[]'),
      ...JSON.parse(readSource.settings.values.meta.footnotes),
    ];
    const edits = [{ op: 'insert', markup: readSource.markup }];

    if (!hasList) edits.push({ op: 'insert', block: { name: 'core/footnotes' } });
    const result = await destination.call('edit', {
      edits,
      settings: { meta: { footnotes: JSON.stringify(bodies) } },
    });
    assert.equal(result.editor_result, 'applied', JSON.stringify(result));
    assert.equal(result.footnote_writes.source, 'settings');
    assert.deepEqual(JSON.parse(destination.postEdits.meta.footnotes), bodies);
    assert.equal(destination.pairedWrites, 1);
    assert.equal(destination.postEdits.meta.note, 'Retained');
  }
});

test('structural footnote markup without source bodies refuses before any mutation', async () => {
  const f = structuralFootnoteFixture();
  assert.equal((await f.call('connect', { settings: true })).ok, true);
  const before = copy(f.blocks);
  const result = await f.call('edit', {
    edits: [
      {
        op: 'insert',
        block: { name: 'core/paragraph', attributes: footnoteParagraph('missing', 1).attributes },
      },
    ],
  });
  assert.equal(result.editor_result, 'not_applied', JSON.stringify(result));
  assert.equal(result.diagnostics.constraint, 'footnote_body_required');
  assert.match(result.diagnostics.next_step, /source paragraph markup and settings/);
  assert.match(result.hint, /source.*settings/);
  assert.deepEqual(f.blocks, before);
  assert.equal(f.pairedWrites, 0);
});

test('structural footnote authorizes companion attributes as well as original structural policy', async () => {
  for (const denied of ['companion', 'remove', 'move', 'insert', 'meta']) {
    const f = structuralFootnoteFixture();

    if (denied === 'meta')
      f.schema = {
        meta: {
          type: 'object',
          properties: { note: { type: 'string' } },
          additionalProperties: false,
        },
      };
    assert.equal((await f.call('connect', { settings: true })).ok, true);
    const store = f.window.wp.data.select('core/block-editor');

    if (denied === 'companion') store.canEditBlock = (id) => id !== 'b';
    f.removeLocked = denied === 'remove';
    f.moveLocked = denied === 'move';
    f.insertLocked = denied === 'insert';
    const edit =
      denied === 'move'
        ? { op: 'move', client_id: 'b', index: 0 }
        : denied === 'insert'
          ? { op: 'insert', block: { name: 'core/paragraph', attributes: f.blocks[0].attributes } }
          : { op: 'remove', client_id: 'a' };
    const before = copy(f.blocks);
    const result = await f.call('edit', { edits: [edit] });
    assert.equal(result.editor_result, 'not_applied', JSON.stringify({ denied, result }));

    if (denied === 'companion') {
      assert.equal(result.diagnostics.client_id, 'b');
      assert.deepEqual(copy(result.diagnostics.target_path), [0]);
      assert.deepEqual(copy(result.diagnostics.live_path), [1]);
      assert.equal(result.diagnostics.attribute, 'content');
    }

    assert.equal(f.pairedWrites, 0);
    assert.deepEqual(f.blocks, before);
  }
});

test('structural footnote exact whole-meta guards reject changes before planning, settings and dispatch', async () => {
  for (const stage of ['observed', 'settings', 'dispatch']) {
    const f = structuralFootnoteFixture();
    assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);

    if (stage === 'observed') f.foreignMeta();

    if (stage === 'settings') {
      const clean = f.window.wp.blocks.__unstableSerializeAndClean;
      f.window.wp.blocks.__unstableSerializeAndClean = (blocks) => {
        f.foreignMeta();

        return clean(blocks);
      };
    }

    if (stage === 'dispatch') f.beforeFlush = f.foreignMeta;
    const before = copy(f.blocks);
    const result = await f.call('edit', { edits: [{ op: 'remove', client_id: 'a' }] });
    assert.equal(result.editor_result, 'not_applied', JSON.stringify({ stage, result }));
    assert.equal(f.pairedWrites, 0);
    assert.equal(f.postEdits.meta.note, 'Foreign');
    assert.deepEqual(f.blocks, before);
  }
});

test('structural footnote companion conflicts refuse while unrelated earlier text survives', async () => {
  for (const changedId of ['b', 'b_removed_reference', 'c']) {
    const f = structuralFootnoteFixture();
    assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
    const changed = f.blocks.find(
      (block) => block.clientId === (changedId === 'b_removed_reference' ? 'b' : changedId),
    );
    changed.attributes.content =
      changedId === 'b_removed_reference'
        ? 'Reference removed by human'
        : changed.attributes.content + ' Human typing';
    f.postEdits = { content: () => f.window.wp.blocks.serialize(f.blocks) };
    f.dirty = true;
    const result = await f.call('edit', { edits: [{ op: 'remove', client_id: 'a' }] });

    if (changedId !== 'c') {
      assert.equal(result.error, 'block_changed', JSON.stringify(result));
      assert.equal(f.pairedWrites, 0);
    } else {
      assert.equal(result.editor_result, 'applied', JSON.stringify(result));
      assert.match(
        f.blocks.find((block) => block.clientId === 'c').attributes.content,
        /Human typing/,
      );
    }
  }
});

test('structural footnote preserves unrelated nested selection and blocks', async () => {
  const f = structuralFootnoteFixture();
  f.registrations['core/group'] = { name: 'core/group', attributes: {} };
  const nested = {
    name: 'core/group',
    clientId: 'group',
    attributes: {},
    innerBlocks: [f.blocks[2]],
  };
  f.blocks[2] = nested;
  f.syncContent();
  assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
  const selection = f.selection();
  const result = await f.call('edit', { edits: [{ op: 'move', client_id: 'b', index: 0 }] });
  assert.equal(result.editor_result, 'applied', JSON.stringify(result));
  assert.deepEqual(f.blocks[2], nested);
  assert.deepEqual(f.selection(), selection);
});

test('structural footnote failures reuse guarded restore and keep foreign work locked', async () => {
  for (const mode of ['restore', 'foreign', 'revert']) {
    const f = structuralFootnoteFixture();
    assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
    const before = copy(f.blocks);

    if (mode === 'restore')
      f.onSelect = () => {
        throw new Error('Render failed');
      };

    if (mode === 'foreign') f.afterPaired = f.foreignMeta;
    let result = await f.call('edit', { edits: [{ op: 'move', client_id: 'b', index: 0 }] });

    if (mode === 'revert') {
      assert.equal(result.editor_result, 'applied', JSON.stringify(result));
      f.foreignMeta();
      result = await f.call('revert');
    }

    assert.equal(
      result.editor_result,
      mode === 'restore' ? 'rolled_back' : 'partial',
      JSON.stringify(result),
    );

    if (mode === 'restore') {
      assert.deepEqual(f.blocks, before);
      assert.deepEqual(f.postEdits, {});
      assert.equal(f.dirty, false);
    } else {
      assert.equal(f.postEdits.meta.note, 'Foreign');
      assert.equal(f.pairedWrites, 1);
      assert.equal(f.autosaveLocks.has('blockwork/attached_mutation'), true);
    }
  }
});

test('structural footnote refuses mixed edits before pattern opening and leaves raw updates explicit', async () => {
  const f = structuralFootnoteFixture();
  assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
  let openings = 0;
  f.window.wp.data.dispatch('core/block-editor').__unstableSetTemporarilyEditingAsBlocks = () => {
    openings++;
  };

  for (const extra of [
    { open_pattern_section: { section_client_id: 'a' } },
    { post: { title: 'Mixed' } },
  ]) {
    const result = await f.call('edit', {
      edits: [{ op: 'move', client_id: 'b', index: 0 }],
      ...extra,
    });
    assert.equal(result.editor_result, 'not_applied', JSON.stringify(result));
    assert.equal(result.diagnostics.constraint, 'footnote_separate_structural_request');
  }

  const mixed = await f.call('edit', {
    edits: [
      { op: 'remove', client_id: 'a' },
      { op: 'update', client_id: 'b', attributes: { content: 'Raw' } },
    ],
  });
  assert.equal(mixed.editor_result, 'not_applied', JSON.stringify(mixed));
  assert.equal(openings, 0);
  assert.equal(f.pairedWrites, 0);
  const raw = await f.call('edit', {
    edits: [
      {
        op: 'update',
        client_id: 'a',
        attributes: { content: 'Edited ' + f.blocks[0].attributes.content },
      },
    ],
  });
  assert.equal(raw.editor_result, 'applied', JSON.stringify(raw));
  assert.equal(raw.footnote_writes, undefined);
  assert.equal(f.pairedWrites, 0);
  assert.equal(f.postEdits?.meta, undefined);
});

test('structural footnote rechecks native companion and move permissions inside dispatch', async () => {
  for (const denied of ['companion', 'move']) {
    const f = structuralFootnoteFixture();
    assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
    const before = copy(f.blocks);
    f.beforeFlush = () => {
      if (denied === 'companion') f.window.wp.data.select('core/block-editor').canEditBlock = () => false;
      else f.moveLocked = true;
    };

    const result = await f.call('edit', { edits: [{ op: 'move', client_id: 'b', index: 0 }] });
    assert.equal(result.editor_result, 'not_applied', JSON.stringify(result));
    assert.equal(result.diagnostics.dispatched_groups, 0);

    if (denied === 'companion') {
      assert.equal(result.diagnostics.client_id, 'b');
      assert.deepEqual(copy(result.diagnostics.target_path), [0]);
      assert.deepEqual(copy(result.diagnostics.live_path), [1]);
      assert.equal(result.diagnostics.attribute, 'content');
    }

    assert.equal(f.pairedWrites, 0);
    assert.deepEqual(f.blocks, before);
  }
});

for (const operation of ['insert', 'move', 'remove']) {
  test('unrelated structural ' + operation + ' beside footnotes keeps the ordinary edit path', async () => {
    const f = structuralFootnoteFixture();
    assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
    const meta = copy(f.post.meta);
    const edit = operation === 'insert'
      ? { op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'Unrelated' } } }
      : operation === 'move' ? { op: 'move', client_id: 'c', index: 0 }
        : { op: 'remove', client_id: 'c' };
    const result = await f.call('edit', { edits: [edit] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.footnote_writes, undefined);
    assert.equal(f.pairedWrites, 0);
    assert.equal(f.postEdits?.meta, undefined);
    assert.deepEqual(f.post.meta, meta);
  });
}


test('structural footnote eligibility follows a newly inserted plain paragraph through sequential paths', async () => {
  const f = structuralFootnoteFixture();
  assert.equal((await f.call('connect', { workflow: 'attached', settings: true })).ok, true);
  const meta = copy(f.post.meta);
  const result = await f.call('edit', { edits: [
    { op: 'insert', index: 0, block: { name: 'core/paragraph', attributes: { content: 'New plain paragraph' } } },
    { op: 'move', path: [0], index: 2 },
  ] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.footnote_writes, undefined);
  assert.equal(f.blocks[2].attributes.content, 'New plain paragraph');
  assert.equal(f.pairedWrites, 0);
  assert.deepEqual(f.post.meta, meta);
  assert.equal(f.postEdits?.meta, undefined);
});

function emptyCommentsFixture() {
  const f = fixture();

  for (const name of ['core/comments', 'core/comment-template']) {
    f.registrations[name] = { name, attributes: { metadata: { type: 'object' } } };
  }

  const wp = f.window.wp;
  const hidden = wp.blocks.createBlock('core/group', {}, [wp.blocks.createBlock('core/paragraph', { content: 'Comment body' })]);
  const template = wp.blocks.createBlock('core/comment-template', {}, [hidden]);
  const visible = wp.blocks.createBlock('core/group', {}, [template]);
  const root = wp.blocks.createBlock('core/comments', {}, [visible]);
  const pattern = { name: 'example/comments', title: 'Comments', content: wp.blocks.serialize([root]), blocks: [root] };
  f.patterns = [pattern];
  f.editorSettings = { __experimentalDiscussionSettings: { pageComments: '1', commentsPerPage: '50', defaultCommentsPage: 'newest' } };
  const select = wp.data.select;
  const resolve = wp.data.resolveSelect;
  wp.data.select = (name) => name === 'core' ? {
    ...select(name), getEntityRecords: () => [], getEntityRecordsTotalItems: () => 0,
    hasFinishedResolution: () => true,
  } : select(name);
  wp.data.resolveSelect = (name) => ({ ...resolve(name), getEntityRecords: async () => [] });
  const store = select('core/block-editor');
  store.__experimentalGetAllowedPatterns = () => [pattern];

  return { f, wp, store, root, visible, template, hidden, request: [{ op: 'insert_pattern', pattern: pattern.name }] };
}

test('empty Comments retains mounted visible parent policies', async () => {
  for (const restriction of ['allowedBlocks', 'parent']) {
    const { f, store, root, visible, request } = emptyCommentsFixture();

    if (restriction === 'allowedBlocks') {
      store.getBlockListSettings = (id) => id === root.clientId ? { allowedBlocks: ['core/paragraph'] } : {};
    } else {
      f.registrations['core/group'].parent = ['example/other'];
    }

    const result = await f.edit(request);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error, 'insertion_refused', JSON.stringify(result));
    assert.equal(result.diagnostics.constraint, restriction === 'allowedBlocks' ? 'parent_allowed_blocks' : 'block_parent');
    assert.equal(f.saves, 0);
    assert.ok(visible.clientId);
  }
});

for (const change of ['attribute', 'child']) {
  test(`empty Comments preserves a foreign hidden ${change} during rollback`, async () => {
    const { f, hidden, request } = emptyCommentsFixture();
    f.afterInsert = () => {
      const actual = f.blocks.at(-1).innerBlocks[0].innerBlocks[0].innerBlocks[0];
      assert.equal(actual.clientId, hidden.clientId);

      if (change === 'attribute') actual.attributes.foreign = true;
      else actual.innerBlocks.push({ name: 'core/paragraph', clientId: 'foreign-comment', attributes: { content: 'Foreign comment' }, innerBlocks: [], isValid: true });
    };

    const result = await f.edit(request);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.editor_result, 'partial', JSON.stringify(result));
    const actual = f.blocks.at(-1).innerBlocks[0].innerBlocks[0].innerBlocks[0];

    if (change === 'attribute') assert.equal(actual.attributes.foreign, true);
    else assert.equal(actual.innerBlocks.at(-1).clientId, 'foreign-comment');
    assert.equal(f.saves, 0);
  });
}


function completeGalleryFixture() {
  const f = completeTabsFixture();
  const wp = f.window.wp;
  const attrs = Object.fromEntries(
    [
      'url',
      'alt',
      'sizeSlug',
      'caption',
      'linkDestination',
      'href',
      'align',
      'linkTarget',
      'rel',
      'className',
      'aspectRatio',
    ].map((key) => [key, { type: 'string' }]),
  );
  f.registrations['core/image'] = {
    name: 'core/image',
    attributes: { ...attrs, id: { type: 'integer' }, lightbox: { type: 'object' } },
  };
  f.registrations['core/gallery'] = {
    name: 'core/gallery',
    attributes: {
      sizeSlug: { type: 'string' },
      linkTo: { type: 'string' },
      aspectRatio: { type: 'string' },
    },
  };
  const image = (clientId, attributes) => ({
    name: 'core/image',
    clientId,
    attributes,
    innerBlocks: [],
    isValid: true,
  });
  f.blocks = [
    {
      name: 'core/gallery',
      clientId: 'gallery',
      attributes: { sizeSlug: 'large', linkTo: 'none', aspectRatio: 'auto' },
      isValid: true,
      innerBlocks: [
        image('image', { caption: '', sizeSlug: 'large', align: 'left', className: 'retained' }),
        image('sibling', {
          id: 21,
          url: 'https://example.test/sibling.jpg',
          caption: 'Sibling caption',
          href: 'https://example.test/custom',
          linkDestination: 'custom',
          rel: 'noreferrer',
          className: 'sibling-class',
        }),
      ],
    },
  ];
  const serialize = wp.blocks.serialize;
  const withoutUi = (blocks) =>
    blocks.map((block) => {
      const attributes = { ...block.attributes };

      if (block.name === 'core/image') {
        for (const key of ['fullUrl', 'link']) {
          if (!f.registrations['core/image'].attributes[key] && !f.serializeGalleryUi)
            delete attributes[key];
        }
      }

      return { ...block, attributes, innerBlocks: withoutUi(block.innerBlocks ?? []) };
    });
  wp.blocks.serialize = (blocks) => serialize(withoutUi(blocks));
  wp.data.select('core/editor').getEditedPostContent = () => wp.blocks.serialize(f.blocks);
  f.syncContent = () => {
    f.post.content.raw = wp.blocks.serialize(f.blocks);
  };

  f.syncContent();
  f.selectionStart = f.selectionEnd = { clientId: 'image', attributeKey: 'caption', offset: 0 };
  f.media = {
    id: 20,
    media_type: 'image',
    mime_type: 'image/jpeg',
    source_url: 'https://example.test/full.jpg',
    link: 'https://example.test/attachment',
    alt_text: 'Attachment alt',
    caption: { raw: 'Attachment caption' },
    media_details: {
      sizes: {
        full: {
          source_url: 'https://example.test/full.jpg',
          width: 1200,
          height: 800,
          file: 'full.jpg',
          mime_type: 'image/jpeg',
        },
      },
    },
  };
  f.api = ({ path }) => (path.startsWith('/wp/v2/media/20') ? f.media : undefined);
  f.resolveRecords = async (kind, name, query) => {
    assert.deepEqual(
      [kind, name, copy(query)],
      ['postType', 'attachment', { include: '20,21', per_page: -1, orderby: 'include' }],
    );
    f.galleryRecords = [copy(f.media)];

    return f.galleryRecords;
  };

  wp.data.select('core').getEntityRecords = () => f.galleryRecords;
  const save = wp.data.dispatch('core/editor').savePost;
  wp.data.dispatch('core/editor').savePost = async () => {
    await save();
    f.syncContent();
  };

  f.galleryRequest = async () => {
    const inspected = await f.call('inspect_media', {
      target: { site_url: target.site_url, user_id: 5 },
      id: 20,
    });

    return {
      edits: [
        {
          op: 'update',
          path: [0],
          name: 'core/gallery',
          attributes: { sizeSlug: 'full', linkTo: 'none' },
        },
        {
          op: 'update',
          path: [0, 0],
          name: 'core/image',
          attributes: { caption: 'Chosen caption', sizeSlug: 'full', linkDestination: 'none' },
          unset: ['align'],
        },
      ],
      media_bindings: [
        {
          path: [0, 0],
          name: 'core/image',
          media_id: 20,
          media_token: inspected.record.edit_token,
          size: 'full',
          bind: { id: 'id', url: 'url', alt: 'alt', size_slug: 'sizeSlug' },
        },
      ],
    };
  };

  return f;
}

test('complete Gallery binding merges Image patches, preserves linked siblings and saves', async () => {
  const f = completeGalleryFixture();
  const request = await f.galleryRequest();
  const sibling = copy(f.blocks[0].innerBlocks[1]);
  assert.equal((await f.call('connect')).ok, true);
  const result = await f.call('edit', request);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.attributeGroups, 1);
  assert.equal(f.pairedWrites, 0);
  assert.deepEqual(f.blocks[0].innerBlocks[1], sibling);
  const attrs = f.blocks[0].innerBlocks[0].attributes;
  assert.equal(attrs.caption, 'Chosen caption');
  assert.equal(attrs.className, 'retained');
  assert.equal(attrs.align, undefined);
  assert.equal(attrs.fullUrl, f.media.media_details.sizes.full.source_url);
  assert.equal(attrs.link, f.media.link);
  assert.equal(attrs.id, 20);
  assert.equal((await f.save()).persistence, 'verified');
});

test('Gallery binding requires complete parent size and chosen caption before dispatch', async () => {
  for (const missing of ['parent', 'caption']) {
    const f = completeGalleryFixture();
    const request = await f.galleryRequest();

    if (missing === 'parent') request.edits.shift();
    else delete request.edits[1].attributes.caption;
    await f.call('connect');
    const before = copy(f.blocks);
    const result = await f.call('edit', request);
    assert.equal(result.error, 'gallery_companion_required', JSON.stringify(result));
    assert.match(result.hint, /references\/media.md/);
    assert.deepEqual(f.blocks, before);
    assert.equal(f.attributeGroups ?? 0, 0);
  }
});

test('Gallery binding keeps raw UI attributes behind strict request validation', async () => {
  for (const attribute of ['fullUrl', 'link']) {
    const f = completeGalleryFixture();
    const request = await f.galleryRequest();
    request.edits[1].attributes[attribute] = 'https://example.test/forbidden';
    await f.call('connect');
    const result = await f.call('edit', request);
    assert.equal(result.error, 'unsupported_attribute', JSON.stringify(result));
    assert.equal(f.attributeGroups ?? 0, 0);
  }
});

test('Gallery saved comparison refuses UI values that alter native markup', async () => {
  const f = completeGalleryFixture();
  const request = await f.galleryRequest();
  f.serializeGalleryUi = true;
  await f.call('connect');
  // Parsing retains these fields in this fixture when serialized. Drop them
  // to model a native parser whose saved representation cannot restore them.
  const parse = f.window.wp.blocks.parse;
  f.window.wp.blocks.parse = (text) => {
    const blocks = parse(text);

    for (const image of blocks[0]?.innerBlocks ?? []) {
      delete image.attributes.fullUrl;
      delete image.attributes.link;
    }

    return blocks;
  };

  const result = await f.call('edit', request);
  assert.equal(result.error, 'gallery_companion_required', JSON.stringify(result));
  assert.equal(f.attributeGroups ?? 0, 0);
});

test('Gallery registered UI fields get no saved comparison exception', async () => {
  const f = completeGalleryFixture();
  f.registrations['core/image'].attributes.fullUrl = { type: 'string' };
  const request = await f.galleryRequest();
  await f.call('connect');
  const result = await f.call('edit', request);
  assert.equal(result.error, 'gallery_companion_required', JSON.stringify(result));
  assert.equal(result.diagnostics.attribute, 'fullUrl');
  assert.equal(f.attributeGroups ?? 0, 0);
});

test('Gallery media references remain currentness guards after another edit and revert', async () => {
  const f = completeGalleryFixture();
  const request = await f.galleryRequest();
  await f.call('connect');
  assert.equal((await f.call('edit', request)).ok, true);
  const followup = await f.call('edit', {
    edits: [{ op: 'update', path: [0, 0], attributes: { caption: 'Second caption' } }],
  });
  assert.equal(followup.ok, true, JSON.stringify(followup));
  f.media.alt_text = 'Changed';
  assert.equal((await f.save()).error, 'stale_reference');
  assert.equal(f.saves, 0);
  f.media.alt_text = 'Attachment alt';
  assert.equal((await f.call('revert')).ok, true);
  assert.equal(
    (
      await f.call('edit', {
        edits: [
          { op: 'update', path: [0, 1], attributes: { caption: 'Requested sibling caption' } },
        ],
      })
    ).ok,
    true,
  );
  f.media.alt_text = 'Changed after revert';
  assert.equal((await f.save()).error, 'stale_reference');
  f.media.alt_text = 'Attachment alt';
  assert.equal((await f.save()).persistence, 'verified');
});

test('Gallery binding checks foreign before and after states without resetting them', async () => {
  for (const stage of ['before', 'after']) {
    const f = completeGalleryFixture();
    const request = await f.galleryRequest();
    await f.call('connect', { workflow: 'attached' });

    if (stage === 'before')
      f.beforeFlush = () => {
        f.beforeFlush = undefined;
        f.foreignMeta();
      };
    else f.afterPaired = () => f.foreignMeta();
    const result = await f.call('edit', request);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(f.attributeGroups ?? 0, stage === 'before' ? 0 : 1);
    assert.equal(f.postEdits.meta.note, 'Foreign');
    assert.equal(f.pairedWrites, 0);
  }
});

test('removed bound Images retire their media pin while featured media keeps its own pin', async () => {
  for (const featured of [false, true]) {
    const f = completeGalleryFixture();
    const request = await f.galleryRequest();
    await f.call('connect');
    assert.equal((await f.call('edit', request)).ok, true);

    if (featured)
      assert.equal(
        (
          await f.call('edit', {
            settings: {
              featured_media: { id: 20, media_token: request.media_bindings[0].media_token },
            },
          })
        ).ok,
        true,
      );
    assert.equal((await f.call('edit', { edits: [{ op: 'remove', path: [0, 0] }] })).ok, true);
    f.media.alt_text = 'Changed after Image removal';
    assert.equal(
      (
        await f.call('edit', {
          edits: [{ op: 'update', path: [0, 0], attributes: { caption: 'Neighbor edit' } }],
        })
      ).ok,
      true,
    );
    const saved = await f.save();

    if (featured) {
      assert.equal(saved.error, 'stale_reference', JSON.stringify(saved));
      assert.equal(f.saves, 0);
    } else assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  }
});

test('two Image media owners keep the remaining owner original token', async () => {
  const f = fixture();
  f.registrations['core/image'] = {
    name: 'core/image',
    attributes: { id: { type: 'integer' }, url: { type: 'string' }, alt: { type: 'string' } },
  };
  f.blocks = [0, 1].map((index) => ({
    name: 'core/image',
    clientId: 'image' + index,
    attributes: {},
    innerBlocks: [],
    isValid: true,
  }));
  f.syncContent();
  const media = {
    id: 20,
    media_type: 'image',
    mime_type: 'image/jpeg',
    source_url: 'https://example.test/image.jpg',
    media_details: {},
    alt_text: 'Original alt',
  };
  f.api = ({ path }) => (path.startsWith('/wp/v2/media/20') ? media : undefined);
  const binding = async (path) => {
    const inspected = await f.call('inspect_media', {
      target: { site_url: target.site_url, user_id: 5 },
      id: 20,
    });

    return {
      media_bindings: [
        {
          path,
          name: 'core/image',
          media_id: 20,
          media_token: inspected.record.edit_token,
          size: 'full',
          bind: { id: 'id', url: 'url', alt: 'alt' },
        },
      ],
    };
  };

  await f.call('connect');
  assert.equal((await f.call('edit', await binding([0]))).ok, true);
  media.alt_text = 'New token alt';
  assert.equal((await f.call('edit', await binding([1]))).ok, true);
  assert.equal((await f.call('edit', { edits: [{ op: 'remove', path: [1] }] })).ok, true);
  const refused = await f.save();
  assert.equal(refused.error, 'stale_reference');
  assert.equal(refused.diagnostics.stage, 'media_currentness');
  assert.equal(refused.diagnostics.owner_client_id, 'image0');
  media.alt_text = 'Original alt';
  assert.equal((await f.save()).persistence, 'verified');
});

test('Gallery UI full URL has no attachment source URL fallback', async () => {
  const f = completeGalleryFixture();
  delete f.media.media_details.sizes.full;
  const request = await f.galleryRequest();
  await f.call('connect');
  const result = await f.call('edit', request);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.blocks[0].innerBlocks[0].attributes.fullUrl, undefined);
  assert.equal(f.blocks[0].innerBlocks[0].attributes.url, f.media.source_url);
});

test('Gallery public media cache is checked again at the dispatch boundary', async () => {
  const f = completeGalleryFixture();
  const request = await f.galleryRequest();
  await f.call('connect');
  f.beforeFlush = () => {
    f.beforeFlush = undefined;
    f.galleryRecords[0].link = 'https://example.test/changed-cache';
  };

  const result = await f.call('edit', request);
  assert.equal(result.error, 'gallery_companion_required', JSON.stringify(result));
  assert.equal(f.attributeGroups ?? 0, 0);
});


test('protocol 3 sessions without media ownership refuse before reconnect or edit', async () => {
  const f = fixture();
  await f.call('connect');
  const session = f.window.__blockwork_editor;
  delete session.media_references;
  const before = JSON.stringify(f.blocks);
  const requested = session.requested;
  const locks = JSON.stringify(f.locks);

  for (const operation of ['connect', 'edit']) {
    const result = await f.call(operation, operation === 'edit' ? {
      edits: [{ op: 'update', path: [0], attributes: { content: 'Must not apply' } }],
    } : {});
    assert.equal(result.error, 'session_from_older_build', JSON.stringify(result));
    assert.equal(JSON.stringify(f.blocks), before);
    assert.equal(f.window.__blockwork_editor, session);
    assert.equal(session.requested, requested);
    assert.equal(JSON.stringify(f.locks), locks);
  }
});

test('same attachment refresh replaces only the changed owner token and revert restores it', async () => {
  const f = fixture();
  f.registrations['core/image'] = {
    name: 'core/image',
    attributes: { id: { type: 'integer' }, url: { type: 'string' }, alt: { type: 'string' } },
  };
  f.blocks = [0, 1].map((index) => ({ name: 'core/image', clientId: 'image' + index,
    attributes: {}, innerBlocks: [], isValid: true }));
  f.syncContent();
  const media = { id: 20, media_type: 'image', mime_type: 'image/jpeg',
    source_url: 'https://example.test/image.jpg', media_details: {}, alt_text: 'Original alt' };
  f.api = ({ path }) => path.startsWith('/wp/v2/media/20') ? media : undefined;
  const bind = async (path) => {
    const inspected = await f.call('inspect_media', {
      target: { site_url: target.site_url, user_id: 5 }, id: 20,
    });

    return f.call('edit', { media_bindings: [{ path, name: 'core/image', media_id: 20,
      media_token: inspected.record.edit_token, size: 'full', bind: { id: 'id', url: 'url', alt: 'alt' } }] });
  };

  await f.call('connect');
  assert.equal((await bind([0])).ok, true);
  assert.equal((await bind([1])).ok, true);
  media.alt_text = 'Refreshed alt';
  const fresh = await f.call('inspect_media', {
    target: { site_url: target.site_url, user_id: 5 }, id: 20,
  });
  const noOp = await f.call('edit', {
    edits: [{ op: 'update', path: [1], attributes: { alt: 'Manual neighbor alt' } }],
    media_bindings: [{ path: [0], name: 'core/image', media_id: 20,
      media_token: fresh.record.edit_token, size: 'full', bind: { id: 'id', url: 'url' } }],
  });
  assert.equal(noOp.ok, true, JSON.stringify(noOp));
  assert.equal((await f.save()).diagnostics.owner_client_id, 'image0');
  assert.equal((await bind([0])).ok, true);
  assert.equal(f.blocks[0].attributes.alt, 'Refreshed alt');
  const refused = await f.save();
  assert.equal(refused.error, 'stale_reference');
  assert.equal(refused.diagnostics.owner_client_id, 'image1');
  assert.equal((await f.call('revert')).ok, true);
  assert.equal(f.blocks[0].attributes.alt, 'Original alt');
  assert.equal((await f.save()).diagnostics.owner_client_id, 'image0');
  assert.equal((await bind([0])).ok, true);
  assert.equal((await f.call('edit', { edits: [{ op: 'remove', path: [1] }] })).ok, true);
  assert.equal((await f.save()).persistence, 'verified');
});


test('incompatible media ownership preserves uncertain save recovery on status and edit', async () => {
  const f = fixture();
  await f.edit();
  f.window.wp.data.dispatch('core/editor').savePost = async () => {
    f.saves++;
    f.saving = true;
    f.notify();
    f.saveError = { code: 'rest_cannot_publish', data: { status: 403 } };
    f.saving = false;
    f.notify();
  };

  f.window.wp.data.select('core/editor').didPostSaveRequestSucceed = () => false;
  const saved = await f.save();
  assert.equal(saved.persistence, 'uncertain');
  const session = f.window.__blockwork_editor;
  delete session.media_references;
  const before = JSON.stringify(f.blocks);

  for (const operation of ['status', 'edit', 'connect']) {
    const result = await f.call(operation, operation === 'edit' ? {
      edits: [{ op: 'update', path: [0], attributes: { content: 'Must not apply' } }],
    } : {});
    assert.equal(result.error, 'session_from_older_build', JSON.stringify(result));
    assert.equal(result.persistence, 'uncertain');
    assert.equal(result.next, 'recover_save_do_not_replay');
    assert.equal(JSON.stringify(result.receipt), JSON.stringify(saved.receipt));
    assert.equal(JSON.stringify(result.last_request), JSON.stringify(saved.last_request));
    assert.equal(JSON.stringify(f.blocks), before);
    assert.equal(f.window.__blockwork_editor, session);
  }
});


test('a saved Gallery Image retains ordinary media binding without a fresh-image gate', async () => {
  const f = completeGalleryFixture();
  const image = f.blocks[0].innerBlocks[0];
  image.attributes = { id: 19, url: 'https://example.test/previous.jpg', alt: 'Previous alt', caption: 'Keep caption', sizeSlug: 'full', linkDestination: 'none' };
  image.originalContent = '<figure>Previously saved image</figure>';
  f.syncContent();
  const request = await f.galleryRequest();
  await f.call('connect');
  const result = await f.call('edit', { media_bindings: request.media_bindings });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.blocks[0].innerBlocks[0].attributes.id, 20);
  assert.equal(f.blocks[0].innerBlocks[0].attributes.caption, 'Keep caption');
  assert.equal(f.attributeGroups ?? 0, 0);
});


function completeContextFixture() {
  const f = completeTabsFixture();
  f.registrations['example/context-box'] = { name: 'example/context-box', attributes: { tone: { type: 'string' } }, providesContext: { 'example/tone': 'tone' } };
  f.registrations['example/context-label'] = { name: 'example/context-label', attributes: { resolvedTone: { type: 'string' } }, usesContext: ['example/tone'] };
  const leaf = { name: 'example/context-label', clientId: 'leaf', attributes: { resolvedTone: 'red' }, innerBlocks: [], isValid: true };
  f.blocks = ['red', 'blue'].map((tone, i) => ({ name: 'example/context-box', clientId: 'box' + i, attributes: { tone }, innerBlocks: i ? [] : [leaf], isValid: true }));
  f.selectionStart = f.selectionEnd = { clientId: 'leaf', attributeKey: 'resolvedTone', offset: 0 };
  f.syncContent();
  f.contextRequest = { edits: [{ op: 'move', path: [0, 0], parent: [1], index: 0 }, { op: 'update', path: [1, 0], attributes: { resolvedTone: 'blue' } }] };

  return f;
}

test('complete context move applies two requested edits in one group and reverts', async () => {
  const f = completeContextFixture();
  assert.equal((await f.call('connect', { workflow: 'attached' })).ok, true);
  const before = copy(f.blocks), selection = f.selection();
  const result = await f.call('edit', f.contextRequest);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.pairedWrites, 1);
  assert.equal(f.blocks[1].innerBlocks[0].clientId, 'leaf');
  assert.equal(f.blocks[1].innerBlocks[0].attributes.resolvedTone, 'blue');
  assert.deepEqual(f.selection(), selection);
  assert.equal((await f.call('revert')).ok, true);
  assert.deepEqual(f.blocks, before);
});

for (const locked of ['move', 'insert']) test('complete context move checks final ' + locked + ' policy', async () => {
  const f = completeContextFixture();
  assert.equal((await f.call('connect')).ok, true);
  const before = copy(f.blocks);
  f.beforeFlush = () => { f[locked + 'Locked'] = true; };

  assert.equal((await f.call('edit', f.contextRequest)).ok, false);
  assert.equal(f.pairedWrites, 0);
  assert.deepEqual(f.blocks, before);
});

for (const when of ['before', 'after']) test('complete context move preserves foreign changes ' + when, async () => {
  const f = completeContextFixture();
  assert.equal((await f.call('connect', { workflow: 'attached' })).ok, true);
  const change = () => { f.blocks[0].attributes.tone = 'foreign'; };

  if (when === 'before') f.beforeFlush = change;
  else f.afterPaired = () => setTimeout(change, 150);
  const result = await f.call('edit', f.contextRequest);
  assert.equal(result.ok, false);
  assert.equal(f.pairedWrites, when === 'before' ? 0 : 1);
  assert.equal(f.blocks[0].attributes.tone, 'foreign');
});

function completeTabsAddFixture() {
  const f = completeTabsFixture();
  f.tabsRequest = { edits: [
    { op: 'insert', parent: [0, 1], block: { name: 'core/tab-panel', attributes: { label: 'Fourth' }, inner_blocks: [{ name: 'core/paragraph' }] } },
    { op: 'update', path: [0], attributes: { editorActiveTabIndex: 3 } },
    { op: 'update', path: [0, 0], attributes: { tabs: ['First', 'Second', 'Third', 'Fourth'].map(label => ({ label })) } },
  ] };

  return f;
}

test('complete Tabs add retains planned new IDs and selection and reverts', async () => {
  const f = completeTabsAddFixture();
  assert.equal((await f.call('connect', { workflow: 'attached' })).ok, true);
  const before = copy(f.blocks), selection = f.selection();
  const result = await f.call('edit', f.tabsRequest);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.pairedWrites, 1);
  const panel = f.blocks[0].innerBlocks[1].innerBlocks[3];
  assert.equal(panel.innerBlocks.length, 1);
  assert.equal(panel.innerBlocks[0].name, 'core/paragraph');
  assert.ok(panel.clientId && panel.innerBlocks[0].clientId);
  assert.deepEqual(f.selection(), selection);
  assert.equal((await f.call('revert')).ok, true);
  assert.deepEqual(f.blocks, before);
});

for (const invalid of ['implicit', 'labels', 'lock']) test('complete Tabs add refuses ' + invalid + ' before dispatch', async () => {
  const f = completeTabsAddFixture();
  assert.equal((await f.call('connect')).ok, true);

  if (invalid === 'implicit') delete f.tabsRequest.edits[0].block.inner_blocks;

  if (invalid === 'labels') f.tabsRequest.edits[2].attributes.tabs = [{ label: 'Wrong' }];

  if (invalid === 'lock') f.beforeFlush = () => { f.insertLocked = true; };

  const before = copy(f.blocks);
  assert.equal((await f.call('edit', f.tabsRequest)).ok, false);
  assert.equal(f.pairedWrites, 0);
  assert.deepEqual(f.blocks, before);
});

test('complete Tabs add checks the newly mounted paragraph policy and rolls back', async () => {
  const f = completeTabsAddFixture();
  const store = f.window.wp.data.select('core/block-editor');
  store.getBlockListSettings = id => f.pairedWrites && !['tabs', 'panels'].includes(id) ? { allowedBlocks: [] } : {};
  assert.equal((await f.call('connect', { workflow: 'attached' })).ok, true);
  const before = copy(f.blocks);
  const result = await f.call('edit', f.tabsRequest);
  assert.equal(result.error, 'insertion_refused', JSON.stringify(result));
  assert.equal(result.editor_result, 'rolled_back');
  assert.equal(result.diagnostics.constraint, 'parent_allowed_blocks');
  assert.equal(f.pairedWrites, 2);
  assert.deepEqual(f.blocks, before);
});

for (const attribute of ['tabs', 'root']) test('complete Tabs add refuses extra ' + attribute + ' attributes with a precise path', async () => {
  const f = completeTabsAddFixture();
  f.registrations[attribute === 'tabs' ? 'core/tab-list' : 'core/tabs'].attributes.extra = { type: 'string' };
  const index = attribute === 'tabs' ? 2 : 1;
  f.tabsRequest.edits[index].attributes.extra = 'Forbidden companion';
  assert.equal((await f.call('connect')).ok, true);
  const before = copy(f.blocks);
  const result = await f.call('edit', f.tabsRequest);
  assert.equal(result.error, 'tabs_companion_required', JSON.stringify(result));
  assert.deepEqual(copy(result.diagnostics.target_path), attribute === 'tabs' ? [0, 0] : [0]);
  assert.equal(f.pairedWrites, 0);
  assert.deepEqual(f.blocks, before);
});

test('complete context move never adopts a native unsupplied attribute value', async () => {
  const f = completeContextFixture();
  assert.equal((await f.call('connect', { workflow: 'attached' })).ok, true);
  f.afterPaired = () => { f.blocks[1].innerBlocks[0].attributes.resolvedTone = 'unsupplied'; };

  const result = await f.call('edit', f.contextRequest);
  assert.equal(result.ok, false);
  assert.equal(result.editor_result, 'partial');
  assert.equal(result.diagnostics.completed_edits, 0);
  assert.equal(f.pairedWrites, 1);
  assert.equal(f.blocks[1].innerBlocks[0].attributes.resolvedTone, 'unsupplied');
});

test('complete context move guarded revert preserves foreign metadata', async () => {
  const f = completeContextFixture();
  assert.equal((await f.call('connect', { workflow: 'attached' })).ok, true);
  assert.equal((await f.call('edit', f.contextRequest)).ok, true);
  f.foreignMeta();
  assert.equal((await f.call('revert')).ok, false);
  assert.equal(f.pairedWrites, 1);
  assert.equal(f.postEdits.meta.note, 'Foreign');
});

test('complete context move requires supplied final attributes without effects', async () => {
  const f = completeContextFixture();
  f.contextRequest.edits.pop();
  assert.equal((await f.call('connect')).ok, true);
  const before = copy(f.blocks);
  const result = await f.call('edit', f.contextRequest);
  assert.equal(result.error, 'context_companion_required', JSON.stringify(result));
  assert.match(result.hint, /resolvedTone/);
  assert.equal(f.pairedWrites, 0);
  assert.deepEqual(f.blocks, before);
});

function ordinaryMetaFixture() {
  const f = fixture();
  f.post.meta = { note: 'Before', other: 1 };
  f.schema = { meta: { type: 'object', properties: { note: { type: 'string' }, other: { type: 'integer' } } } };

  return f;
}

function ordinaryBlockActions(f) {
  const dispatch = f.window.wp.data.dispatch;
  const actions = dispatch('core/block-editor');
  f.window.wp.data.dispatch = name => name === 'core/block-editor' ? actions : dispatch(name);

  return actions;
}

test('ordinary meta patches preserve unrelated pending values and require explicit per-key save authorization', async () => {
  const f = ordinaryMetaFixture();
  await f.call('connect');
  const actions = f.window.wp.data.dispatch('core/editor');
  actions.editPost({ meta: { other: 2 } });
  const writes = [];
  const editPost = actions.editPost;
  actions.editPost = values => { writes.push(copy(values));

 return editPost(values); };

  const edited = await f.call('edit', { settings: { meta: { note: 'Requested' } } });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.deepEqual(writes, [{ meta: { note: 'Requested' } }]);
  assert.deepEqual(copy(edited.settings), { meta: { note: 'Requested' } });
  assert.deepEqual(f.postEdits.meta, { note: 'Requested', other: 2 });
  assert.deepEqual(copy(f.window.__blockwork_editor.requested), { meta: { note: 'Requested' } });

  for (const read of [false, true]) {
    if (read) assert.equal((await f.call('read', { settings: true })).ok, true);
    const refused = await f.call('prepare_save');
    assert.equal(refused.error, 'unexpected_editor_change', JSON.stringify(refused));
    assert.deepEqual(copy(refused.diagnostics.fields), ['meta.other']);
  }

  assert.equal((await f.call('edit', { settings: { meta: { other: 2 } } })).ok, true);
  assert.deepEqual(copy(f.window.__blockwork_editor.requested), { meta: { note: 'Requested', other: 2 } });
  assert.equal((await f.save()).persistence, 'verified');
  assert.deepEqual(f.post.meta, { note: 'Requested', other: 2 });
});

test('ordinary meta edit and revert observe only requested keys and restore the complete native pending draft', async () => {
  const f = ordinaryMetaFixture();
  await f.call('connect');
  const actions = f.window.wp.data.dispatch('core/editor');
  actions.editPost({ meta: { other: 2 } });
  const before = { blocks: copy(f.blocks), pending: copy(f.postEdits), dirty: f.dirty };
  assert.equal((await f.call('edit', { settings: { meta: { note: 'Requested' } } })).ok, true);
  assert.deepEqual(copy(f.window.__blockwork_editor.observed_fields.meta), { note: 'Requested', other: 1 });
  const stale = await f.call('edit', { settings: { meta: { other: 2 } } });
  assert.equal(stale.error, 'field_changed', JSON.stringify(stale));
  assert.deepEqual(copy(stale.diagnostics.fields), ['meta.other']);
  const reverted = await f.call('revert');
  assert.equal(reverted.ok, true, JSON.stringify(reverted));
  assert.deepEqual({ blocks: f.blocks, pending: f.postEdits, dirty: f.dirty }, before);
  assert.deepEqual(copy(f.window.__blockwork_editor.observed_fields.meta), { note: 'Before', other: 1 });
  assert.equal((await f.call('edit', { settings: { meta: { other: 2 } } })).error, 'field_changed');
  actions.editPost({ meta: { note: 'Native' } });
  assert.equal((await f.call('edit', { settings: { meta: { note: 'Agent' } } })).error, 'field_changed');
});

test('ordinary meta authorization accumulates across edits and guarded revert removes only the latest authorization', async () => {
  const f = ordinaryMetaFixture();
  await f.call('connect');
  f.window.wp.data.dispatch('core/editor').editPost({ meta: { other: 2 } });
  await f.call('read', { settings: true });
  assert.equal((await f.call('edit', { settings: { meta: { note: 'Requested' } } })).ok, true);
  assert.equal((await f.call('edit', { settings: { meta: { other: 2 } } })).ok, true);
  assert.equal((await f.call('revert')).ok, true);
  assert.deepEqual(copy(f.window.__blockwork_editor.requested), { meta: { note: 'Requested' } });
  assert.equal((await f.call('prepare_save')).error, 'unexpected_editor_change');
});

for (const mode of ['future', 'obsolete']) {
  test('ordinary rollback refuses an ' + mode + ' plan state after dispatch', async () => {
    const f = fixture();
    await f.call('connect', { workflow: 'attached' });
    const actions = ordinaryBlockActions(f);
    const update = actions.updateBlockAttributes;
    let calls = 0, resets = 0;
    const reset = actions.resetBlocks;
    actions.resetBlocks = (...args) => { resets++;

 return reset(...args); };

    actions.updateBlockAttributes = (id, attrs) => {
      update(id, attrs);
      calls++;

      if ((mode === 'future' && calls === 1) || (mode === 'obsolete' && calls === 2))
        f.blocks[0].attributes.content = mode === 'future' ? 'Three' : 'Before';
    };

    const result = await f.call('edit', { edits: ['One', 'Two', 'Three'].map(content => ({ op: 'update', client_id: 'a', attributes: { content } })) });
    assert.equal(result.editor_result, 'partial', JSON.stringify(result));
    assert.equal(result.diagnostics.completed_edits, mode === 'future' ? 0 : 1);
    assert.equal(result.diagnostics.dispatched_edits, mode === 'future' ? 1 : 2);
    assert.equal(resets, 0);
    assert.equal(f.blocks[0].attributes.content, mode === 'future' ? 'Three' : 'Before');
  });
}

for (const mode of ['meta', 'title', 'unknown', 'pending_key', 'dirty']) {
  test('ordinary rollback preserves foreign ' + mode + ' before settings dispatch', async () => {
    const f = ordinaryMetaFixture();
    await f.call('connect', { workflow: 'attached' });
    const actions = ordinaryBlockActions(f);
    const update = actions.updateBlockAttributes;
    let resets = 0, settingsWrites = 0;
    const reset = actions.resetBlocks;
    actions.resetBlocks = (...args) => { resets++;

 return reset(...args); };

    const postActions = f.window.wp.data.dispatch('core/editor');
    const editPost = postActions.editPost;
    postActions.editPost = (...args) => { settingsWrites++;

 return editPost(...args); };

    actions.updateBlockAttributes = (...args) => {
      update(...args);

      if (mode === 'meta') f.postEdits = { meta: { ...f.post.meta, other: 2 } };

      if (mode === 'title') f.postEdits = { title: 'Foreign title' };

      if (mode === 'unknown') f.postEdits = { foreign_setting: 'Foreign' };

      if (mode === 'pending_key') f.postEdits = { title: f.post.title.raw };

      if (mode === 'dirty') f.dirty = false;
    };

    const result = await f.call('edit', { edits: changes, settings: { meta: { note: 'Requested' } } });
    assert.equal(result.editor_result, 'partial', JSON.stringify(result));
    assert.equal(resets, 0);
    assert.equal(settingsWrites, 0);
    assert.equal(f.blocks[0].attributes.content, 'After');

    if (mode === 'meta') assert.equal(f.postEdits.meta.other, 2);

    if (mode === 'title') assert.equal(f.postEdits.title, 'Foreign title');

    if (mode === 'unknown') assert.equal(f.postEdits.foreign_setting, 'Foreign');

    if (mode === 'pending_key') assert.equal(Object.hasOwn(f.postEdits, 'title'), true);

    if (mode === 'dirty') assert.equal(f.dirty, false);
  });
}

test('ordinary revert checks the complete draft again after asynchronous restore preflight', async () => {
  const f = ordinaryMetaFixture();
  await f.call('connect', { workflow: 'attached' });
  assert.equal((await f.call('edit', { edits: changes, settings: { meta: { note: 'Requested' } } })).ok, true);
  const actions = ordinaryBlockActions(f);
  let resets = 0;
  const reset = actions.resetBlocks;
  actions.resetBlocks = (...args) => { resets++;

 return reset(...args); };

  const store = f.window.wp.data.select('core/block-editor');
  const selection = store.getSelectionStart;
  let injected = false;
  store.getSelectionStart = () => {
    if (!injected) { injected = true; queueMicrotask(() => { f.postEdits.meta.other = 2; }); }

    return selection();
  };

  const result = await f.call('revert');
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(resets, 0);
  assert.deepEqual(f.postEdits.meta, { note: 'Requested', other: 2 });
  assert.equal(f.blocks[0].attributes.content, 'After');
});

test('ordinary revert preserves a foreign change during the block restore await and skips setting restoration', async () => {
  const f = ordinaryMetaFixture();
  f.nativeContentMarker = true;
  await f.call('connect', { workflow: 'attached' });
  assert.equal((await f.call('edit', { edits: changes, settings: { meta: { note: 'Requested' } } })).ok, true);
  const actions = ordinaryBlockActions(f);
  const reset = actions.resetBlocks;
  actions.resetBlocks = async (...args) => {
    reset(...args);
    await Promise.resolve();
    f.postEdits.meta.other = 2;
  };

  const writes = [];
  const postActions = f.window.wp.data.dispatch('core/editor');
  const editPost = postActions.editPost;
  postActions.editPost = values => { writes.push(copy(values));

 return editPost(values); };

  const result = await f.call('revert');
  assert.equal(result.editor_result, 'partial', JSON.stringify(result));
  assert.equal(writes.length, 0);
  assert.deepEqual(f.postEdits.meta, { note: 'Requested', other: 2 });
});

test('ordinary rollback and revert restore original IDs, pending content kind, values and dirty state', async () => {
  for (const operation of ['revert', 'rollback']) {
    for (const existingContent of [false, true]) {
      const f = ordinaryMetaFixture();
      f.nativeContentMarker = true;
      await f.call('connect', { workflow: 'attached' });
      f.window.wp.data.dispatch('core/editor').editPost({ meta: { other: 2 } });

      if (existingContent) {
        f.blocks[2].attributes.content = 'Existing draft';
        f.postEdits.content = () => f.window.wp.blocks.serialize(f.blocks);
      }

      const before = { blocks: copy(f.blocks), keys: Object.keys(f.postEdits).sort(), meta: copy(f.postEdits.meta), dirty: f.dirty, content: f.window.wp.blocks.serialize(f.blocks) };
      const request = operation === 'rollback'
        ? { edits: [{ op: 'insert', block: { name: 'example/card' } }] }
        : { edits: changes, settings: { meta: { note: 'Requested' } } };

      if (operation === 'rollback') f.onSelect = () => { throw { code: 'probe-render-failed' }; };

      const edited = await f.call('edit', request);
      const result = operation === 'rollback' ? edited : await f.call('revert');
      assert.equal(result.editor_result, operation === 'rollback' ? 'rolled_back' : 'reverted', JSON.stringify(result));
      assert.deepEqual(f.blocks, before.blocks);
      assert.deepEqual(Object.keys(f.postEdits).sort(), before.keys);
      assert.deepEqual(f.postEdits.meta, before.meta);
      assert.equal(f.dirty, before.dirty);
      assert.equal(f.window.wp.blocks.serialize(f.blocks), before.content);
      assert.equal(Object.prototype.toString.call(f.postEdits.content), existingContent ? '[object Function]' : '[object Undefined]');

      if (existingContent) assert.equal(f.postEdits.content({ blocks: f.blocks }), before.content);
    }
  }
});

test('ordinary revert verifies the original draft after the setting restore await', async () => {
  const f = ordinaryMetaFixture();
  await f.call('connect', { workflow: 'attached' });
  await f.call('edit', { settings: { meta: { note: 'Requested' } } });
  const actions = f.window.wp.data.dispatch('core/editor');
  const editPost = actions.editPost;
  actions.editPost = async values => {
    editPost(values);
    await Promise.resolve();
    f.postEdits.foreign_setting = 'Foreign';
    f.dirty = true;
  };

  const result = await f.call('revert');
  assert.equal(result.editor_result, 'partial', JSON.stringify(result));
  assert.equal(f.postEdits.foreign_setting, 'Foreign');
});

test('ordinary meta authorization excludes unrelated metadata physically preserved by a paired Footnote write', async () => {
  const f = explicitFootnoteFixture();
  await f.call('connect');
  f.foreignMeta();
  await f.call('read', { settings: true });
  const edited = await f.call('edit', f.footnoteRequest);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(f.postEdits.meta.note, 'Foreign');
  assert.deepEqual(copy(f.window.__blockwork_editor.requested.meta), { footnotes: f.footnoteRequest.settings.meta.footnotes });
  const refused = await f.call('prepare_save');
  assert.equal(refused.error, 'unexpected_editor_change', JSON.stringify(refused));
  assert.deepEqual(copy(refused.diagnostics.fields), ['meta.note']);
});

for (const content of ['Three', 'Before']) {
  test('ordinary rollback refuses a noncurrent state reached before the next dispatch: ' + content, async () => {
    const f = fixture();
    await f.call('connect', { workflow: 'attached' });
    const actions = ordinaryBlockActions(f);
    let writes = 0, resets = 0;
    const update = actions.updateBlockAttributes;
    const reset = actions.resetBlocks;
    actions.updateBlockAttributes = (...args) => { writes++;

 return update(...args); };

    actions.resetBlocks = (...args) => { resets++;

 return reset(...args); };

    const store = f.window.wp.data.select('core/block-editor');
    const editable = store.canEditBlock;
    let injected = false;
    store.canEditBlock = (...args) => {
      if (!injected && f.blocks[0].attributes.content === 'One') {
        injected = true;
        queueMicrotask(() => { f.blocks[0].attributes.content = content; });
      }

      return editable(...args);
    };

    const result = await f.call('edit', { edits: ['One', 'Two', 'Three'].map(content => ({ op: 'update', client_id: 'a', attributes: { content } })) });
    assert.equal(result.editor_result, 'partial', JSON.stringify(result));
    assert.equal(writes, 1);
    assert.equal(resets, 0);
    assert.equal(result.diagnostics.completed_edits, 1);
    assert.equal(result.diagnostics.dispatched_edits, 1);
    assert.equal(f.blocks[0].attributes.content, content);
  });
}

test('ordinary revert preserves foreign raw content kind during restore and performs no setting restore', async () => {
  const f = ordinaryMetaFixture();
  f.nativeContentMarker = true;
  await f.call('connect', { workflow: 'attached' });
  assert.equal((await f.call('edit', { edits: changes, settings: { meta: { note: 'Requested' } } })).ok, true);
  const actions = ordinaryBlockActions(f);
  const reset = actions.resetBlocks;
  actions.resetBlocks = async (...args) => {
    reset(...args);
    await Promise.resolve();
    f.postEdits.content = f.window.wp.blocks.serialize(f.blocks);
  };

  const postActions = f.window.wp.data.dispatch('core/editor');
  let settingsWrites = 0;
  const editPost = postActions.editPost;
  postActions.editPost = (...args) => { settingsWrites++;

 return editPost(...args); };

  const result = await f.call('revert');
  assert.equal(result.editor_result, 'partial', JSON.stringify(result));
  assert.equal(settingsWrites, 0);
  assert.equal(f.postEdits.meta.note, 'Requested');
  assert.equal(Object.prototype.toString.call(f.postEdits.content), '[object String]');
});


test('legacy whole-meta sessions cannot authorize pending keys in the new format', async () => {
  const f = fixture();
  await f.call('connect');
  const session = f.window.__blockwork_editor;
  session.protocol = 3;
  session.requested.meta = { note: 'Requested A', retained: 'Native B' };
  const original = JSON.stringify(f.blocks);
  const requested = JSON.stringify(session.requested);

  for (const operation of ['status', 'prepare_save', 'connect']) {
    const result = await f.call(operation);
    assert.equal(result.error, 'session_from_older_build', JSON.stringify(result));
    assert.equal(JSON.stringify(session.requested), requested);
    assert.equal(JSON.stringify(f.blocks), original);
    assert.equal(f.window.__blockwork_editor, session);
    assert.equal(f.saves, 0);
  }
});

test('legacy metadata session refusal retains uncertain save recovery', async () => {
  const f = fixture();
  await f.edit();
  f.interruptSave = true;
  const saved = await f.save();
  assert.equal(saved.persistence, 'uncertain');
  const session = f.window.__blockwork_editor;
  session.protocol = 3;

  for (const operation of ['status', 'prepare_save', 'connect']) {
    const result = await f.call(operation);
    assert.equal(result.error, 'session_from_older_build', JSON.stringify(result));
    assert.equal(result.persistence, 'uncertain');
    assert.equal(result.next, 'recover_save_do_not_replay');
    assert.equal(JSON.stringify(result.receipt), JSON.stringify(saved.receipt));
    assert.equal(JSON.stringify(result.last_request), JSON.stringify(saved.last_request));
    assert.equal(f.window.__blockwork_editor, session);
  }
});

test('ordinary revert restores original noncanonical content after the native reset callback', async () => {
  const f = fixture();
  const originalBlocks = copy(f.blocks);
  f.nativeContentMarker = true;
  f.post.content.raw = '  ' + f.post.content.raw;
  const originalContent = f.post.content.raw;
  const wp = f.window.wp;
  let flushing = false;
  let entityBlocks = false;
  wp.element = { flushSync(callback) {
    flushing = true;

    try { return callback(); } finally { flushing = false; }
  } };
  const dispatch = wp.data.dispatch;
  const core = dispatch('core');
  const select = wp.data.select;
  const coreStore = select('core');
  const record = coreStore.getEditedEntityRecord;
  coreStore.getEditedEntityRecord = (...args) => ({ ...record(...args), blocks: entityBlocks ? f.blocks : undefined });
  wp.data.select = name => name === 'core' ? coreStore : select(name);
  const actions = ordinaryBlockActions(f);

  for (const name of ['insertBlocks', 'resetBlocks']) {
    const action = actions[name];
    actions[name] = (...args) => {
      entityBlocks = true;

      return action(...args);
    };
  }

  const write = core.editEntityRecord;
  core.editEntityRecord = (kind, type, id, values, options) => {
    assert.equal(flushing, true);
    assert.equal(Object.hasOwn(values, 'blocks'), true);
    assert.equal(values.blocks, undefined);
    entityBlocks = false;

    return write(kind, type, id, { content: values.content }, options);
  };

  wp.data.dispatch = name => name === 'core' ? core : name === 'core/block-editor' ? actions : dispatch(name);
  wp.data.select('core/editor').getEditedPostContent = () => {
    const content = f.postEdits?.content;

    if (Object.prototype.toString.call(content) === '[object Function]') return content({ blocks: f.blocks });

    if (Object.prototype.toString.call(content) === '[object String]') return content;

    return entityBlocks ? wp.blocks.serialize(f.blocks) : f.post.content.raw;
  };

  const connected = await f.call('connect');
  assert.equal(connected.ok, true, JSON.stringify(connected));
  const edited = await f.call('edit', { edits: [{ op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'Temporary' } } }] });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const reverted = await f.call('revert');
  assert.equal(reverted.editor_result, 'reverted', JSON.stringify(reverted));
  assert.deepEqual(f.blocks, originalBlocks);
  assert.equal(wp.data.select('core/editor').getEditedPostContent(), originalContent);
  assert.deepEqual(f.postEdits, {});
  assert.equal(f.dirty, false);
});
