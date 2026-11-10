import assert from 'node:assert/strict';
import test from 'node:test';
import { target, changes, copy, outsideDebug, fixture, sharedFixture, explicitFootnoteFixture, ordinaryMetaFixture, ordinaryBlockActions } from './helpers/editor-fixture.mjs';

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
    assert.ok(result.diagnostics.fields.some(name => name.startsWith(field)));
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

test('save accepts a native autosave from the same editor after preparation', async () => {
  const f = fixture();
  assert.equal((await f.call('connect', { workflow: 'attached' })).ok, true);
  assert.equal((await f.call('edit', { edits: [{ op: 'update', client_id: 'a', attributes: { content: 'After' } }] })).ok, true);
  const prepared = await f.call('prepare_save', { save_all_pending: true });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  f.autosave();

  const saved = await f.call('save', { receipt: prepared.receipt, save_all_pending: true });
  assert.equal(saved.ok, true, JSON.stringify(saved));
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

test('an uncertain save cannot be prepared again until recovered and reconnected', async () => {
  const f = fixture();
  await f.edit();
  f.interruptSave = true;
  assert.equal((await f.save()).persistence, 'uncertain');
  f.interruptSave = false;
  assert.equal((await f.call('prepare_save')).error, 'save_unresolved');
  assert.equal(f.saves, 1);
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
