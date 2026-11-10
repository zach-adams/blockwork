import assert from 'node:assert/strict';
import test from 'node:test';
import { bundles } from '../tools/bundle.mjs';
import { source, target, changes, copy, outsideDebug, fixture, defaultRoundTripFixture, mixedFixture, linkFixture, patternSectionFixture } from './helpers/editor-fixture.mjs';

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

test('rejects a mismatched site before writing', async () => {
  const f = fixture();
  assert.equal((await f.call('connect', { target: { site_url: 'https://elsewhere.test', post_id: 7, post_type: 'page' } })).error, 'target_mismatch');
  assert.equal(f.saves, 0);
});

test('attribute edits reject arrays used as attribute objects', async () => {
  const f = fixture();
  const result = await f.edit([{ ...changes[0], attributes: ['invalid'] }]);
  assert.equal(result.error, 'invalid_edit');
  assert.equal(f.dirty, false);
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
