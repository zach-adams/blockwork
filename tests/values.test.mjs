import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/values.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { stored } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

test('persistence preserves explicit array and union shapes while accepting PHP object forms', () => {
  for (const type of ['array', ['object', 'array']]) {
    assert.notDeepEqual(stored({}, { type }), stored([], { type }));
    assert.notDeepEqual(stored({ 0: 'x' }, { type }), stored(['x'], { type }));
  }

  assert.deepEqual(stored({}, { type: 'object' }), stored([], { type: 'object' }));
  assert.deepEqual(stored({ 0: 'x' }, { type: 'object' }), stored(['x'], { type: 'object' }));
  assert.deepEqual(
    stored({ spacing: {} }, { type: 'object' }),
    stored({ spacing: [] }, { type: 'object' }),
  );
  const schema = { type: 'object', properties: { setting: { type: ['object', 'array'] } } };
  assert.notDeepEqual(stored({ setting: {} }, schema), stored({ setting: [] }, schema));
});
