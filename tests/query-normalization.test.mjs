import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const result = await build({
  stdin: {
    contents: "export { prepareQueryNormalization } from './query';",
    resolveDir: fileURLToPath(new URL('../src', import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  define: { BLOCKWORK_DEBUG: 'false' },
  write: false,
  platform: 'node',
  format: 'esm',
});
const { prepareQueryNormalization } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

const query = (value, id = 'q') => ({
  name: 'core/query',
  clientId: id,
  attributes: { query: value },
});

function fixture({
  canRead = true,
  record = { posts_per_page: 10 },
  edited = {},
  setting = 8,
  post = { type: 'page' },
  providers = {},
} = {}) {
  const site = {
    canUser: () => canRead,
    getEntityRecord: () => record,
    getEntityRecordEdits: () => edited,
  };
  const wp = {
    blocks: { getBlockType: (name) => ({ providesContext: providers[name] }) },
    data: {
      select: (name) =>
        name === 'core'
          ? site
          : name === 'core/editor'
            ? { getCurrentPost: () => post }
            : { getSettings: () => ({ postsPerPage: setting }) },
      resolveSelect: () => ({ canUser: async () => canRead, getEntityRecord: async () => record }),
    },
  };

  return { wp, site, post };
}

async function check(value, options = {}, existing = true) {
  const { wp } = fixture(options);
  const after = [query(value)];

  return prepareQueryNormalization(
    wp,
    existing ? after : [],
    after,
    after,
    new Set(existing ? ['q'] : []),
    2,
  );
}

const invalid = [
  ['inherited mismatch', { inherit: true, perPage: 7, excludeCurrent: null }, {}],
  ['independent zero', { inherit: false, perPage: 0, excludeCurrent: null }, {}],
  [
    'unsupported false',
    { inherit: false, postType: 'post', perPage: 2, excludeCurrent: false },
    {},
  ],
  ['unsupported true', { inherit: false, postType: 'post', perPage: 2, excludeCurrent: true }, {}],
  [
    'readable missing uses three',
    { inherit: true, perPage: 8, excludeCurrent: null },
    { record: {} },
  ],
  [
    'edited value wins',
    { inherit: true, perPage: 10, excludeCurrent: null },
    { edited: { posts_per_page: 4 } },
  ],
];

for (const [name, value, options] of invalid)
  test(name, async () => {
    await assert.rejects(
      check(value, options),
      (e) =>
        e.code === 'native_requested_value_changed' &&
        e.diagnostics.edit_index === 2 &&
        e.diagnostics.target_path[0] === 0 &&
        e.diagnostics.properties.length > 0,
    );
  });
const valid = [
  ['inherited matching', { inherit: true, perPage: 10, excludeCurrent: null }, {}],
  [
    'independent truthy',
    { inherit: false, perPage: 19, excludeCurrent: null },
    { canRead: undefined },
  ],
  ['eligible false', { inherit: false, postType: 'page', perPage: 2, excludeCurrent: false }, {}],
  ['eligible true', { inherit: false, postType: 'page', perPage: 2, excludeCurrent: true }, {}],
  [
    'null skips context',
    { inherit: false, perPage: 2, excludeCurrent: null },
    { post: { type: 'wp_template' } },
  ],
  ['new absent fields', { inherit: true }, {}, false],
  ['readable missing', { inherit: true, perPage: 3, excludeCurrent: null }, { record: {} }],
  ['unreadable fallback', { inherit: true, perPage: 8, excludeCurrent: null }, { canRead: false }],
  [
    'edited fallback',
    { inherit: true, perPage: 4, excludeCurrent: null },
    { edited: { posts_per_page: 4 } },
  ],
  [
    'zero falls through',
    { inherit: true, perPage: 10, excludeCurrent: null },
    { edited: { posts_per_page: 0 } },
  ],
  [
    'template prefix',
    { inherit: false, postType: 'page', perPage: 2, excludeCurrent: true },
    { post: { type: 'wp_template', slug: 'page-about' } },
  ],
  [
    'wp custom',
    { inherit: false, postType: 'custom', perPage: 2, excludeCurrent: false },
    { post: { type: 'wp_template', slug: 'wp' } },
  ],
];

for (const [name, value, options, existing = true] of valid)
  test(name, async () => {
    const guard = await check(value, options, existing);
    guard();
  });
test('unknown relevant context refuses', async () =>
  assert.rejects(
    check(
      { inherit: false, postType: 'post', perPage: 2, excludeCurrent: false },
      { post: { type: 'wp_template', slug: 'single' } },
    ),
    (e) => e.code === 'query_preview_context_unavailable',
  ));
test('unrelated Query is not checked', async () => {
  const { wp } = fixture();
  const bad = query({ inherit: true, perPage: 7 });
  await prepareQueryNormalization(
    wp,
    [bad],
    [bad, { name: 'core/paragraph', clientId: 'p', attributes: {} }],
    [],
    new Set(['q']),
    0,
  );
});
test('invalid intermediate refuses before simulated dispatch', async () => {
  const { wp } = fixture();
  let dispatched = 0;
  const states = [
    [query({ inherit: true, perPage: 7, excludeCurrent: null })],
    [query({ inherit: true, perPage: 10, excludeCurrent: null })],
  ];
  await assert.rejects(
    (async () => {
      for (const [i, state] of states.entries())
        await prepareQueryNormalization(wp, i ? states[i - 1] : [], state, state, new Set(), i);
      dispatched++;
    })(),
  );
  assert.equal(dispatched, 0);
});
test('dependency guard rechecks edited setting', async () => {
  const { wp, site } = fixture();
  const blocks = [query({ inherit: true, perPage: 10, excludeCurrent: null })];
  const guard = await prepareQueryNormalization(wp, blocks, blocks, blocks, new Set(['q']), 0);
  site.getEntityRecordEdits = () => ({ posts_per_page: 5 });
  assert.throws(guard, (e) => e.code === 'native_requested_value_changed');
});
test('inherited context change affects descendant', async () => {
  const { wp } = fixture({ providers: { 'fixture/provider': { postType: 'type' } } });
  const child = query({ inherit: false, postType: 'post', perPage: 2, excludeCurrent: true });
  const before = [
    {
      name: 'fixture/provider',
      clientId: 'provider',
      attributes: { type: 'post' },
      innerBlocks: [child],
    },
  ];
  const after = structuredClone(before);
  after[0].attributes.type = 'page';
  await assert.rejects(
    prepareQueryNormalization(wp, before, after, [], new Set(['q', 'provider']), 1),
    (e) => e.diagnostics.properties.includes('query.excludeCurrent'),
  );
});
