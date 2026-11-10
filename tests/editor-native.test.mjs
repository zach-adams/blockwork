import assert from 'node:assert/strict';
import test from 'node:test';
import { footnoteParagraph, footnoteBodies } from './helpers/footnote-rich-text.mjs';
import { target, changes, copy, outsideDebug, fixture, queryFixture, explicitFootnoteFixture, completeTabsFixture, structuralFootnoteFixture, emptyCommentsFixture, completeGalleryFixture, completeContextFixture, completeTabsAddFixture } from './helpers/editor-fixture.mjs';

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
