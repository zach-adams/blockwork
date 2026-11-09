import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const result = await build({
  stdin: {
    contents: "export { route } from './native';",
    resolveDir: fileURLToPath(new URL('../src', import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  define: { BLOCKWORK_DEBUG: 'false' },
  write: false,
  platform: 'node',
  format: 'esm',
});
const { route } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

for (const [namespace, base] of [
  ['wp/v2', 'posts'],
  ['library.v1', 'books.release'],
  ['library.v1', 'catalog/books.release'],
]) {
  test(`route accepts ${namespace}/${base}`, () => {
    assert.equal(route({ rest_namespace: namespace, rest_base: base }), `/${namespace}/${base}`);
  });
}

for (const part of [
  '',
  '.',
  '..',
  './books',
  '../books',
  'books/.',
  'books/..',
  'books/../items',
  '/books',
  'books/',
  'books//items',
  'books?context=edit',
  'books#section',
  'books%2Fitems',
  'https://example.test/books',
]) {
  for (const field of ['rest_namespace', 'rest_base']) {
    test(`route refuses ${field} ${JSON.stringify(part)}`, () => {
      assert.throws(
        () => route({ rest_namespace: 'wp/v2', rest_base: 'posts', [field]: part }),
        (error) => error.code === 'unsupported_rest_route',
      );
    });
  }
}
