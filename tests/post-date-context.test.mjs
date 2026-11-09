import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const built = await build({
  stdin: {
    contents: `export { preparePostDates } from './query';
    export { postDateField, editRestriction, removalRestriction, readTree } from './inspection';
    export { preparePlan, applyPlan } from './edits'; export { resetDocument } from './document-view'; export { requireCanvas } from './canvas';`,
    resolveDir: fileURLToPath(new URL('../src', import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  define: { BLOCKWORK_DEBUG: 'false' },
  write: false,
  platform: 'node',
  format: 'esm',
});
const {
  preparePostDates,
  postDateField,
  editRestriction,
  removalRestriction,
  readTree,
  preparePlan,
  applyPlan,
  resetDocument,
  requireCanvas,
} = await import(
  'data:text/javascript;base64,' +
    Buffer.from(built.outputFiles[0].text + '\n//# sourceURL=blockwork-date-unit.mjs').toString(
      'base64',
    )
);
const date = (field = 'date', clientId = field) => ({
  name: 'core/post-date',
  clientId,
  attributes: {
    metadata: { bindings: { datetime: { source: 'core/post-data', args: { field } } } },
  },
  innerBlocks: [],
});
const block = (name, clientId, attributes = {}, innerBlocks = []) => ({
  name,
  clientId,
  attributes,
  innerBlocks,
});
const query = (children = [date()], attributes = {}) =>
  block(
    'core/query',
    'q',
    {
      query: { perPage: 2, inherit: false, postType: 'post', excludeCurrent: null, ...attributes },
    },
    [block('core/post-template', 't', {}, children)],
  );
const target = { post_type: 'page', post_id: 1 };

function fixture(tree = []) {
  const state = {
    tree,
    records: [
      { id: 2, type: 'post' },
      { id: 3, type: 'post' },
    ],
    entities: new Map(),
    supported: true,
    source: true,
    value: true,
    calls: [],
    mutations: 0,
    providers: {},
    id: 1,
    type: 'page',
  };

  for (const id of [1, 2, 3])
    state.entities.set(id, { date: '2024-01-02T03:04:05', modified: '2025-02-03T04:05:06' });
  const source = {
    getValues: ({ clientId, context, bindings }) => {
      state.calls.push({ clientId, context, bindings });

      return {
        datetime: state.value
          ? state.entities.get(context.postId)?.[bindings.datetime.args.field]
          : undefined,
      };
    },
  };
  let counter = 0;
  const schema = {
    metadata: { type: 'object' },
    datetime: { type: 'string' },
    className: { type: 'string' },
    format: { type: 'string' },
    query: { type: 'object' },
  };
  const store = {
    getBlocks: () => state.tree,
    getSettings: () => ({
      __experimentalBlockBindingsSupportedAttributes: {
        'core/post-date': state.supported ? ['datetime'] : [],
      },
    }),
    getBlockEditingMode: () => 'default',
    canEditBlock: () => true,
    canRemoveBlocks: () => true,
    canMoveBlock: () => true,
    canInsertBlockType: () => true,
    canInsertBlocks: () => true,
    getTemplateLock: () => false,
    getBlockListSettings: () => ({}),
  };
  const core = {
    getEditedEntityRecord: (_kind, _type, id) => state.entities.get(id),
    getEntityRecords: () => state.records,
  };
  const wp = {
    blocks: {
      getBlockType: (name) => ({
        attributes: schema,
        providesContext: state.providers[name] ?? (name === 'core/query' ? { query: 'query' } : {}),
      }),
      getBlockBindingsSource: () => (state.source ? source : undefined),
      createBlock: (name, attributes = {}, innerBlocks = []) =>
        block(name, 'created-' + ++counter, attributes, innerBlocks),
      serialize: (blocks) =>
        JSON.stringify(
          blocks.map(({ name, attributes, innerBlocks }) => ({
            name,
            attributes,
            innerBlocks: JSON.parse(wp.blocks.serialize(innerBlocks ?? [])),
          })),
        ),
      parse: (text) =>
        JSON.parse(text).map(function parse(b) {
          const result = block(
            b.name,
            'parsed-' + ++counter,
            b.attributes,
            b.innerBlocks.map(parse),
          );

          if (
            result.name === 'core/post-date' &&
            !result.attributes.datetime &&
            !result.attributes.metadata?.bindings
          ) {
            result.attributes = {
              ...result.attributes,
              metadata: {
                ...result.attributes.metadata,
                bindings: date().attributes.metadata.bindings,
              },
            };
          }

          return result;
        }),
      getBlockVariations: () => [
        {
          name: 'post-date-modified',
          attributes: state.nativeAttrs ?? {
            ...date('modified').attributes,
            className: 'wp-block-post-date__modified-date',
          },
        },
      ],
      createBlocksFromInnerBlocksTemplate: () => [],
    },
    data: {
      select: (name) =>
        name === 'core'
          ? core
          : name === 'core/editor'
            ? {
                getCurrentPost: () => ({ type: state.type }),
                getCurrentPostId: () => state.id,
                getCurrentPostType: () => state.type,
              }
            : name === 'core/blocks'
              ? {}
              : store,
      resolveSelect: () => ({
        getEditedEntityRecord: async (...args) => core.getEditedEntityRecord(...args),
        getEntityRecords: async (...args) => {
          state.queryArgs = args;

          return state.records;
        },
      }),
      dispatch: () => ({
        insertBlocks: () => {
          state.mutations++;
        },
      }),
    },
  };

  return {
    wp,
    state,
    plan: (requests) => preparePlan(wp, requests, wp.blocks.serialize(state.tree), target),
  };
}

for (const field of ['date', 'modified'])
  test('root dynamic ' + field + ' uses exact public value', async () => {
    const f = fixture();
    const guard = await preparePostDates(f.wp, [date(field)]);
    guard();
    assert.equal(f.state.calls.length, 2);
    assert.deepEqual(f.state.calls[0].context.postId, 1);
    assert.equal(f.state.calls[0].bindings.datetime.args.field, field);
  });

test('exact binding predicate rejects every extra binding member', () => {
  assert.equal(postDateField(date()), 'date');

  for (const mutate of [
    (b) => (b.attributes.metadata.bindings.other = {}),
    (b) => (b.attributes.metadata.bindings.datetime.extra = true),
    (b) => (b.attributes.metadata.bindings.datetime.args.extra = true),
    (b) => (b.attributes.metadata.bindings.datetime.args.field = 'title'),
    (b) => (b.name = 'core/paragraph'),
  ]) {
    const b = date();
    mutate(b);
    assert.equal(postDateField(b), undefined);
  }
});

test('creation normalizes native binding before planning', async () => {
  const f = fixture();
  const plan = await f.plan([
    { op: 'insert', parent: [], block: { name: 'core/post-date', attributes: {} } },
  ]);
  assert.equal(postDateField(plan.blocks[0]), 'date');
  assert.equal(postDateField(f.wp.blocks.parse(f.wp.blocks.serialize(plan.blocks))[0]), 'date');
});

test('literal datetime stays literal and supplied empty datetime refuses', async () => {
  const f = fixture();
  const plan = await f.plan([
    {
      op: 'insert',
      parent: [],
      block: { name: 'core/post-date', attributes: { datetime: '2024-01-02T03:04:05' } },
    },
  ]);
  assert.equal(plan.blocks[0].attributes.datetime, '2024-01-02T03:04:05');
  assert.equal(postDateField(plan.blocks[0]), undefined);
  await assert.rejects(
    f.plan([
      { op: 'insert', parent: [], block: { name: 'core/post-date', attributes: { datetime: '' } } },
    ]),
    (e) => e.code === 'unsupported_attribute',
  );
});

test('caller bindings refuse before native conversion', async () => {
  const f = fixture();
  await assert.rejects(
    f.plan([
      {
        op: 'insert',
        parent: [],
        block: { name: 'core/post-date', attributes: date().attributes },
      },
    ]),
    (e) => e.code === 'unsupported_attribute',
  );
});

test('native modified variation is accepted while caller binding override refuses', async () => {
  const f = fixture();
  const request = {
    op: 'insert_variation',
    parent: [],
    name: 'core/post-date',
    variation: 'post-date-modified',
    attributes: {},
  };
  assert.equal(postDateField((await f.plan([request])).blocks[0]), 'modified');
  await assert.rejects(
    f.plan([{ ...request, attributes: date().attributes }]),
    (e) => e.code === 'unsupported_attribute',
  );
});

test('existing bound style, move and remove remain usable and datetime is read only', async () => {
  const d = date();
  const f = fixture([d, block('core/paragraph', 'p')]);
  const rows = readTree(f.wp, f.state.tree);
  assert.equal(editRestriction(f.wp, rows[0], rows).reason, '');
  assert.equal(removalRestriction(f.wp, rows[0], rows).reason, '');

  for (const request of [
    { op: 'update', path: [0], name: d.name, attributes: { className: 'chosen' }, unset: [] },
    { op: 'move', path: [0], name: d.name, parent: [], index: 1 },
    { op: 'remove', path: [0], name: d.name },
  ])
    await f.plan([request]);

  for (const request of [
    { attributes: { datetime: '2026-01-01T00:00:00' }, unset: [] },
    { attributes: {}, unset: [['datetime']] },
    { attributes: { metadata: { bindings: {} } }, unset: [] },
  ])
    await assert.rejects(
      f.plan([{ op: 'update', path: [0], name: d.name, ...request }]),
      (e) => e.code === 'unsupported_attribute',
    );
});

test('Query checks every actual preview entity type and id', async () => {
  const f = fixture();
  f.state.records[1].type = 'book';
  await preparePostDates(f.wp, [query([date(), date('modified')])]);
  const contexts = f.state.calls.map((call) => [call.context.postType, call.context.postId]);
  assert.deepEqual(contexts, [
    ['post', 2],
    ['book', 3],
    ['post', 2],
    ['book', 3],
  ]);
});

test('second preview missing date refuses before any dispatch', async () => {
  const f = fixture();
  f.state.entities.get(3).date = null;
  await assert.rejects(
    preparePostDates(f.wp, [query()]),
    (e) =>
      e.code === 'post_date_context_unavailable' &&
      e.diagnostics.reason === 'backing_date_unavailable',
  );
  assert.equal(f.state.mutations, 0);
});

for (const change of [
  (f) => (f.state.supported = false),
  (f) => (f.state.source = false),
  (f) => f.state.entities.set(1, false),
  (f) => (f.state.entities.get(1).date = null),
  (f) => (f.state.value = false),
]) {
  test('guard rechecks support, source and actual backing entity before dispatch', async () => {
    const f = fixture();
    const guard = await preparePostDates(f.wp, [date()]);
    change(f);
    assert.throws(guard, (e) => e.code === 'post_date_context_unavailable');
  });
}

test('query membership changes invalidate the guard', async () => {
  const f = fixture();
  const guard = await preparePostDates(f.wp, [query()]);
  f.state.records = [{ id: 4, type: 'post' }];
  assert.throws(guard, (e) => e.diagnostics.reason === 'query_preview_changed');
});

test('empty and nested preview contexts refuse only affected dates', async () => {
  const f = fixture();
  f.state.records = [];
  await assert.rejects(preparePostDates(f.wp, [query()]), (e) => e.code === 'query_preview_empty');
  await preparePostDates(f.wp, [query(), block('core/paragraph', 'p')], new Set(['p']));
  f.state.records = [{ id: 2, type: 'post' }];
  await assert.rejects(
    preparePostDates(f.wp, [query([query()])]),
    (e) => e.diagnostics.reason === 'nested_post_template',
  );
});

test('unknown providers and template-editor root refuse with a concrete repair', async () => {
  const f = fixture();
  f.state.providers['example/provider'] = { postId: 'postId' };
  await assert.rejects(
    preparePostDates(f.wp, [block('example/provider', 'x', { postId: 3 }, [date()])]),
    (e) =>
      e.diagnostics.reason === 'unknown_context_provider' &&
      /explicit/.test(e.diagnostics.next_step),
  );
  f.state.type = 'wp_template';
  await assert.rejects(
    preparePostDates(f.wp, [date()]),
    (e) => e.diagnostics.reason === 'current_post_context_unavailable',
  );
});

test('ordinary wrappers inherit current-post context', async () => {
  const f = fixture();
  await preparePostDates(f.wp, [
    block('core/group', 'g', {}, [
      block('core/columns', 'cs', {}, [block('core/column', 'c', {}, [date()])]),
    ]),
  ]);
  assert.equal(f.state.calls[0].context.postId, 1);
});

test('invalid intermediate later corrected refuses before first mutation', async () => {
  globalThis.document = { visibilityState: 'visible' };
  const f = fixture();
  const good = [date()];
  const bad = [query()];
  f.state.entities.get(3).date = null;
  const request = { op: 'insert', parent: [], block: { name: 'core/post-date' } };
  await assert.rejects(
    applyPlan(
      f.wp,
      {
        steps: [
          { edit: request, blocks: good, before: [], after: bad },
          { edit: request, blocks: [], before: bad, after: good },
        ],
        blocks: good,
        target,
      },
      () => {},
    ),
    (e) => e.code === 'post_date_context_unavailable',
  );
  assert.equal(f.state.mutations, 0);
});

test('moving dates into and out of existing templates uses destination entities', async () => {
  const f = fixture();
  await preparePostDates(
    f.wp,
    [date(), query([block('core/post-title', 'title')])],
    new Set(['date']),
  );
  assert.deepEqual(
    f.state.calls.map((call) => call.context.postId),
    [1],
  );
  f.state.calls = [];
  await preparePostDates(f.wp, [query([block('core/group', 'g', {}, [date()])])], new Set(['g']));
  assert.deepEqual(
    f.state.calls.map((call) => call.context.postId),
    [2, 3],
  );
  f.state.calls = [];
  await preparePostDates(
    f.wp,
    [block('core/group', 'g', {}, [date()]), query([block('core/post-title', 'title')])],
    new Set(['g']),
  );
  assert.deepEqual(
    f.state.calls.map((call) => call.context.postId),
    [1],
  );
});

test('new and existing explicit template Date insertions check all previews', async () => {
  const f = fixture();

  for (const affected of [new Set(['q']), new Set(['date'])]) {
    f.state.calls = [];
    await preparePostDates(f.wp, [query()], affected);
    assert.deepEqual(
      f.state.calls.map((call) => call.context.postId),
      [2, 3],
    );
  }
});

test('automatic empty Post Template refuses before dispatch with working next step', async () => {
  const f = fixture();
  const q = query([]);
  const edit = { op: 'insert', parent: [], block: { name: 'core/query' } };
  await assert.rejects(
    applyPlan(
      f.wp,
      { steps: [{ edit, blocks: [q], before: [], after: [q] }], blocks: [q], target },
      () => {},
    ),
    (e) =>
      e.code === 'post_date_context_unavailable' &&
      e.diagnostics.reason === 'automatic_post_template_children_unproven' &&
      /explicit/.test(e.diagnostics.next_step),
  );
  assert.equal(f.state.mutations, 0);
});

test('an unrelated Query does not participate in a plain page edit', async () => {
  const f = fixture([query(), block('core/paragraph', 'p')]);
  f.state.records = [];
  await f.plan([
    {
      op: 'update',
      path: [1],
      name: 'core/paragraph',
      attributes: { className: 'changed' },
      unset: [],
    },
  ]);
  assert.deepEqual(f.state.calls, []);
});

test('native inherited template and preview post-type precedence survives extra args', async () => {
  const f = fixture();
  f.state.providers['core/query'] = {
    query: 'query',
    templateSlug: 'templateSlug',
    previewPostType: 'previewPostType',
  };
  const q = query([date()], {
    inherit: true,
    per_page: 9,
    postType: 'post',
    excludeCurrent: true,
    exclude: [42],
  });
  q.attributes.templateSlug = 'archive-book';
  q.attributes.previewPostType = 'story';
  await preparePostDates(f.wp, [q]);
  assert.equal(f.state.queryArgs[1], 'story');
  assert.equal(f.state.queryArgs[2].postType, 'book');
  assert.equal(f.state.queryArgs[2].per_page, 9);
  assert.deepEqual(f.state.queryArgs[2].exclude, [42, 1]);
  assert.deepEqual(
    f.state.calls.map((call) => call.context.postId),
    [2, 3],
  );
});

test('reset refuses unsafe date before the mutation callback', async () => {
  const f = fixture();
  let mutations = 0;
  f.state.entities.get(1).date = null;
  await assert.rejects(
    resetDocument(
      f.wp,
      [date()],
      () => undefined,
      () => mutations++,
    ),
    (e) => e.code === 'post_date_context_unavailable',
  );
  assert.equal(mutations, 0);
});

test('native modified variation retains its binding when caller labels it', async () => {
  const f = fixture();
  const request = {
    op: 'insert_variation',
    parent: [],
    name: 'core/post-date',
    variation: 'post-date-modified',
    attributes: { metadata: { name: 'Updated date' } },
  };
  const plan = await f.plan([request]);
  assert.equal(postDateField(plan.blocks[0]), 'modified');
  assert.equal(plan.blocks[0].attributes.metadata.name, 'Updated date');
  await assert.rejects(
    f.plan([{ ...request, attributes: { datetime: '' } }]),
    (e) =>
      e.code === 'unsupported_attribute' && e.diagnostics.constraint === 'bound_datetime_read_only',
  );
});

test('native variation binding cannot be hidden by caller metadata', async () => {
  const f = fixture();
  f.state.nativeAttrs = {
    metadata: {
      bindings: { datetime: { source: 'example/unsupported', args: { field: 'date' } } },
    },
  };
  await assert.rejects(
    f.plan([
      {
        op: 'insert_variation',
        parent: [],
        name: 'core/post-date',
        variation: 'post-date-modified',
        attributes: { metadata: { name: 'Requested label' } },
      },
    ]),
    (e) => e.code === 'unsupported_attribute',
  );
});

test('reset ownership is rechecked after asynchronous date readiness', async () => {
  const f = fixture([block('core/paragraph', 'owned')]);
  const expected = f.wp.blocks.serialize(f.state.tree);
  let mutations = 0;
  f.wp.data.resolveSelect = () => ({
    getEditedEntityRecord: async () => {
      f.state.tree = [block('core/paragraph', 'human', { className: 'Human pending work' })];

      return f.state.entities.get(1);
    },
  });
  const checkOwnership = () =>
    assert.equal(f.wp.blocks.serialize(f.state.tree), expected, 'Intervening typing');
  await assert.rejects(
    resetDocument(f.wp, [date()], checkOwnership, () => mutations++),
    /Intervening typing/,
  );
  assert.equal(mutations, 0);
  assert.equal(f.state.tree[0].clientId, 'human');
});

for (const op of ['insert', 'remove'])
  test('a sibling ' + op + ' before an unsupported Query needs no Date context', async () => {
    globalThis.window ??= {};
    const q = query();
    q.attributes.query.inherit = false;
    const p = block('core/paragraph', 'p');
    const original = op === 'insert' ? [q] : [p, q];
    const after = op === 'insert' ? [p, q] : [q];
    const f = fixture(original);
    f.state.records = [];
    const request =
      op === 'insert'
        ? { op, parent: [], index: 0, block: { name: 'core/paragraph' } }
        : { op, path: [0], name: 'core/paragraph' };
    let dispatched = 0;
    f.wp.data.dispatch = () => ({
      insertBlocks: () => {
        dispatched++;
        f.state.tree = after;
      },
      removeBlocks: () => {
        dispatched++;
        f.state.tree = after;
      },
    });
    await applyPlan(
      f.wp,
      {
        steps: [{ edit: request, blocks: op === 'insert' ? [p] : [], before: original, after }],
        blocks: after,
        target,
      },
      () => {},
    );
    assert.equal(dispatched, 1);
    assert.deepEqual(f.state.calls, []);
  });

test('updating an existing Query with an empty template refuses before dispatch', async () => {
  const original = query([]);
  const updated = structuredClone(original);
  updated.attributes.query.search = 'changed';
  const f = fixture([original]);
  await assert.rejects(
    applyPlan(
      f.wp,
      {
        steps: [
          {
            edit: {
              op: 'update',
              path: [0],
              name: 'core/query',
              attributes: { query: { search: 'changed' } },
              unset: [],
            },
            blocks: [],
            update: { query: updated.attributes.query },
            before: [original],
            after: [updated],
          },
        ],
        blocks: [updated],
        target,
      },
      () => {},
    ),
    (e) => e.diagnostics.reason === 'automatic_post_template_children_unproven',
  );
  assert.equal(f.state.mutations, 0);
});

test('a whole-canvas remount checks unrelated Query dates while mounted reads stay scoped', async () => {
  const f = fixture([block('core/paragraph', 'p'), query()]);
  f.state.entities.get(3).date = null;
  let mounted = false;
  let assignments = 0;
  const body = {
    get childElementCount() {
      return mounted ? 1 : 0;
    },
  };
  const frame = {
    isConnected: true,
    src: 'blob:https://example.test/fixture',
    contentDocument: {
      URL: 'about:blank',
      readyState: 'complete',
      body,
      getElementById: () => (mounted ? {} : null),
    },
    get srcdoc() {
      return mounted ? 'mounted' : '';
    },
    set srcdoc(_value) {
      assignments++;
      mounted = true;
    },
  };
  const old = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    fetch: globalThis.fetch,
  };
  globalThis.window = { wp: f.wp };
  globalThis.document = { visibilityState: 'visible', querySelector: () => frame };
  globalThis.location = { href: 'https://example.test/editor', origin: 'https://example.test' };
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html>Native canvas</html>' });

  try {
    await assert.rejects(
      requireCanvas(['p']),
      (e) => e.diagnostics.reason === 'backing_date_unavailable',
    );
    assert.equal(assignments, 0);
    mounted = true;
    await requireCanvas(['p']);
    assert.equal(assignments, 0);
  } finally {
    Object.assign(globalThis, old);
  }
});

test('whole-canvas recovery refuses an empty existing template before srcdoc', async () => {
  const f = fixture([query([])]);
  let assignments = 0;
  const frame = {
    isConnected: true,
    src: 'blob:https://example.test/fixture',
    contentDocument: { URL: 'about:blank', readyState: 'complete', body: { childElementCount: 0 } },
    get srcdoc() {
      return '';
    },
    set srcdoc(_value) {
      assignments++;
    },
  };
  const old = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    fetch: globalThis.fetch,
  };
  globalThis.window = { wp: f.wp };
  globalThis.document = { visibilityState: 'visible', querySelector: () => frame };
  globalThis.location = { href: 'https://example.test/editor', origin: 'https://example.test' };
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html>Native canvas</html>' });

  try {
    await assert.rejects(
      requireCanvas(['p']),
      (e) => e.diagnostics.reason === 'automatic_post_template_children_unproven',
    );
    assert.equal(assignments, 0);
  } finally {
    Object.assign(globalThis, old);
  }
});

for (const op of ['remove', 'move'])
  test(op + ' of the last template child refuses before automatic Date population', async () => {
    const original = query();
    const after = [query([])];
    const request = { op, path: [0, 0, 0], name: 'core/post-date' };

    if (op === 'move') {
      request.parent = [];
      request.index = 1;
      after.push(date());
    }

    const f = fixture([original]);
    await assert.rejects(
      applyPlan(
        f.wp,
        {
          steps: [{ edit: request, blocks: [], before: [original], after }],
          blocks: after,
          target,
        },
        () => {
          f.state.mutations++;
        },
      ),
      (error) =>
        error.code === 'post_date_context_unavailable' &&
        error.diagnostics.reason === 'automatic_post_template_children_unproven',
    );
    assert.equal(f.state.mutations, 0);
    assert.deepEqual(f.state.tree, [original]);
  });
