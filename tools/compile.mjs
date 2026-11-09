import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { bundles } from './bundle.mjs';

// The working copy is always a development build, for tests, the CLI
// development browser, and local installs.
const { editor, invoker } = await bundles({ debug: true });

await mkdir('skills/blockwork/scripts', { recursive: true });
await writeFile('skills/blockwork/scripts/editor.js', editor);
await writeFile('skills/blockwork/scripts/invoke.mjs', invoker);
await copyFile('src/bootstrap.mjs', 'skills/blockwork/scripts/bootstrap.mjs');
