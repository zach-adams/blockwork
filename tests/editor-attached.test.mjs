import assert from 'node:assert/strict';
import test from 'node:test';
import { changes, copy, fixture } from './helpers/editor-fixture.mjs';

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
