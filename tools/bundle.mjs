import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// All bundles include Valibot, whose MIT license must travel with copies of it.
const valibotLicense = await readFile(
  new URL('../node_modules/valibot/LICENSE.md', import.meta.url),
  'utf8',
);

function source(path) {
  return fileURLToPath(new URL(`../src/${path}`, import.meta.url));
}

// Development bundles add the underlying error to each failure as `debug`.
// Release bundles compile it out; only tools/package.mjs builds them.
export async function bundles({ debug }) {
  const options = {
    bundle: true,
    write: false,
    target: 'es2022',
    legalComments: 'inline',
    banner: { js: `/*! Includes Valibot, https://valibot.dev\n\n${valibotLicense.trim()}\n*/` },
    define: { BLOCKWORK_DEBUG: JSON.stringify(debug) },
  };
  const [engine, invoker, bootstrap] = await Promise.all([
    build({
      ...options,
      entryPoints: [source('index.ts')],
      format: 'iife',
      globalName: 'blockwork_module',
      platform: 'browser',
    }),
    build({
      ...options,
      entryPoints: [source('invocation.ts')],
      format: 'esm',
      platform: 'neutral',
    }),
    build({ ...options, entryPoints: [source('bootstrap.ts')], format: 'esm', platform: 'node' }),
  ]);

  return {
    // Keep dependencies inside the expression passed to the native browser API.
    editor: `(function () {\n${engine.outputFiles[0].text}\nreturn blockwork_module.blockwork;\n})()`,
    invoker: invoker.outputFiles[0].text,
    bootstrap: bootstrap.outputFiles[0].text,
  };
}
