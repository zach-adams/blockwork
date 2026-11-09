import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const result = await build({
  stdin: {
    contents: "export { normalizePatternSpacers, spacerSettings } from './styling';",
    resolveDir: fileURLToPath(new URL('../src', import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  define: { BLOCKWORK_DEBUG: 'false' },
  write: false,
  platform: 'node',
  format: 'esm',
});
const { normalizePatternSpacers, spacerSettings } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

function fixture(height = 'var:preset|spacing|30') {
  const features = {
    spacing: {
      spacingSizes: {
        custom: [{ slug: '30', size: '20px' }],
        theme: [{ slug: '30', size: '40px' }],
        default: [{ slug: '30', size: '60px' }],
      },
    },
  };
  const wp = {
    hooks: { filters: {} },
    blocks: { getBlockType: () => ({ supports: { layout: true, __experimentalSettings: true } }) },
    data: { select: () => ({ getSettings: () => ({ __experimentalFeatures: features }) }) },
    blockEditor: {
      getCustomValueFromPreset: (value, sizes) => {
        const match = value.match(/^var:preset\|spacing\|(.+)$/);

        return match ? sizes.find((size) => String(size.slug) === match[1])?.size : value;
      },
    },
  };
  const inputs = [
    {
      name: 'core/group',
      attributes: { layout: { type: 'flex', orientation: 'vertical' } },
      inner_blocks: [
        { name: 'core/spacer', attributes: { height, style: { color: { text: '#123' } } } },
      ],
    },
  ];
  const raw = [
    {
      blockName: 'core/group',
      attrs: {},
      innerBlocks: [{ blockName: 'core/spacer', attrs: { height }, innerBlocks: [] }],
    },
  ];
  const run = () => normalizePatternSpacers(wp, inputs, [], raw);

  return { wp, inputs, raw, features, run };
}

test('native catalogue order, literal heights, and changed presets are used', () => {
  for (const [height, size] of [
    ['var:preset|spacing|30', '20px'],
    ['37px', '37px'],
  ]) {
    const f = fixture(height);
    assert.equal(f.run()[0].resolvedSize, size);
    assert.deepEqual(f.inputs[0].inner_blocks[0].attributes, {
      height: '0px',
      style: { color: { text: '#123' }, layout: { flexSize: size, selfStretch: 'fixed' } },
    });
  }

  const f = fixture();
  f.features.spacing.spacingSizes.custom[0].size = '43px';
  assert.equal(f.run()[0].resolvedSize, '43px');
});

test('each setting uses block nullish precedence and defaults respect the flag', () => {
  const f = fixture();
  f.features.blocks = { 'core/spacer': { spacing: { spacingSizes: { custom: [] } } } };
  assert.equal(f.run()[0].resolvedSize, '40px');
  const g = fixture();
  g.features.spacing.spacingSizes.custom = [];
  g.features.spacing.spacingSizes.theme = [];
  g.features.spacing.defaultSpacingSizes = false;
  assert.throws(g.run, { code: 'unsupported_pattern' });
});

test('unresolved, reserved, implicit and uncertain dimensions refuse conversion', () => {
  for (const height of [
    'var:preset|spacing|missing',
    'var:preset|spacing|0',
    'var:preset|spacing|default',
    '-1px',
    '2rem',
    'calc(20px + 1px)',
  ]) {
    assert.throws(fixture(height).run, { code: 'unsupported_pattern' });
  }

  const f = fixture();
  delete f.raw[0].innerBlocks[0].attrs.height;
  assert.throws(f.run, { code: 'unsupported_pattern' });
});

test('filter and participating settings overrides refuse, support alone permits', () => {
  const empty = fixture();
  empty.wp.hooks.filters['blockEditor.useSetting.before'] = { handlers: [] };
  assert.doesNotThrow(empty.run);
  const f = fixture();
  f.wp.hooks.filters['blockEditor.useSetting.before'] = { handlers: [{ namespace: 'fixture' }] };
  assert.throws(f.run, { code: 'unsupported_pattern' });
  const all = fixture();
  all.wp.hooks.filters.all = { handlers: [{ namespace: 'fixture' }] };
  assert.throws(all.run, { code: 'unsupported_pattern' });
  const g = fixture();
  const ancestor = { name: 'core/group', attributes: {} };
  assert.doesNotThrow(() => spacerSettings(g.wp, [ancestor]));
  ancestor.attributes.settings = { spacing: { defaultSpacingSizes: false } };
  assert.throws(() => spacerSettings(g.wp, [ancestor]), { code: 'unsupported_pattern' });
});

test('other layouts and previously sized Spacers stay unchanged', () => {
  for (const change of [
    (f) => {
      f.inputs[0].attributes.layout.orientation = 'horizontal';
    },
    (f) => {
      f.inputs[0].inner_blocks[0].attributes.style.layout = { flexSize: '20px' };
    },
    (f) => {
      f.inputs[0].inner_blocks[0].attributes.style.layout = { selfStretch: 'fill' };
    },
  ]) {
    const f = fixture();
    change(f);
    const before = structuredClone(f.inputs);
    assert.deepEqual(f.run(), []);
    assert.deepEqual(f.inputs, before);
  }
});
