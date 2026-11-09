import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const built = await build({
  stdin: {
    contents: "export {nativeMarginInput} from './styling';",
    resolveDir: fileURLToPath(new URL('../src', import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  define: { BLOCKWORK_DEBUG: 'false' },
});
const { nativeMarginInput } = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
);
const wp = (support) => ({
  blocks: { getBlockType: () => ({ supports: { spacing: { margin: support } } }) },
});
test('numeric zero remains an explicit native CSS margin', () => {
  const input = {
    spacing: { margin: { top: 0, bottom: '0', left: '2px' }, padding: { top: 0 } },
    color: { text: 0 },
  };
  assert.deepEqual(nativeMarginInput(wp(true), 'core/paragraph', input, ['style']), {
    spacing: { margin: { top: '0', bottom: '0', left: '2px' }, padding: { top: 0 } },
    color: { text: 0 },
  });
  assert.equal(input.spacing.margin.top, 0);
});
test('only native supported margin edges are normalized', () => {
  for (const support of [undefined, false])
    assert.equal(
      nativeMarginInput(wp(support), 'fixture/custom', 0, ['style', 'spacing', 'margin', 'top']),
      0,
    );
  assert.equal(
    nativeMarginInput(wp(['top', 'bottom']), 'core/paragraph', 0, [
      'style',
      'spacing',
      'margin',
      'left',
    ]),
    0,
  );
  assert.equal(
    nativeMarginInput(wp(['top']), 'core/paragraph', 0, ['style', 'spacing', 'margin', 'top']),
    '0',
  );
});
test('unrelated patches and nonzero values remain exact', () => {
  for (const [path, value] of [
    [['style', 'color', 'text'], 0],
    [['style', 'spacing', 'padding', 'top'], 0],
    [['style', 'spacing', 'margin', 'top'], 3],
    [['style', 'spacing', 'margin', 'top'], '0px'],
  ])
    assert.equal(nativeMarginInput(wp(true), 'core/paragraph', value, path), value);
  const patch = { color: { text: '#123' } };
  assert.deepEqual(nativeMarginInput(wp(true), 'core/paragraph', patch, ['style']), patch);
});
