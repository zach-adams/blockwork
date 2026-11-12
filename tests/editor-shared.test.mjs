import assert from 'node:assert/strict';
import test from 'node:test';
import { target, changes, copy, fixture, mixedFixture, sharedFixture, referenceFixture, storedMarkup } from './helpers/editor-fixture.mjs';

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

test('shared documents allow pattern titles and refuse settings and unsynced patterns', async () => {
  const f = sharedFixture();
  await f.call('connect');
  assert.equal((await f.call('edit', { edits: changes, scope: 'all_references', post: { title: 'Pattern title' } })).ok, true);
  assert.equal((await f.call('edit', { scope: 'all_references', post: { status: 'draft' } })).error, 'shared_content_only');
  assert.equal((await f.call('edit', { scope: 'all_references', settings: { meta: {} } })).error, 'shared_content_only');
  f.post.wp_pattern_sync_status = 'unsynced';
  assert.equal((await f.call('connect')).error, 'pattern_not_synced');
  assert.equal(f.saves, 0);
});

test('reference insertion checks currentness before editing, and a later entity change does not block the save', async () => {
  const f = referenceFixture();
  const refTarget = { ...target, post_type: 'wp_block', post_id: 77 };
  const referenced = await f.call('inspect_entity', { target: refTarget });
  assert.equal(referenced.ok, true, JSON.stringify(referenced));
  await f.call('connect');

  const edited = await f.call('edit', { edits: [{ op: 'insert_reference',
    reference: { entity_type: 'wp_block', entity_id: 77, reference_token: referenced.reference_token } }] });

  assert.equal(edited.ok, true, JSON.stringify(edited));
  const original = f.referenceRecord.content.raw;
  f.referenceRecord.title.raw = 'Changed after insertion';
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

function patternDraft() {
  const f = sharedFixture();
  f.post.status = 'auto-draft';
  f.post.slug = '';
  f.post.title.raw = '';
  f.blocks = [];
  f.syncContent();

  return f;
}

test('new synced patterns publish title and content without a requested slug', async () => {
  const f = patternDraft();
  assert.equal((await f.call('connect')).ok, true);
  const missing = await f.save();
  assert.equal(missing.error, 'pattern_creation_fields_required', JSON.stringify(missing));
  assert.match(missing.hint, /post.title/);
  const edited = await f.call('edit', { scope: 'all_references', post: { title: 'Reusable CTA', status: 'publish' }, edits: [{ op: 'insert', block: { name: 'core/paragraph', attributes: { content: 'Call us' } } }] });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.post.title.raw, 'Reusable CTA');
  assert.equal(f.post.status, 'publish');
  assert.equal((await f.call('edit', { scope: 'all_references', post: { status: 'publish' } })).error, 'shared_content_only');
});

test('new patterns refuse missing title, non-reusable roots and implicit parent reuse before mutation', async () => {
  for (const post of [{ title: 'Title' }, { status: 'publish' }, { title: ' ', status: 'publish' }]) {
    const f = patternDraft();
    await f.call('connect');
    const result = await f.call('edit', { scope: 'all_references', post });
    assert.equal(result.error, 'pattern_creation_fields_required', JSON.stringify(result));
    assert.equal(f.dirty, false);
  }

  for (const registration of [{ supports: { reusable: false } }, { parent: ['core/group'] }]) {
    const f = patternDraft();
    Object.assign(f.registrations['core/paragraph'], registration);
    await f.call('connect');
    const result = await f.call('edit', { scope: 'all_references', post: { title: 'Title', status: 'publish' }, edits: [{ op: 'insert', block: { name: 'core/paragraph' } }] });
    assert.equal(result.error, 'pattern_block_not_reusable', JSON.stringify(result));
    assert.equal(result.diagnostics.edit_index, 0);
    assert.match(result.hint, /native reusable/);
    assert.equal(f.blocks.length, 0);
    assert.equal(f.dirty, false);
    assert.equal(f.saves, 0);
  }
});

function detachable() {
  const f = referenceFixture();
  f.registrations['core/paragraph'].attributes.metadata = { type: 'object' };
  f.registrations['core/block'].attributes.content = { type: 'object' };
  const wp = f.window.wp;
  f.referenceRecord.content.raw = wp.blocks.serialize([
    wp.blocks.createBlock('core/paragraph', { content: 'Default', metadata: { name: 'Question', id: 'binding-id', bindings: { content: { source: 'core/pattern-overrides' } } } }),
    wp.blocks.createBlock('core/paragraph', { content: 'Second', metadata: { id: 'other-id', bindings: {} } }),
  ]);
  f.blocks.splice(0, f.blocks.length, wp.blocks.createBlock('core/block', { ref: 77, content: { Question: { content: 'Instance', unregistered: 'Ignored' } } }));
  f.syncContent();

  return f;
}

test('detach replaces an unloaded reference with overridden static blocks and supports revert', async () => {
  const f = detachable();
  const original = f.referenceRecord.content.raw;
  const referenceId = f.blocks[0].clientId;
  await f.call('connect');
  const result = await f.call('edit', { edits: [{ op: 'detach_reference', client_id: referenceId }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed.length, 2);
  assert.deepEqual(copy(f.blocks[0].attributes), { content: 'Instance', metadata: { name: 'Question' } });
  assert.equal(f.blocks[1].attributes.metadata, undefined);
  assert.equal(f.referenceRecord.content.raw, original);
  // An author can read another user's published pattern only in view context.
  assert.ok(f.requests.some(({ path }) => path.startsWith('/wp/v2/blocks/77?context=view&_fields=')), JSON.stringify(f.requests));
  assert.equal((await f.call('revert')).ok, true);
  assert.equal(f.blocks[0].clientId, referenceId);
  assert.equal(f.blocks[0].attributes.ref, 77);
  const again = await f.call('edit', { edits: [{ op: 'detach_reference', client_id: referenceId }] });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.referenceRecord.content.raw, original);
});

test('detach uses live edited pattern blocks and does not mutate their attributes', async () => {
  const f = detachable();
  const source = f.window.wp.blocks.parse(f.referenceRecord.content.raw);
  source[1].attributes.content = 'Live pending content';
  f.editedReference = { blocks: source, content: f.referenceRecord.content.raw };
  const before = copy(source);
  await f.call('connect');
  const result = await f.call('edit', { edits: [{ op: 'detach_reference', client_id: f.blocks[0].clientId }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.blocks[1].attributes.content, 'Live pending content');
  assert.deepEqual(copy(source), before);
});

test('detach refuses non-pattern references, invalid pattern content and native removal locks', async () => {
  for (const name of ['core/paragraph', 'core/navigation', 'core/template-part']) {
    const f = detachable();
    f.registrations[name] ??= { name, attributes: { ref: { type: 'number' } } };
    f.blocks[0].name = name;

    if (name === 'core/paragraph') f.blocks[0].attributes = { content: 'Plain' };
    f.syncContent();
    await f.call('connect');
    const result = await f.call('edit', { edits: [{ op: 'detach_reference', client_id: f.blocks[0].clientId }] });
    assert.equal(result.error, 'detach_pattern_required', JSON.stringify(result));
    assert.match(result.hint, /core\/block/);
    assert.equal(f.saves, 0);
  }

  const invalid = detachable();
  invalid.editedReference = { blocks: [{ name: 'core/paragraph', attributes: { content: 'Bad' }, innerBlocks: [], clientId: 'invalid', isValid: false }], content: '' };
  await invalid.call('connect');
  const refused = await invalid.call('edit', { edits: [{ op: 'detach_reference', client_id: invalid.blocks[0].clientId }] });
  assert.equal(refused.error, 'detach_pattern_unsupported', JSON.stringify(refused));
  assert.equal(invalid.blocks[0].name, 'core/block');
  const locked = detachable();
  locked.blocks[0].attributes.lock = { remove: true };
  locked.syncContent();
  await locked.call('connect');
  const result = await locked.call('edit', { edits: [{ op: 'detach_reference', client_id: locked.blocks[0].clientId }] });
  assert.equal(result.error, 'block_locked', JSON.stringify(result));
  assert.equal(locked.blocks[0].name, 'core/block');
});

test('pattern discovery includes only the supported shared create type and checks create permission', async () => {
  for (const allow of ['GET, POST', 'GET', null]) {
    const allowed = allow === 'GET, POST';
    const f = sharedFixture();
    // WordPress lists the methods this user may send, the header core-data's canUser reads.
    f.api = ({ path, method, parse }) => method === 'OPTIONS' && path === '/wp/v2/blocks' && parse === false
      ? new Response('{}', { headers: allow === null ? {} : { allow } })
      : path === '/wp/v2/types?context=edit'
        ? Object.fromEntries(['wp_block', 'wp_navigation', 'wp_template', 'wp_template_part'].map((slug) => [slug, { slug, rest_namespace: 'wp/v2', rest_base: slug === 'wp_block' ? 'blocks' : slug, supports: { editor: true } }]))
        : path.startsWith('/wp/v2/blocks?') ? [] : undefined;
    const site = { site_url: target.site_url, user_id: target.user_id };
    const types = await f.call('discover', { target: site });
    assert.equal(types.ok, true, JSON.stringify(types));
    assert.deepEqual(copy(types.types).map((type) => type.name), ['wp_block']);
    const discovered = await f.call('discover', { target: site, post_type: 'wp_block' });
    assert.equal(discovered.ok, allowed, JSON.stringify(discovered));

    if (allowed) assert.match(discovered.new_editor_url, /post-new.php\?post_type=wp_block$/);
    else if (allow === null) assert.equal(discovered.error, 'invalid_native_response', JSON.stringify(discovered));
    else {
      assert.equal(discovered.error, 'pattern_creation_forbidden');
      assert.equal(discovered.diagnostics.capability, 'create');
      assert.match(discovered.hint, /authorized account/);
    }

    const unsupported = await f.call('discover', { target: site, post_type: 'wp_template_part' });
    assert.equal(unsupported.error, 'invalid_resource_request');
    assert.equal(f.saves, 0);
  }
});

test('template parts and navigation retain their content-only settings rule', async () => {
  for (const type of ['wp_template', 'wp_template_part', 'wp_navigation']) {
    const f = sharedFixture(type, type === 'wp_navigation' ? 7 : 'theme//part');
    await f.call('connect');
    const result = await f.call('edit', { scope: 'site_wide', post: { title: 'Refused title' } });
    assert.equal(result.error, 'shared_content_only', JSON.stringify(result));
    assert.equal(f.dirty, false);
  }
});

test('a forbidden pattern reference destination refuses the whole source replacement batch', async () => {
  const f = referenceFixture();
  const inspected = await f.call('inspect_entity', { target: { ...target, post_type: 'wp_block', post_id: 77 } });
  await f.call('connect');
  const before = copy(f.blocks);
  const store = f.window.wp.data.select('core/block-editor');
  const canInsert = store.canInsertBlockType;
  store.canInsertBlockType = (name, root) => name !== 'core/block' && canInsert(name, root);
  const result = await f.call('edit', { edits: [
    { op: 'remove', client_id: f.blocks[0].clientId },
    { op: 'insert_reference', index: 0, reference: { entity_type: 'wp_block', entity_id: 77, reference_token: inspected.reference_token } },
  ] });
  assert.equal(result.error, 'insertion_refused', JSON.stringify(result));
  assert.equal(result.diagnostics.edit_index, 1);
  assert.deepEqual(copy(f.blocks), before);
  assert.equal(f.dirty, false);
});

test('detach recursively strips bindings and applies named overrides without saving the source', async () => {
  const f = detachable();
  const wp = f.window.wp;
  f.registrations['core/group'] = { name: 'core/group', attributes: { metadata: { type: 'object' } } };
  const nested = wp.blocks.createBlock('core/group', { metadata: { id: 'outer', bindings: {} } }, wp.blocks.parse(f.referenceRecord.content.raw));
  f.referenceRecord.content.raw = wp.blocks.serialize([nested]);
  const source = f.referenceRecord.content.raw;
  await f.call('connect');
  const result = await f.call('edit', { edits: [{ op: 'detach_reference', client_id: f.blocks[0].clientId }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.blocks[0].name, 'core/group');
  assert.equal(f.blocks[0].attributes.metadata, undefined);
  assert.equal(f.blocks[0].innerBlocks[0].attributes.content, 'Instance');
  assert.deepEqual(copy(f.blocks[0].innerBlocks[0].attributes.metadata), { name: 'Question' });
  assert.equal(f.blocks[0].innerBlocks[1].attributes.metadata, undefined);
  assert.equal(f.referenceRecord.content.raw, source);
  assert.equal(f.saves, 0);
});

test('detach validates its selector before acquiring an editor session', async () => {
  const f = referenceFixture();
  const result = await f.call('edit', { edits: [{ op: 'detach_reference' }] });
  assert.equal(result.error, 'invalid_edit', JSON.stringify(result));
  assert.equal(result.issues[0].path, 'edits.0.client_id');
  assert.equal(f.window.__blockwork_editor, undefined);
  assert.equal(f.pulses, 0);
});
