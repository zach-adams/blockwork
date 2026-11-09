import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const result = await build({
  stdin: {
    contents:
      "export { emptyComments, prepareEmptyComments, checkEmptyComments } from './comments'; export { withoutTemplates, checkInitialized } from './edits';",
    resolveDir: fileURLToPath(new URL('../src', import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  define: { BLOCKWORK_DEBUG: 'false' },
  write: false,
  platform: 'node',
  format: 'esm',
});
const { emptyComments, prepareEmptyComments, checkEmptyComments, withoutTemplates, checkInitialized } = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
);
const target = { post_type: 'page', post_id: 1 };

function fixture() {
  const child = {
    name: 'core/comment-content',
    clientId: 'child',
    attributes: {},
    innerBlocks: [],
  };
  const template = {
    name: 'core/comment-template',
    clientId: 'template',
    attributes: {},
    innerBlocks: [child],
  };
  const pattern = {
    name: 'core/comments',
    title: 'Comments',
    content: 'native recipe',
    categories: ['text'],
    blocks: [
      {
        name: 'core/comments',
        clientId: 'root',
        attributes: {
          metadata: { name: 'Comments', patternName: 'core/comments', categories: ['text'] },
        },
        innerBlocks: [template],
      },
    ],
  };
  const state = {
    offered: [pattern],
    records: [],
    total: 0,
    finished: true,
    allowed: true,
    lock: false,
    id: 1,
    type: 'page',
    settings: {
      __experimentalDiscussionSettings: {
        pageComments: true,
        commentsPerPage: 20,
        defaultCommentsPage: 'newest',
      },
    },
  };
  const store = {
    __experimentalGetAllowedPatterns: (...args) => {
      assert.deepEqual(args, []);

      return state.offered;
    },
    canInsertBlockType: () => state.allowed,
    getTemplateLock: () => state.lock,
    getSettings: () => state.settings,
  };
  const core = {
    getEntityRecords: () => state.records,
    getEntityRecordsTotalItems: () => state.total,
    hasFinishedResolution: () => state.finished,
  };
  const wp = {
    blocks: { getBlockType: () => ({}), serialize: JSON.stringify },
    data: {
      select: (name) =>
        name === 'core/editor'
          ? { getCurrentPostId: () => state.id, getCurrentPostType: () => state.type }
          : name === 'core'
            ? core
            : store,
      resolveSelect: () => ({
        getEntityRecords: async (...args) => {
          state.args = args;

          return state.records;
        },
      }),
    },
  };

  return {
    wp,
    state,
    pattern,
    template,
    child,
    run: () => emptyComments(wp, target, pattern.name),
  };
}

test('resolved empty native embed query retains offered metadata and caps page size', async () => {
  const f = fixture();
  f.state.settings.__experimentalDiscussionSettings.commentsPerPage = 300;
  const { proof, blocks } = await f.run();
  assert.deepEqual(f.state.args, [
    'root',
    'comment',
    {
      status: 'approve',
      order: 'asc',
      context: 'embed',
      parent: 0,
      _embed: 'children',
      post: 1,
      per_page: 100,
      page: 1,
    },
  ]);
  assert.deepEqual(blocks[0].attributes.metadata, f.pattern.blocks[0].attributes.metadata);
  checkEmptyComments(f.wp, target, proof);
});
test('root denial, descendant denial through offered list, locks, synced recipes and unknown context refuse', async () => {
  for (const change of [
    (f) => (f.state.allowed = false),
    (f) => (f.state.offered = []),
    (f) => (f.state.lock = 'all'),
    (f) => (f.pattern.syncStatus = 'synced'),
    (f) => (f.state.id = 2),
    (f) => (f.state.type = 'wp_template'),
    (f) => (f.state.settings.__experimentalDiscussionSettings.commentsPerPage = 'bad'),
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(f.run, { code: 'unsupported_pattern' });
  }
});
test('nonempty, unknown totals, unfinished resolution and context providers refuse', async () => {
  for (const change of [
    (f) => (f.state.records = [{ id: 4 }]),
    (f) => (f.state.total = undefined),
    (f) => (f.state.finished = false),
    (f) => (f.wp.blocks.getBlockType = () => ({ providesContext: { postId: 'ref' } })),
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(f.run, { code: 'unsupported_pattern' });
  }
});
test('recipe, settings and query evidence are rechecked', async () => {
  for (const change of [
    (f) => (f.pattern.blocks[0].attributes.metadata.name = 'changed'),
    (f) => (f.pattern.content = 'changed'),
    (f) => (f.state.records = [{}]),
    (f) => (f.state.settings.__experimentalDiscussionSettings.commentsPerPage = 7),
  ]) {
    const f = fixture();
    const { proof } = await f.run();
    change(f);
    assert.throws(() => checkEmptyComments(f.wp, target, proof), { code: 'unsupported_pattern' });
  }
});
test('populated and ineligible patterns use ordinary insertion', async () => {
  const f = fixture();
  f.state.records = [{ id: 4 }];
  assert.equal(await prepareEmptyComments(f.wp, target, f.pattern.name, true), undefined);
  assert.equal(await prepareEmptyComments(f.wp, target, f.pattern.name, false), undefined);
});
test('admission is checked before insertion but not after its own context changes', async () => {
  const f = fixture();
  const { proof } = await f.run();
  f.state.allowed = false;
  f.state.offered = [];
  assert.throws(() => checkEmptyComments(f.wp, target, proof, true), { code: 'unsupported_pattern' });
  checkEmptyComments(f.wp, target, proof);
  f.pattern.blocks[0].attributes.metadata.name = 'changed';
  assert.throws(() => checkEmptyComments(f.wp, target, proof), { code: 'unsupported_pattern' });
});
test('covered hidden descendants cannot adopt unexpected template children', () => {
  const f = fixture();
  const actual = structuredClone(f.pattern.blocks);
  actual[0].innerBlocks[0].innerBlocks[0].innerBlocks.push({ ...f.child, clientId: 'foreign' });
  const pruned = withoutTemplates(f.wp, f.pattern.blocks, actual, new Set(['child']));
  assert.equal(pruned[0].innerBlocks[0].innerBlocks[0].innerBlocks[0].clientId, 'foreign');
});

test('covered hidden descendants reject foreign attributes and additional children', () => {
  for (const change of [
    (b) => (b.attributes.foreign = true),
    (b) => b.innerBlocks.push({ ...structuredClone(b), clientId: 'foreign' }),
  ]) {
    const f = fixture();
    const actual = structuredClone(f.pattern.blocks);
    change(actual[0].innerBlocks[0].innerBlocks[0]);
    assert.throws(
      () => checkInitialized(f.wp, f.pattern.blocks, actual, new Set(['child'])),
      (error) => ['prepared_content_changed', 'native_structure_changed'].includes(error.code),
    );
  }
});

test('native string discussion settings use native truthiness and numeric page-size coercion', async () => {
  for (const pageComments of ['1', '0', '']) {
    const f = fixture();
    f.state.settings.__experimentalDiscussionSettings = { pageComments, commentsPerPage: '50', defaultCommentsPage: 'newest' };
    await f.run();
    assert.equal(f.state.args[2].per_page, pageComments ? 50 : 100);
  }
});

test('an offered Group-wrapped Comments recipe uses its actual root insertion policy', async () => {
  const f = fixture();
  f.pattern.blocks = [{ name: 'core/group', clientId: 'wrapper', attributes: {}, innerBlocks: f.pattern.blocks }];
  const store = f.wp.data.select('core/block-editor');
  store.canInsertBlockType = name => name === 'core/group';
  const prepared = await f.run();
  assert.equal(prepared.blocks[0].name, 'core/group');
});
