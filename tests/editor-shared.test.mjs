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

test('shared documents refuse settings and unsynced patterns', async () => {
  const f = sharedFixture();
  await f.call('connect');
  assert.equal((await f.call('edit', { edits: changes, scope: 'all_references', post: { title: 'No' } })).error, 'shared_content_only');
  f.post.wp_pattern_sync_status = 'unsynced';
  assert.equal((await f.call('connect')).error, 'pattern_not_synced');
  assert.equal(f.saves, 0);
});

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
